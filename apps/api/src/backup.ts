import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { trackPatch,playlistPatch } from '@resonant/validation';
import { formats } from '@resonant/shared';
import { HttpError, publicTrack, type Database, type StoredTrack } from './db.js';
import type { Config } from './config.js';
import type { Storage } from './storage.js';
const trackSchema=trackPatch.required().extend({
  id:z.uuid(),duration:z.number().nonnegative(),bitrate:z.number().int().nonnegative(),codec:z.string().max(240),
  filename:z.string().max(240).regex(/^[^\\/\u0000-\u001f]+$/),size:z.number().int().positive(),
  mime:z.enum([...new Set(Object.values(formats))] as [string,...string[]]),hash:z.string().regex(/^[a-f0-9]{64}$/),
  playCount:z.number().int().nonnegative(),lastPlayed:z.iso.datetime().optional(),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime(),
  artwork:z.string().optional(),artworkKey:z.string().regex(/^artwork\/[0-9a-f-]{36}$/).optional(),
});
const playlistSchema=playlistPatch.required({name:true,trackIds:true}).extend({id:z.uuid(),updatedAt:z.iso.datetime()});
const manifest=z.object({version:z.literal(2),tracks:z.array(trackSchema).max(20000),playlists:z.array(playlistSchema).max(4000)});
export function backup(app:FastifyInstance,db:Database,storage:Storage,config:Config) {
  app.get('/api/backup',async(_req,reply)=>{
    reply.header('Cache-Control','no-store');
    return {version:2,tracks:(await db.tracks.find().toArray()).map(t=>({...publicTrack(t),artworkKey:t.artworkKey})),
      playlists:await db.playlists.find({},{projection:{_id:0}}).toArray()};
  });
  app.post('/api/backup/check',async()=>{
    const missing:string[]=[], mismatched:string[]=[];
    for await (const track of db.tracks.find({})) {
      for (const key of [track.key,track.artworkKey]) if (key) {
        try {
          const head=await storage.head(key);
          if(key===track.key&&(head.ContentLength!==track.size||head.Metadata?.sha256!==track.hash)) mismatched.push(key);
        } catch (error) {
          if ((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404) throw error;
          missing.push(key);
        }
      }
    }
    return {missing,mismatched};
  });
  app.post('/api/backup/restore',{bodyLimit:16*1024*1024},async req=>{
    const input=manifest.parse(req.body);
    if(new Set(input.tracks.map(t=>t.id)).size!==input.tracks.length||new Set(input.tracks.map(t=>t.hash)).size!==input.tracks.length)
      throw new HttpError(400,'MANIFEST','Manifest includes duplicate tracks');
    const state=await db.state.findOne({_id:'library'});
    if(!state||state.used||state.reserved||await db.playlists.countDocuments())
      throw new HttpError(409,'RESTORE','Restore requires an empty database with no outstanding transfers');
    const tracks: (StoredTrack & {_id:string})[]=[];
    let consumed=0;
    for(const source of input.tracks) {
      const {artworkKey,artwork:_,...metadata}=source;
      const key='audio/'+source.id;
      try {
        const head=await storage.head(key);
        if(head.ContentLength!==source.size||head.Metadata?.sha256!==source.hash||head.ContentType!==source.mime)
          throw new HttpError(422,'MANIFEST','Audio metadata differs for '+source.filename);
        const artworkBytes=artworkKey?(await storage.head(artworkKey)).ContentLength??0:0;
        consumed+=source.size+artworkBytes;
        tracks.push({_id:source.id,...metadata,key,artworkKey,artworkBytes,
          ...(artworkKey?{artwork:'/api/tracks/'+source.id+'/artwork'}:{})});
      } catch(error) {
        if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404)
          throw new HttpError(422,'MANIFEST','Missing audio or artwork for '+source.filename);
        throw error;
      }
    }
    if(consumed>config.STORAGE_QUOTA)throw new HttpError(409,'QUOTA','Objects in the manifest exceed the configured quota');
    const existing=new Set(tracks.map(t=>t.id));
    const rows=input.playlists.map(({coverTrackId,...p})=>({...p,_id:p.id,trackIds:[...new Set(p.trackIds.filter(id=>existing.has(id)))],
      ...(coverTrackId&&existing.has(coverTrackId)?{coverTrackId,artwork:tracks.find(t=>t.id===coverTrackId)?.artwork}:{})}));
    await db.tx(async session=>{
      const claim=await db.state.updateOne({_id:'library',revision:state.revision,used:0,reserved:0},{$set:{used:consumed}},{session});
      if(!claim.matchedCount)throw new HttpError(409,'RESTORE','Library changed during manifest verification');
      if(tracks.length)await db.tracks.insertMany(tracks,{session});
      if(rows.length)await db.playlists.insertMany(rows,{session});
      for(const track of tracks)await db.publish({kind:'track',id:track.id,value:publicTrack(track)},session);
      for(const {_id,...row} of rows)await db.publish({kind:'playlist',id:row.id,value:row},session);
    });
    return {tracks:tracks.length,playlists:rows.length};
  });
}
