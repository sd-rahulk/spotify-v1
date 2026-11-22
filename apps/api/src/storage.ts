import { S3Client, PutObjectCommand, GetObjectCommand, CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseFile, selectCover } from 'music-metadata';
import type { Config } from './config';
import { HttpError, type Job } from './db';
const PART = 8 * 1024 ** 2;
const TTL = 3600;
export const staging = (id:string) => 'staging/' + id;
export const audioKey = (id:string) => 'audio/' + id;
export const artKey = (id:string) => 'artwork/' + id;
export function objectStorage(config:Config) {
  const s3 = new S3Client({region:'auto', endpoint:config.R2_ENDPOINT, forcePathStyle:true,
    credentials:{accessKeyId:config.R2_ACCESS_KEY_ID,secretAccessKey:config.R2_SECRET_ACCESS_KEY},
    requestChecksumCalculation:'WHEN_REQUIRED', responseChecksumValidation:'WHEN_REQUIRED',
    requestHandler:{connectionTimeout:5000,requestTimeout:120000}, maxAttempts:3,
  });
  const Bucket = config.R2_BUCKET;
  const object = (Key:string) => ({Bucket,Key});
  return {
    async begin(job:Job) {
      if (job.size <= PART) return undefined;
      const result = await s3.send(new CreateMultipartUploadCommand({...object(staging(job._id)),ContentType:job.mime}));
      return result.UploadId!;
    },
    async plan(job:Job) {
      const partSize = job.multipart ? PART : job.size;
      const parts = await Promise.all(Array.from({length:Math.ceil(job.size/partSize)},async (_,i)=>{
        const ContentLength = Math.min(partSize,job.size-i*partSize);
        const command = job.multipart ? new UploadPartCommand({...object(staging(job._id)),UploadId:job.multipart,PartNumber:i+1,ContentLength}) :
          new PutObjectCommand({...object(staging(job._id)),ContentType:job.mime,ContentLength});
        const signing={expiresIn:TTL,signableHeaders:new Set(['content-type','content-length'])};
        const url = command instanceof UploadPartCommand ? await getSignedUrl(s3,command,signing) : await getSignedUrl(s3,command,signing);
        return {number:i+1,url};
      }));
      return {id:job._id,partSize,parts};
    },
    async url(key:string, filename?:string) {
      return getSignedUrl(s3,new GetObjectCommand({...object(key),
        ...(filename ? {ResponseContentDisposition:"attachment; filename*=UTF-8''"+encodeURIComponent(filename).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))} : {}),
      }),{expiresIn:4*TTL});
    },
    remove: async (key:string) => { await s3.send(new DeleteObjectCommand(object(key))); },
    head: (key:string) => s3.send(new HeadObjectCommand(object(key))),
    async abort(job:Job) {
      if (job.multipart) {
        try { await s3.send(new AbortMultipartUploadCommand({...object(staging(job._id)),UploadId:job.multipart})); }
        catch (e) { if ((e as {name?:string}).name!=='NoSuchUpload') throw e; }
      }
      await s3.send(new DeleteObjectCommand(object(staging(job._id))));
    },
    async verify(job:Job, parts:{number:number;etag:string}[]) {
      const source = object(staging(job._id));
      const existing = await s3.send(new HeadObjectCommand(source)).catch(e=>{
        if (e.$metadata?.httpStatusCode===404) return null;
        throw e;
      });
      if (!existing && job.multipart) {
        const count = Math.ceil(job.size/PART);
        if (parts.length!==count || parts.some((part,i)=>part.number!==i+1))
          throw new HttpError(400,'PARTS','All uploaded parts must be present in order');
        await s3.send(new CompleteMultipartUploadCommand({...source,UploadId:job.multipart,
          MultipartUpload:{Parts:parts.map(p=>({PartNumber:p.number,ETag:p.etag}))}}));
      }
      const head = existing ?? await s3.send(new HeadObjectCommand(source));
      if (head.ContentLength!==job.size || head.ContentType!==job.mime)
        throw new HttpError(422,'INTEGRITY','Uploaded file size or type differs from its reservation');
      const key = audioKey(job._id);
      await s3.send(new CopyObjectCommand({...object(key),CopySource:Bucket+'/'+source.Key,CopySourceIfMatch:head.ETag,
        MetadataDirective:'REPLACE',ContentType:job.mime,Metadata:{sha256:job.hash}}));
      const dir = await mkdtemp(join(tmpdir(),'resonant-'));
      try {
        const path = join(dir,'audio');
        const response = await s3.send(new GetObjectCommand(object(key)));
        const hash = createHash('sha256');
        let bytes = 0;
        await pipeline(response.Body as Readable,new Transform({transform(chunk, _, done) {
          bytes += chunk.length;
          if (bytes > job.size) return done(new HttpError(422,'INTEGRITY','File exceeded its size reservation'));
          hash.update(chunk); done(null,chunk);
        }}),createWriteStream(path));
        if (bytes!==job.size || hash.digest('hex')!==job.hash)
          throw new HttpError(422,'INTEGRITY','Uploaded file does not match its SHA-256 hash');
        const metadata = await parseFile(path,{duration:true}).catch(()=>{throw new HttpError(422,'CODEC','Invalid or unreadable audio');});
        if (!metadata.format.container || !metadata.format.codec)
          throw new HttpError(422,'CODEC','Music file does not contain a recognized audio stream');
        const candidate = selectCover(metadata.common.picture);
        const picture = candidate && candidate.data.length <= 1024 ** 2 && ['image/jpeg','image/png','image/webp'].includes(candidate.format) ? candidate : undefined;
        return {metadata,picture};
      } finally { await rm(dir,{recursive:true,force:true}); }
    },
    async putArtwork(id:string,picture:{data:Uint8Array;format:string}) {
      await s3.send(new PutObjectCommand({...object(artKey(id)),ContentType:picture.format,Body:picture.data}));
    },
    stream: async (key:string) => (await s3.send(new GetObjectCommand(object(key)))).Body as Readable,
    destroy: () => s3.destroy(),
  };
}
export type Storage = ReturnType<typeof objectStorage>;
