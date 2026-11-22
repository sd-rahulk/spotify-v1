import Fastify,{LogController} from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { auth } from './auth.js';
import { database, HttpError } from './db.js';
import { objectStorage } from './storage.js';
import { uploads } from './uploads.js';
import { library } from './library.js';
import { backup } from './backup.js';
import { artwork } from './artwork.js';
import type { Config } from './config.js';

export async function buildApp(config:Config,{serverless=false}={}) {
  const app=Fastify({bodyLimit:2*1024*1024,requestTimeout:30000,connectionTimeout:30000,
    logController:new LogController({disableRequestLogging:true}),logger:config.NODE_ENV!=='test'});
  await app.register(cookie);
  await app.register(cors,{origin:new URL(config.WEB_ORIGIN).origin,credentials:true,methods:['GET','HEAD','POST','PATCH','PUT','DELETE','OPTIONS']});
  await app.register(helmet,{crossOriginResourcePolicy:{policy:'same-site'}});
  await app.register(rateLimit,{max:600,timeWindow:'1 minute'});
  app.setErrorHandler((error,req,reply)=>{
    const status=error instanceof ZodError?400:error instanceof HttpError?error.statusCode:
      'statusCode' in (error as object) ? Number((error as {statusCode:number}).statusCode) : 500;
    if (status>=500) req.log.error({requestId:req.id,category:error instanceof Error?error.name:'Unknown'},'Request failed');
    reply.code(status).send({error:{code:error instanceof HttpError?error.code:status===400?'VALIDATION':status===429?'RATE_LIMIT':'REQUEST_FAILED',
      message:error instanceof HttpError?error.message: error instanceof ZodError
        ? error.issues.map(i=>i.path.join('.')+' '+i.message).join('; ')
        : status===429?'Too many requests. Wait and try again.':status>=500?'The server could not complete the request':'Invalid request'}});
  });
  const db=await database(config);
  const storage=objectStorage(config);
  app.addHook('onClose',async()=>{storage.destroy(); await db.client.close();});
  await auth(app,db,config);
  app.get('/health',async()=>{await db.db.command({ping:1}); return {status:'ok'};});
  library(app,db,storage,config);
  uploads(app,db,storage,config,serverless);
  backup(app,db,storage,config);
  artwork(app,db,storage,config);
  return app;
}
