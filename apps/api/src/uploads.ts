import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { uploadBatch } from '../../../packages/validation/src/index.js';
import { extension, formats } from '../../../packages/shared/src/index.js';
import { HttpError, publicTrack, type Database, type Job, type StoredTrack } from './db.js';
import { artKey, audioKey, type Storage } from './storage.js';
import type { Config } from './config.js';
const HOUR = 3600000;
const params = z.object({id:z.uuid()});
export function uploads(app:FastifyInstance, db:Database, storage:Storage, config:Config, serverless=false) {
  async function close(job:Job,state:'cancelled'|'failed',error?:string) {
    await db.jobs.updateOne({_id:job._id,state:job.state,owner:job.owner},{$set:{state,...(error?{error}:{})}});
  }
  app.post('/api/uploads/initiate',async req=>{
    const {files} = uploadBatch.parse(req.body);
    for (const file of files) {
      if (!Object.hasOwn(formats,extension(file.filename))) throw new HttpError(415,'FORMAT','Unsupported audio extension');
      if (file.size>config.MAX_FILE_BYTES) throw new HttpError(413,'FILE_SIZE','File exceeds the configured file-size limit');
    }
    const allocated = await db.tx(async session=>{
      const existing = await db.tracks.find({hash:{$in:files.map(f=>f.hash)}},{session}).toArray();
      const seen = new Map(existing.map(t=>[t.hash,t.id]));
      const result = files.map<Job | {id:string;duplicate:true}>(file=>{
        const duplicate = seen.get(file.hash);
        if (duplicate) return {id:duplicate,duplicate:true} as const;
        const id = randomUUID();
        seen.set(file.hash,id);
        return {_id:id,...file,mime:formats[extension(file.filename)],state:'reserved',
          expires:new Date(Date.now()+HOUR+60000),created:new Date()} satisfies Job;
      });
      const jobs = result.filter((item):item is Job=>'_id' in item);
      const sum = jobs.reduce((acc,job)=>acc+2*job.size,0);
      if (sum) {
        const reservation = await db.state.updateOne({_id:'library',$expr:{$lte:[{$add:['$used','$reserved',sum]},config.STORAGE_QUOTA]}},
          {$inc:{reserved:sum}},{session});
        if (!reservation.modifiedCount) throw new HttpError(409,'QUOTA','This upload batch exceeds the remaining application quota');
        await db.jobs.insertMany(jobs,{session});
      }
      return result;
    });
    try {
      const plans = [];
      for (const job of allocated) {
        if (!('_id' in job)) { plans.push({...job,parts:[],partSize:0}); continue; }
        job.multipart = await storage.begin(job);
        if (job.multipart) await db.jobs.updateOne({_id:job._id},{$set:{multipart:job.multipart}});
        plans.push(await storage.plan(job));
      }
      return {plans};
    } catch (error) {
      for (const job of allocated) if ('_id' in job) await close(job,'failed','Unable to prepare direct upload');
      throw error;
    }
  });
  app.get('/api/uploads/:id/status',async req=>{
    const {_id,filename,state,error,expires} = await jobFor(req.params);
    return {id:_id,filename,state,error,expires};
  });
  const jobFor = async (input:unknown) => {
    const {id} = params.parse(input);
    const job = await db.jobs.findOne({_id:id});
    if (!job) throw new HttpError(404,'UPLOAD','Upload not found');
    return job;
  };
  app.post('/api/uploads/:id/cancel',async (req,reply)=>{
    const job = await jobFor(req.params);
    if (job.state==='verifying' || job.state==='complete') throw new HttpError(409,'UPLOAD_BUSY','Upload is already being verified or committed');
    if (job.state==='reserved') {
      const result=await db.jobs.updateOne({_id:job._id,state:'reserved'},{$set:{state:'cancelled'}});
      if (!result.modifiedCount) throw new HttpError(409,'UPLOAD_BUSY','Upload is already being verified');
      await storage.abort(job);
    }
    return reply.code(204).send();
  });
  app.post('/api/uploads/:id/complete',async req=>{
    const initial = await jobFor(req.params);
    if (initial.state==='complete') {
      const track = await db.tracks.findOne({_id:initial._id});
      if (!track) throw new HttpError(410,'TRACK_DELETED','This upload was committed and the track was subsequently deleted');
      return publicTrack(track);
    }
    const {parts} = z.object({parts:z.array(z.object({number:z.number().int().positive(),etag:z.string().min(1).max(120)})).max(200)}).parse(req.body);
    const owner = randomUUID();
    const job = await db.jobs.findOneAndUpdate({_id:initial._id,state:'reserved',expires:{$gt:new Date()}},
      {$set:{state:'verifying',owner}},{returnDocument:'after'});
    if (!job) throw new HttpError(409,'UPLOAD_STATE','Upload is unavailable, expired, or already being verified');
    try {
      const {metadata,picture} = await storage.verify(job,parts);
      let artworkBytes = picture?.data.length ?? 0;
      if (picture) {
        const available=await db.tx(async session=>{
          const updated=await db.state.updateOne({_id:'library',$expr:{$lte:[{$add:['$used','$reserved',artworkBytes]},config.STORAGE_QUOTA]}},
            {$inc:{reserved:artworkBytes}},{session});
          if (!updated.modifiedCount) return false;
          await db.jobs.updateOne({_id:job._id,owner},{$set:{artworkBytes}},{session});
          return true;
        });
        if (available) await storage.putArtwork(job._id,picture);
        else artworkBytes=0;
      }
      const {common,format} = metadata;
      const clean = (value:string|undefined, fallback='') => value?.trim().slice(0,240) || fallback;
      const now=new Date().toISOString();
      const result:StoredTrack = {id:job._id,key:audioKey(job._id),filename:job.filename,hash:job.hash,size:job.size,mime:job.mime,
        title:clean(common.title,job.filename.replace(/\.[^.]+$/,'')),artist:clean(common.artist,'Unknown artist'),
        album:clean(common.album,'Unknown album'),albumArtist:clean(common.albumartist),genre:clean(common.genre?.join(', ')),
        duration:format.duration ?? 0,bitrate:Math.round(format.bitrate ?? 0),codec:clean(format.codec),trackNumber:common.track.no ?? 0,
        discNumber:common.disk.no ?? 0,lyrics:(common.lyrics?.flatMap(l=>l.syncText?.length ? l.syncText.map(v=>{
          const seconds=(v.timestamp ?? 0)/1000;
          return '['+String(Math.floor(seconds/60)).padStart(2,'0')+':'+(seconds%60).toFixed(2).padStart(5,'0')+']'+v.text;
        }) : [l.text ?? '']).join('\n') ?? '').slice(0,64000),liked:false,playCount:0,createdAt:now,updatedAt:now,
        ...(artworkBytes?{artwork:'/api/tracks/'+job._id+'/artwork',artworkKey:artKey(job._id),artworkBytes}:{}),
      };
      await db.tx(async session=>{
        const claim=await db.jobs.updateOne({_id:job._id,state:'verifying',owner},{$set:{state:'complete'}},{session});
        if (!claim.modifiedCount) throw new HttpError(409,'UPLOAD_STATE','Upload verification expired');
        await db.tracks.insertOne({_id:result.id,...result},{session});
        await db.state.updateOne({_id:'library'},{$inc:{used:job.size+artworkBytes,reserved:-job.size-artworkBytes}},{session});
        await db.publish({kind:'track',id:result.id,value:publicTrack(result)},session);
      });
      return publicTrack(result);
    } catch (error) {
      await close(job,'failed',error instanceof HttpError ? error.message : 'Verification or commit failed');
      if ((error as {code?:number}).code===11000) throw new HttpError(409,'DUPLICATE','This audio already exists in the library');
      throw error;
    }
  });
  let cleaning=false;
  async function cleanup() {
    if (cleaning) return {running:true};
    cleaning=true;
    try {
      const now=new Date();
      await db.jobs.updateMany({state:'verifying',expires:{$lt:new Date(Date.now()-2*HOUR)}},{$set:{state:'failed',error:'Verification expired'}});
      await db.jobs.updateMany({state:'reserved',expires:{$lt:now}},{$set:{state:'cancelled'}});
      for (const job of await db.jobs.find({state:{$in:['complete','cancelled','failed']},cleaned:{$ne:true},expires:{$lt:now}}).limit(50).toArray()) {
        await storage.abort(job);
        if (job.state!=='complete') { await storage.remove(audioKey(job._id)); await storage.remove(artKey(job._id)); }
        await db.tx(async session=>{
          const updated=await db.jobs.updateOne({_id:job._id,cleaned:{$ne:true}},{$set:{cleaned:true}},{session});
          if (updated.modifiedCount) await db.state.updateOne({_id:'library'},{$inc:{reserved:job.state==='complete'?-job.size:-2*job.size-(job.artworkBytes??0)}},{session});
        });
      }
      for (const item of await db.garbage.find({$or:[{after:{$exists:false}},{after:{$lt:now}}]}).limit(50).toArray()) {
        for (const key of item.keys) await storage.remove(key);
        await db.tx(async session=>{
          if ((await db.garbage.deleteOne({_id:item._id},{session})).deletedCount)
            await db.state.updateOne({_id:'library'},{$inc:{used:-item.bytes}},{session});
        });
      }
      return {ok:true};
    } finally { cleaning=false; }
  }
  app.get('/api/uploads/jobs',async()=>db.jobs.find({state:{$in:['failed','reserved','verifying']}},{projection:{owner:0,multipart:0,hash:0}}).sort({created:-1}).limit(50).toArray());
  app.post('/api/maintenance/cleanup',cleanup);
  app.get('/api/cron/cleanup',async req=>{
    const secret=process.env.CRON_SECRET;
    const digest=(value:string)=>createHash('sha256').update(value).digest();
    if (!secret || secret.length<16 ||
        !timingSafeEqual(digest(req.headers.authorization ?? ''),digest('Bearer '+secret)))
      throw new HttpError(401,'CRON_AUTH','Unauthorized');
    return cleanup();
  });
  if (!serverless) {
    const timer=setInterval(()=>void cleanup().catch(()=>app.log.warn('Object cleanup will retry')),60000);
    timer.unref();
    app.addHook('onClose',async()=>clearInterval(timer));
  }
}
