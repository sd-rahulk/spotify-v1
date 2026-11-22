import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { HttpError, type Database } from './db.js';
const cookieName = 'resonant_owner';
const DAY = 86400000;
export async function auth(app:FastifyInstance, db:Database, config:Config) {
  const digest = (value:string) => createHmac('sha256',config.APP_SECRET).update(value).digest('hex');
  const token = () => randomBytes(32).toString('base64url');
  const owner = (request:FastifyRequest) => Boolean(request.cookies[cookieName]);
  app.addHook('onRequest',async req=>{
    const path = req.url.split('?')[0];
    if (req.method==='OPTIONS' || path==='/health' || (path==='/api/cron/cleanup' && req.method==='GET')) return;
    if (!['GET','HEAD'].includes(req.method) && req.headers.origin && req.headers.origin!==new URL(config.WEB_ORIGIN).origin)
      throw new HttpError(403,'ORIGIN','Request origin is forbidden');
    if (path==='/api/auth/login' || path==='/api/auth/pair') return;
    const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (bearer && !owner(req)) {
      const device = await db.devices.findOne({token:digest(bearer),expiry:{$gt:new Date()}});
      if (!device) throw new HttpError(401,'DEVICE_EXPIRED','Pair this device again');
      const mobileRead = /^\/api\/(sync|library|search|tracks|albums|artists|playlists)(\/|$)/.test(path);
      if ((['GET','HEAD'].includes(req.method) && mobileRead) ||
          (req.method==='POST' && ['/api/sync/changes','/api/auth/device-reset'].includes(path))) return;
      throw new HttpError(403,'OWNER_REQUIRED','Owner session required');
    }
    const session = req.cookies[cookieName];
    if (!session || !await db.grants.findOne({_id:'web:'+digest(session),expiry:{$gt:new Date()}}))
      throw new HttpError(401,'SIGN_IN','Sign in to continue');
    if (!['GET','HEAD'].includes(req.method) && req.headers.origin!==new URL(config.WEB_ORIGIN).origin)
      throw new HttpError(403,'ORIGIN','Dashboard origin required');
  });
  const limit = (max:number) => ({config:{rateLimit:{max,timeWindow:'1 minute'}}});
  app.post('/api/auth/login',limit(5),async (req,reply)=>{
    const {password} = z.object({password:z.string().max(512)}).parse(req.body);
    if (!timingSafeEqual(Buffer.from(digest(password)),Buffer.from(digest(config.OWNER_PASSWORD))))
      throw new HttpError(401,'SIGN_IN','Incorrect password');
    if (req.headers.origin!==new URL(config.WEB_ORIGIN).origin) throw new HttpError(403,'ORIGIN','Dashboard origin required');
    const value = token();
    await db.grants.insertOne({_id:'web:'+digest(value),name:'owner',expiry:new Date(Date.now()+DAY)});
    reply.setCookie(cookieName,value,{secure:config.NODE_ENV==='production',httpOnly:true,sameSite:'strict',path:'/',maxAge:DAY/1000});
    return {ok:true};
  });
  app.post('/api/auth/logout',async (req,reply)=>{
    await db.grants.deleteOne({_id:'web:'+digest(req.cookies[cookieName]!)});
    return reply.clearCookie(cookieName,{path:'/'}).code(204).send();
  });
  app.get('/api/auth/session',async()=>({ok:true}));
  app.post('/api/auth/pairing-code',async()=>{
    const code = randomBytes(6).toString('hex').toUpperCase();
    await db.grants.insertOne({_id:'pair:'+digest(code),name:'pairing',expiry:new Date(Date.now()+300000)});
    return {code,api:config.PUBLIC_API_URL,expiresIn:300};
  });
  app.post('/api/auth/pair',limit(8),async req=>{
    const {name,code} = z.object({name:z.string().trim().min(1).max(80),code:z.string().trim().toUpperCase().regex(/^[A-F0-9]{12}$/)}).parse(req.body);
    return db.tx(async session=>{
      if (!await db.grants.findOneAndDelete({_id:'pair:'+digest(code),expiry:{$gt:new Date()}},{session}))
        throw new HttpError(401,'PAIRING','Pairing code expired or invalid');
      const value = token(), id = randomUUID(), expiry = new Date(Date.now()+365*DAY);
      await db.devices.insertOne({_id:id,id,name,token:digest(value),expiry,createdAt:new Date().toISOString(),expiresAt:expiry.toISOString()},{session});
      return {token:value,id,expiresAt:expiry.toISOString()};
    });
  });
  app.get('/api/auth/devices',async()=>db.devices.find({},{projection:{_id:0,token:0,expiry:0}}).toArray());
  app.delete<{Params:{id:string}}>('/api/auth/devices/:id',async (req,reply)=>{
    await db.devices.deleteOne({_id:z.uuid().parse(req.params.id)});
    return reply.code(204).send();
  });
  app.post('/api/auth/device-reset',async(req,reply)=>{
    const bearer = req.headers.authorization?.split(' ')[1];
    if (bearer) await db.devices.deleteOne({token:digest(bearer)});
    return reply.code(204).send();
  });
}
