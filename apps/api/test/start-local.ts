import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createRequire } from 'node:module';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/build-app';
import { readConfig } from '../src/config';
const require=createRequire(import.meta.url);
const S3rver=require('s3rver');
async function main() {
  const directory=await mkdtemp(join(tmpdir(),'resonant-local-'));
  const mongo=await MongoMemoryReplSet.create({replSet:{count:1},binary:{version:'8.0.12'}});
  const s3=new S3rver({port:4569,address:'127.0.0.1',silent:true,directory,configureBuckets:[{name:'music',
    configs:[Buffer.from('<CORSConfiguration><CORSRule><AllowedOrigin>http://localhost:3000</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader></CORSRule></CORSConfiguration>')]}]});
  try {
    await s3.run();
    const config=readConfig({NODE_ENV:'test',HOST:'127.0.0.1',PUBLIC_API_URL:'http://localhost:4100',
      MONGO_URI:mongo.getUri(),OWNER_PASSWORD:'resonant-local-test-only',APP_SECRET:'resonant-local-test-secret-do-not-reuse',
      R2_ENDPOINT:'http://localhost:4569',R2_BUCKET:'music',R2_ACCESS_KEY_ID:'S3RVER',R2_SECRET_ACCESS_KEY:'S3RVER',
      STORAGE_QUOTA:'30000000'});
    const app=await buildApp(config);
    await app.listen({host:config.HOST,port:config.PORT});
    console.log('Local test API ready on http://localhost:4100');
    await new Promise<void>(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
    await app.close();
  } finally {await s3.close();await mongo.stop();await rm(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
