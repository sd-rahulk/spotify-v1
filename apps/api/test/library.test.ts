import { afterAll,beforeAll,describe,expect,test } from 'vitest';
import { createHash,randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AddressInfo } from 'node:net';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createRequire } from 'node:module';
import { buildApp } from '../src/build-app.js';
import { readConfig } from '../src/config.js';
const require=createRequire(import.meta.url);
const S3rver=require('s3rver');
const ownerPassword='owner-test-password-strong';
const origin='http://localhost:3000';
let app:Awaited<ReturnType<typeof buildApp>>;
let mongo:MongoMemoryReplSet;
let s3:InstanceType<typeof S3rver>;
let directory:string;
let cookie:string;
let endpoint:string;

function wave(tone:number) {
  const count=8_000;
  const data=Buffer.alloc(44+count*2);
  data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);
  data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(count,24);data.writeUInt32LE(count*2,28);
  data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(count*2,40);
  for(let i=0;i<count;i++)data.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*tone/count)*1200),44+i*2);
  return data;
}
const file=(data:Buffer,filename='தமிழ்.wav')=>({filename,size:data.length,hash:createHash('sha256').update(data).digest('hex')});
const headers=()=>({origin,cookie});
beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'resonant-s3-'));
  s3=new S3rver({port:0,address:'127.0.0.1',silent:true,directory,configureBuckets:[{name:'music'}]});
  const address=await s3.run() as AddressInfo;
  endpoint='http://127.0.0.1:'+address.port;
  mongo=await MongoMemoryReplSet.create({replSet:{count:1},binary:{version:'8.0.12'}});
  app=await buildApp(readConfig({NODE_ENV:'test',MONGO_URI:mongo.getUri(),OWNER_PASSWORD:ownerPassword,
    APP_SECRET:'a-long-test-only-secret-32-bytes-or-more',R2_ENDPOINT:'http://127.0.0.1:'+address.port,R2_BUCKET:'music',
    R2_ACCESS_KEY_ID:'S3RVER',R2_SECRET_ACCESS_KEY:'S3RVER',STORAGE_QUOTA:'100000'}));
  const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{password:ownerPassword}});
  expect(login.statusCode).toBe(200);
  cookie=login.headers['set-cookie']!.toString().split(';')[0];
},180000);
afterAll(async()=>{await app?.close();await mongo?.stop();await s3?.close();if(directory)await rm(directory,{recursive:true,force:true});},30000);

describe('private library',()=>{
  test('checks authorization, origin and input validation',async()=>{
    expect((await app.inject('/health')).statusCode).toBe(200);
    expect((await app.inject('/api/tracks')).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/playlists',headers:{cookie,origin:'https://untrusted.example'},payload:{name:'No'}})).statusCode).toBe(403);
    const result=await app.inject({method:'POST',url:'/api/uploads/initiate',headers:headers(),payload:{files:[{...file(wave(200)),filename:'../track.wav'}]}});
    expect(result.statusCode).toBe(400);
  });
  test('uploads to private S3, verifies bytes and tags, streams ranges, syncs and deletes',async()=>{
    const data=wave(261);
    const input=file(data);
    const initiate=await app.inject({method:'POST',url:'/api/uploads/initiate',headers:headers(),payload:{files:[input]}});
    expect(initiate.statusCode,initiate.body).toBe(200);
    const plan=initiate.json().plans[0];
    const upload=await fetch(plan.parts[0].url,{method:'PUT',headers:{'Content-Type':'audio/wav'},body:new Uint8Array(data)});
    expect(upload.status,await upload.text()).toBe(200);
    const complete=()=>app.inject({method:'POST',url:'/api/uploads/'+plan.id+'/complete',headers:headers(),payload:{parts:[]}});
    const result=await complete();
    expect(result.statusCode,result.body).toBe(200);
    expect(result.json()).toMatchObject({title:'தமிழ்',duration:1,hash:input.hash});
    expect((await complete()).json().id).toBe(plan.id);
    const {url}= (await app.inject({url:'/api/tracks/'+plan.id+'/stream-url',headers:headers()})).json();
    const range=await fetch(url,{headers:{Range:'bytes=0-43'}});
    expect(range.status).toBe(206);
    expect(Buffer.from(await range.arrayBuffer()).equals(data.subarray(0,44))).toBe(true);
    const duplicate=await app.inject({method:'POST',url:'/api/uploads/initiate',headers:headers(),payload:{files:[input]}});
    expect(duplicate.json().plans[0]).toMatchObject({id:plan.id,duplicate:true});
    const changed=await app.inject({method:'PATCH',url:'/api/tracks/'+plan.id,headers:headers(),payload:{title:'Night Signals'}});
    expect(changed.json().title).toBe('Night Signals');
    const playlist=(await app.inject({method:'POST',url:'/api/playlists',headers:headers(),payload:{name:'Evening',trackIds:[plan.id]}})).json();
    const code=(await app.inject({method:'POST',url:'/api/auth/pairing-code',headers:headers()})).json().code;
    const pair=()=>app.inject({method:'POST',url:'/api/auth/pair',payload:{name:'Emulator',code}});
    const device=(await pair()).json();
    const mobile={authorization:'Bearer '+device.token};
    expect((await pair()).statusCode).toBe(401);
    expect((await app.inject({url:'/api/usage',headers:mobile})).statusCode).toBe(403);
    const operations=[{operationId:randomUUID(),kind:'like',id:plan.id,liked:true},{operationId:randomUUID(),kind:'play',id:plan.id,at:new Date().toISOString()}];
    for(let i=0;i<2;i++)expect((await app.inject({method:'POST',url:'/api/sync/changes',headers:mobile,payload:{operations}})).statusCode).toBe(200);
    const revisions=(await app.inject({url:'/api/sync',headers:mobile})).json();
    expect(revisions.items.at(-1).value).toMatchObject({liked:true,playCount:1});
    expect(revisions.items.some((v:{id:string})=>v.id===playlist.id)).toBe(true);
    expect((await app.inject({url:'/api/search?q=Night',headers:mobile})).json().tracks.items[0].id).toBe(plan.id);
    await app.inject({method:'DELETE',url:'/api/tracks/'+plan.id,headers:headers()});
    const deletes=(await app.inject({url:'/api/sync?after='+revisions.cursor,headers:mobile})).json();
    expect(deletes.items.at(-1)).toMatchObject({id:plan.id,value:null});
    expect((await app.inject({url:'/api/playlists/'+playlist.id,headers:headers()})).json().trackIds).toEqual([]);
    await app.inject({method:'POST',url:'/api/maintenance/cleanup',headers:headers()});
    expect((await fetch(url)).status).toBe(404);
    await app.inject({method:'DELETE',url:'/api/auth/devices/'+device.id,headers:headers()});
    expect((await app.inject({url:'/api/sync',headers:mobile})).statusCode).toBe(401);
  },30000);
  test('rejects parallel reservations that would exceed quota',async()=>{
    const prepare=(a:number)=>app.inject({method:'POST',url:'/api/uploads/initiate',headers:headers(),
      payload:{files:[file(wave(a)),file(wave(a+1))]}});
    const responses=await Promise.all([prepare(400),prepare(500)]);
    expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409]);
    const id=responses.find(r=>r.statusCode===200)!.json().plans[0].id;
    expect((await app.inject({method:'POST',url:'/api/uploads/'+id+'/cancel',headers:headers()})).statusCode).toBe(204);
    expect((await app.inject({url:'/api/uploads/'+id+'/status',headers:headers()})).json().state).toBe('cancelled');
  });
});

