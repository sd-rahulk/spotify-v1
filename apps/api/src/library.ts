import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession, Filter } from 'mongodb';
import { z } from 'zod';
import { id, playlistPatch, syncWrites, trackPatch } from '../../../packages/validation/src/index.js';
import type { Group, Playlist } from '@resonant/types';
import { HttpError, publicTrack, type Database, type StoredTrack } from './db.js';
import type { Storage } from './storage.js';
import type { Config } from './config.js';

const trackId = (params:unknown) => z.object({id}).parse(params).id;
const notFound = () => new HttpError(404,'NOT_FOUND','Library item not found');
const query = z.object({q:z.string().max(180).default(''),cursor:z.string().max(1500).optional(),
  limit:z.coerce.number().int().min(1).max(200).default(60),sort:z.enum(['recent','title','size','played']).default('recent'),
  format:z.string().max(40).optional(),liked:z.enum(['true','false']).optional()});
const escape = (s:string) => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const codecGroup = (track:StoredTrack) => track.mime.replace('audio/','');
const keyOf = (name:string, artist='') => createHash('sha256').update(JSON.stringify([name,artist])).digest('hex').slice(0,32);

export function library(app:FastifyInstance, db:Database, storage:Storage, config:Config) {
  async function getTrack(input:unknown) {
    const track = await db.tracks.findOne({_id:trackId(input)});
    if (!track) throw notFound();
    return track;
  }
  async function list(input:unknown) {
    const {q,limit,cursor,sort,format,liked}=query.parse(input);
    const key = {recent:'createdAt', title:'title',size:'size',played:'playCount'}[sort] as 'title'|'size'|'createdAt'|'playCount';
    const direction=sort==='title'?1:-1;
    const filter:Filter<StoredTrack & {_id:string}>={};
    if (q.trim()) { const re=new RegExp(escape(q.trim()),'iu'); filter.$or=['title','artist','album','albumArtist','genre','filename'].map(field=>({[field]:re})); }
    if (format) filter.mime='audio/'+format;
    if (liked) filter.liked=liked==='true';
    if (cursor) {
      let pair: unknown;
      try { pair=JSON.parse(Buffer.from(cursor,'base64url').toString()); }
      catch { throw new HttpError(400,'CURSOR','Invalid page cursor'); }
      const [value,id]=z.tuple([key==='size'||key==='playCount'?z.number():z.string(),z.uuid()]).parse(pair);
      const boundary=direction===1?'$gt':'$lt';
      filter.$and=[{$or:[{[key]:{[boundary]:value}},{[key]:value,_id:{[boundary]:id}}]}];
    }
    const results=await db.tracks.find(filter).sort({[key]:direction,_id:direction}).limit(limit+1).toArray();
    const items=results.slice(0,limit), last=items.at(-1);
    return {items:items.map(publicTrack),next:results.length>limit && last?Buffer.from(JSON.stringify([last[key],last.id])).toString('base64url'):null};
  }
  app.get('/api/tracks',req=>list(req.query));
  app.get('/api/library',req=>list(req.query));
  app.get('/api/tracks/:id',async req=>publicTrack(await getTrack(req.params)));
  app.patch('/api/tracks/:id',async req=>{
    const id=trackId(req.params), patch=trackPatch.parse(req.body);
    return db.tx(async session=>{
      const track=await db.tracks.findOneAndUpdate({_id:id},{$set:{...patch,updatedAt:new Date().toISOString()}},{session,returnDocument:'after'});
      if (!track) throw notFound();
      const value=publicTrack(track);
      await db.publish({kind:'track',id,value},session);
      return value;
    });
  });
  app.delete('/api/tracks/:id',async (req,reply)=>{
    const id=trackId(req.params);
    await db.tx(async session=>{
      const track=await db.tracks.findOneAndDelete({_id:id},{session});
      if (!track) return;
      const job=await db.jobs.findOne({_id:id},{session});
      await db.garbage.insertOne({_id:id,keys:[track.key,...(track.artworkKey?[track.artworkKey]:[])],bytes:track.size+(track.artworkBytes??0)},{session});
      for (const item of await db.playlists.find({trackIds:id},{session}).toArray())
        await editPlaylist(item.id,{trackIds:item.trackIds.filter(value=>value!==id)},session);
      await db.publish({kind:'track',id,value:null},session);
    });
    return reply.code(204).send();
  });
  for (const mode of ['stream','download'] as const) app.get('/api/tracks/:id/'+mode+'-url',async(req,reply)=>{
    const track=await getTrack(req.params);
    reply.header('Cache-Control','no-store');
    return {url:await storage.url(track.key,mode==='download'?track.filename:undefined),
      artwork:track.artworkKey?await storage.url(track.artworkKey):undefined,expiresIn:14400};
  });
  app.get('/api/tracks/:id/artwork',async(req,reply)=>{
    const track=await getTrack(req.params);
    if (!track.artworkKey) throw notFound();
    return reply.header('Cache-Control','private, max-age=3600').redirect(await storage.url(track.artworkKey));
  });
  async function groups(mode:'album'|'artist') {
    const values=new Map<string, Group>();
    const results=db.tracks.find({}, {projection:{album:1,albumArtist:1,artist:1,duration:1,artwork:1}}).sort({createdAt:-1});
    for await (const track of results) {
      const name=mode==='album'?track.album:track.artist;
      const artist=mode==='album'?(track.albumArtist || track.artist):'';
      const id=keyOf(name,artist);
      const row=values.get(id)??{id,name,artist,count:0,duration:0,artwork:track.artwork};
      row.count++; row.duration+=track.duration; row.artwork??=track.artwork;
      values.set(id,row);
    }
    return [...values.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  }
  for (const mode of ['album','artist'] as const) {
    app.get('/api/'+mode+'s',async()=>({items:await groups(mode)}));
    const getGroup=async(input:unknown)=>{
      const {id}=z.object({id:z.string().regex(/^[a-z0-9]{32}$/)}).parse(input);
      const group=(await groups(mode)).find(g=>g.id===id);
      if (!group) throw notFound();
      const filter=mode==='artist'?{artist:group.name}:{album:group.name,$or:[{albumArtist:group.artist},{albumArtist:'',artist:group.artist}]};
      return {group,filter};
    };
    app.get('/api/'+mode+'s/:id',async req=>{
      const {group,filter}=await getGroup(req.params);
      const items=await db.tracks.find(filter).sort({discNumber:1,trackNumber:1,title:1}).limit(1000).toArray();
      return {...group,tracks:items.map(publicTrack)};
    });
    app.patch('/api/'+mode+'s/:id',async req=>{
      const {group,filter}=await getGroup(req.params);
      const {name,albumArtist}=z.object({name:z.string().trim().min(1).max(240),albumArtist:z.string().trim().max(240).optional()}).parse(req.body);
      const update=mode==='artist'?{artist:name}:{album:name,...(albumArtist===undefined?{}:{albumArtist})};
      await db.tx(async session=>{
        const members=await db.tracks.find(filter,{session}).limit(1001).toArray();
        if(!members.length)throw notFound();
        if(members.length>1000)throw new HttpError(409,'GROUP_SIZE','Edit this collection in smaller sets of tracks');
        const updatedAt=new Date().toISOString();
        await db.tracks.updateMany({_id:{$in:members.map(row=>row.id)}},{$set:{...update,updatedAt}},{session});
        for(const row of members) await db.publish({kind:'track',id:row.id,value:{...publicTrack(row),...update,updatedAt}},session);
      });
      return {id:keyOf(name,mode==='album'?albumArtist||group.artist:'')};
    });
  }
  const cleanPlaylist=({_id,...playlist}:Playlist & {_id:string})=>playlist;
  app.get('/api/playlists',async()=>({items:(await db.playlists.find().sort({name:1,_id:1}).toArray()).map(cleanPlaylist)}));
  app.get('/api/playlists/:id',async req=>{
    const playlist=await db.playlists.findOne({_id:trackId(req.params)});
    if (!playlist) throw notFound();
    const tracks=new Map((await db.tracks.find({_id:{$in:playlist.trackIds}}).toArray()).map(t=>[t.id,publicTrack(t)]));
    return {...cleanPlaylist(playlist),tracks:playlist.trackIds.flatMap(id=>tracks.has(id)?[tracks.get(id)!]:[])};
  });
  async function editPlaylist(id:string,patch:z.infer<typeof playlistPatch>|null,session:ClientSession,create=false) {
    if (!patch) {
      if ((await db.playlists.deleteOne({_id:id},{session})).deletedCount)
        await db.publish({kind:'playlist',id,value:null},session);
      return null;
    }
    if (patch.trackIds) {
      const unique=[...new Set(patch.trackIds)];
      const existing=new Set((await db.tracks.find({_id:{$in:unique}},{session,projection:{_id:1}}).toArray()).map(row=>row._id));
      patch={...patch,trackIds:unique.filter(id=>existing.has(id))};
    }
    const prior=await db.playlists.findOne({_id:id},{session});
    const {coverTrackId,...fields}=patch;
    const picked=coverTrackId===undefined?prior?.coverTrackId:coverTrackId;
    const items=fields.trackIds??prior?.trackIds??[];
    const cover=picked&&items.includes(picked)?await db.tracks.findOne({_id:picked},{session,projection:{artwork:1}}):null;
    const coverFields=cover?.artwork?{$set:{coverTrackId:picked!,artwork:cover.artwork}}:{$unset:{coverTrackId:1 as const,artwork:1 as const}};
    const defaults={...(!patch.name?{name:'New playlist'}:{}),...(!patch.trackIds?{trackIds:[]}:{}),id};
    const value=await db.playlists.findOneAndUpdate({_id:id},{$set:{...fields,...coverFields.$set,updatedAt:new Date().toISOString()},$unset:coverFields.$unset,$setOnInsert:defaults},
      {session,upsert:create,returnDocument:'after'});
    if (!value) throw notFound();
    const result=cleanPlaylist(value);
    await db.publish({kind:'playlist',id,value:result},session);
    return result;
  }
  app.post('/api/playlists',async(req,reply)=>{
    const patch=playlistPatch.required({name:true}).parse(req.body);
    return reply.code(201).send(await db.tx(s=>editPlaylist(randomUUID(),patch,s,true)));
  });
  app.patch('/api/playlists/:id',req=>db.tx(s=>editPlaylist(trackId(req.params),playlistPatch.parse(req.body),s)));
  app.delete('/api/playlists/:id',async(req,reply)=>{
    await db.tx(s=>editPlaylist(trackId(req.params),null,s));
    return reply.code(204).send();
  });
  async function membership(playlistId:string,s:ClientSession,adjust:(ids:string[])=>string[]) {
    const row=await db.playlists.findOne({_id:playlistId},{session:s});
    if (!row) throw notFound();
    return editPlaylist(playlistId,playlistPatch.parse({trackIds:adjust(row.trackIds)}),s);
  }
  app.post('/api/playlists/:id/tracks',req=>db.tx(s=>membership(trackId(req.params),s,
    ids=>[...new Set([...ids,...z.object({trackIds:z.array(id).min(1).max(3000)}).parse(req.body).trackIds])])));
  app.delete('/api/playlists/:id/tracks/:trackId',req=>db.tx(s=>{
    const args=z.object({id,trackId:id}).parse(req.params);
    return membership(args.id,s,ids=>ids.filter(value=>value!==args.trackId));
  }));
  app.patch('/api/playlists/:id/order',req=>db.tx(s=>membership(trackId(req.params),s,ids=>{
    const order=z.object({trackIds:z.array(id).max(3000)}).parse(req.body).trackIds;
    if (order.length!==ids.length || new Set(order).size!==ids.length || order.some(value=>!ids.includes(value)))
      throw new HttpError(409,'PLAYLIST_CHANGED','Refresh the playlist before reordering');
    return order;
  })));
  app.get('/api/search',async req=>{
    const input=query.parse(req.query);
    const match = new RegExp(escape(input.q),'iu');
    const [tracks,albums,artists,playlists]=await Promise.all([list(input),groups('album'),groups('artist'),db.playlists.find({name:match}).limit(50).toArray()]);
    return {tracks,albums:albums.filter(g=>match.test(g.name)).slice(0,50),artists:artists.filter(g=>match.test(g.name)).slice(0,50),playlists:playlists.map(cleanPlaylist)};
  });
  async function stats() {
    const [state,tracks,albums,artists,playlists]=await Promise.all([db.state.findOne({_id:'library'}),
      db.tracks.find({},{projection:{mime:1}}).toArray(),groups('album'),groups('artist'),db.playlists.countDocuments()]);
    const formats:Record<string,number>={};
    for (const row of tracks) { const key=codecGroup(row); formats[key]=(formats[key]??0)+1; }
    return {used:state!.used,reserved:state!.reserved,quota:config.STORAGE_QUOTA,tracks:tracks.length,albums:albums.length,artists:artists.length,playlists,formats};
  }
  app.get('/api/usage',stats);
  app.get('/api/library/stats',stats);
  for (const path of ['/api/sync','/api/library/changes']) app.get(path,async req=>{
    const {after,limit}=z.object({after:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(req.query);
    const items=await db.changes.find({revision:{$gt:after}},{projection:{_id:0}}).sort({revision:1}).limit(limit+1).toArray();
    const page=items.slice(0,limit);
    return {items:page,cursor:page.at(-1)?.revision??after,more:items.length>limit};
  });
  app.post('/api/sync/changes',async req=>{
    const {operations}=syncWrites.parse(req.body);
    for (const operation of operations) await db.tx(async session=>{
      if (await db.operations.findOne({_id:operation.operationId},{session})) return;
      if (operation.kind==='playlist') {
        await editPlaylist(operation.id,operation.patch,session,Boolean(operation.patch?.name));
      } else {
        const update=operation.kind==='like'?{$set:{liked:operation.liked}}:
          {$inc:{playCount:1},$max:{lastPlayed:new Date(Math.min(Date.now(),Date.parse(operation.at))).toISOString()}};
        const result=await db.tracks.findOneAndUpdate({_id:operation.id},update,{session,returnDocument:'after'});
        if (result) {
          if (operation.kind==='play') await db.history.insertOne({_id:operation.operationId,trackId:operation.id,at:new Date(Math.min(Date.now(),Date.parse(operation.at)))},{session});
          await db.publish({kind:'track',id:operation.id,value:publicTrack(result)},session);
        }
      }
      await db.operations.insertOne({_id:operation.operationId,expires:new Date(Date.now()+366*86400000)},{session});
    });
    return {applied:operations.map(o=>o.operationId)};
  });

}
