import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, publicTrack, type Database } from './db.js';
import type { Storage } from './storage.js';
import type { Config } from './config.js';

export function artwork(app:FastifyInstance,db:Database,storage:Storage,config:Config) {
  app.put('/api/tracks/:id/artwork',async req=>{
    const {id}=z.object({id:z.uuid()}).parse(req.params);
    const {data}=z.object({data:z.base64().max(1398104)}).parse(req.body);
    const picture=Buffer.from(data,'base64');
    const type=picture[0]===255&&picture[1]===216&&picture[2]===255?'image/jpeg':
      picture.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':
      picture.toString('ascii',0,4)==='RIFF'&&picture.toString('ascii',8,12)==='WEBP'?'image/webp':null;
    if(!type)throw new HttpError(415,'ARTWORK','Choose a JPEG, PNG or WebP image');
    if(!await db.tracks.findOne({_id:id}))throw new HttpError(404,'NOT_FOUND','Track not found');
    const artworkId=randomUUID(), artworkKey='artwork/'+artworkId;
    // Charge the replacement before writing it. The durable cleanup record covers an interrupted request.
    await db.tx(async session=>{
      const charge=await db.state.updateOne({_id:'library',$expr:{$lte:[{$add:['$used','$reserved',picture.length]},config.STORAGE_QUOTA]}},
        {$inc:{used:picture.length}},{session});
      if(!charge.modifiedCount)throw new HttpError(409,'QUOTA','There is insufficient space for this cover');
      await db.garbage.insertOne({_id:artworkId,keys:[artworkKey],bytes:picture.length,after:new Date(Date.now()+3600000)},{session});
    });
    await storage.putArtwork(artworkId,{data:picture,format:type});
    return db.tx(async session=>{
      const track=await db.tracks.findOne({_id:id},{session});
      if(!track)throw new HttpError(404,'NOT_FOUND','Track not found');
      const cleanup=await db.garbage.deleteOne({_id:artworkId},{session});
      if(!cleanup.deletedCount)throw new HttpError(409,'ARTWORK','Replacement expired. Try uploading it again.');
      if(track.artworkKey)await db.garbage.insertOne({_id:randomUUID(),keys:[track.artworkKey],bytes:track.artworkBytes??0},{session});
      const updated=await db.tracks.findOneAndUpdate({_id:id},{$set:{
        artwork:'/api/tracks/'+id+'/artwork?v='+artworkId,artworkKey,artworkBytes:picture.length,updatedAt:new Date().toISOString(),
      }},{session,returnDocument:'after'});
      const value=publicTrack(updated!);
      await db.publish({kind:'track',id,value},session);
      return value;
    });
  });
}