test('multipart verification and manifest recovery use the original stored bytes',async()=>{
  const env={NODE_ENV:'test',MONGO_URI:mongo.getUri(),OWNER_PASSWORD:ownerPassword,APP_SECRET:'a-long-test-only-secret-32-bytes-or-more',
    R2_ENDPOINT:endpoint,R2_BUCKET:'music',R2_ACCESS_KEY_ID:'S3RVER',R2_SECRET_ACCESS_KEY:'S3RVER',STORAGE_QUOTA:'40000000'};
  const uploadApp=await buildApp(readConfig({...env,MONGO_DB:'multipart'}));
  const recovery=await buildApp(readConfig({...env,MONGO_DB:'recovery'}));
  try {
    const uploadLogin=await uploadApp.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{password:ownerPassword}});
    const owner={origin,cookie:uploadLogin.headers['set-cookie']!.toString().split(';')[0]};
    const sample=wave(293);
    const payload=Buffer.alloc(9*1024*1024+44);
    sample.copy(payload,0,0,44);
    payload.writeUInt32LE(payload.length-8,4);
    payload.writeUInt32LE(payload.length-44,40);
    sample.copy(payload,44,44);
    const init=await uploadApp.inject({method:'POST',url:'/api/uploads/initiate',headers:owner,payload:{files:[file(payload,'Long test.wav')]}});
    expect(init.statusCode,init.body).toBe(200);
    const plan=init.json().plans[0];
    expect(plan.parts).toHaveLength(2);
    const parts=[];
    for(const part of plan.parts) {
      const offset=(part.number-1)*plan.partSize;
      const response=await fetch(part.url,{method:'PUT',body:new Uint8Array(payload.subarray(offset,offset+plan.partSize))});
      expect(response.status,await response.text()).toBe(200);
      parts.push({number:part.number,etag:response.headers.get('etag')});
    }
    const result=await uploadApp.inject({method:'POST',url:'/api/uploads/'+plan.id+'/complete',headers:owner,payload:{parts}});
    expect(result.statusCode,result.body).toBe(200);
    const backup=(await uploadApp.inject({url:'/api/backup',headers:owner})).json();
    const login=await recovery.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{password:ownerPassword}});
    const restored=await recovery.inject({method:'POST',url:'/api/backup/restore',
      headers:{origin,cookie:login.headers['set-cookie']!.toString().split(';')[0]},payload:backup});
    expect(restored.statusCode,restored.body).toBe(200);
    expect(restored.json()).toEqual({tracks:1,playlists:0});
  } finally {await uploadApp.close();await recovery.close();}
},60000);