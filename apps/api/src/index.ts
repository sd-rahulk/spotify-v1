import Fastify from 'fastify';
import { ZodError } from 'zod';
import { buildApp } from './build-app';
import { readConfig } from './config';

async function main() {
  let config;
  try {
    config=readConfig(process.env);
  } catch (error) {
    if (process.env.VERCEL !== '1' || !(error instanceof ZodError)) throw error;
    const setup=Fastify();
    setup.setNotFoundHandler((_request,reply)=>reply.code(503).send({
      error:{code:'SETUP_REQUIRED',message:'Configure the API environment variables in Vercel and redeploy.'},
    }));
    await setup.listen({port:Number(process.env.PORT)||4100,host:'0.0.0.0'});
    return;
  }
  const app=await buildApp(config,{serverless:process.env.VERCEL==='1'});
  await app.listen({port:config.PORT,host:config.HOST});
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>void app.close());
}
main().catch(error=>{
  console.error('API startup failed:', error?.issues?.map((v:{ path:string[] })=>v.path.join('.')).join(', ') ?? error.name);
  process.exitCode=1;
});
