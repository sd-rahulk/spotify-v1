import { z } from 'zod';
export const readConfig = (env: NodeJS.ProcessEnv) => z.object({
  NODE_ENV: z.enum(['development','production','test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  HOST: z.string().default('127.0.0.1'),
  PUBLIC_API_URL: z.url().default('http://localhost:4100'),
  WEB_ORIGIN: z.url().default('http://localhost:3000'),
  MONGO_URI: z.string().min(1),
  MONGO_DB: z.string().default('resonant'),
  OWNER_PASSWORD: z.string().min(16),
  APP_SECRET: z.string().min(32),
  STORAGE_QUOTA: z.coerce.number().int().positive().default(8_000_000_000),
  MAX_FILE_BYTES: z.coerce.number().int().positive().max(1024 ** 3).default(512 * 1024 ** 2),
  R2_ENDPOINT: z.url(), R2_BUCKET: z.string().min(1), R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
}).superRefine((v, ctx) => {
  if (v.NODE_ENV === 'production' && [v.PUBLIC_API_URL,v.WEB_ORIGIN,v.R2_ENDPOINT].some(url => !url.startsWith('https://')))
    ctx.addIssue({ code:'custom', message:'Production requires HTTPS origins' });
}).parse(env);
export type Config = ReturnType<typeof readConfig>;
