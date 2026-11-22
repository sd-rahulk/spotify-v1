# Cloud setup and deployment

## Atlas

Create an Atlas Free cluster. Use a database user with read/write access restricted to the Resonant database and limit the network allowlist to the API host and development machine. Set `MONGO_URI` and `MONGO_DB` on Fastify only. The API initializes indexes and requires replica-set transactions. [Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)

## R2

Create a private Standard bucket. Create an object read/write API token scoped to the bucket. Set the API's `R2_ENDPOINT` to `https://<account-id>.r2.cloudflarestorage.com`. Use the following bucket CORS configuration with your actual dashboard origin.

```json
[
  {
    "AllowedOrigins": ["https://music.example.com", "http://localhost:3000"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type", "range", "content-length"],
    "ExposeHeaders": ["etag", "content-range", "accept-ranges", "content-length"],
    "MaxAgeSeconds": 3600
  }
]
```

Expire objects and abort unfinished multipart uploads under the `staging/` prefix after two days with an R2 lifecycle rule. This covers staging data left after a process interruption. Keep permanent audio and artwork outside this rule.

Resonant defaults to 8,000,000,000 bytes. The application reserves room for both staged and verified copies before signing. This temporarily reduces available upload capacity. The quota describes application accounting. Provider storage, operation fees, other bucket objects and hosting fees are billed independently. R2 currently publishes 10 GB-months, 1 million Class A operations and 10 million Class B operations per month for the Standard free allowance. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

## Node and Next.js hosts

Set `NODE_ENV=production`, `HOST=0.0.0.0`, a long random `OWNER_PASSWORD`, a separate `APP_SECRET` with at least 32 random bytes, `WEB_ORIGIN` and `PUBLIC_API_URL`. The public origins must use HTTPS. Run `pnpm --filter @resonant/api start` and use `/health` for readiness. The API host needs outbound TLS for Atlas and R2, temporary disk for upload verification, and response timeouts sufficient for the verification step. Set `API_ORIGIN` to the Fastify origin before building Next.js with `pnpm --filter @resonant/web build`. Its gateway forwards dashboard requests and cookies. Audio transfers go directly to R2.

Vercel Hobby is an option for the personal dashboard. Render's free Node web service is suitable for evaluation. It sleeps after 15 minutes of inactivity, has ephemeral disk, and limits bandwidth. MongoDB connections and timers run while the service is awake. A continuously available Node service or self-hosted machine is a better fit for reliable background cleanup. [Vercel Hobby](https://vercel.com/docs/plans/hobby) · [Render Free](https://render.com/docs/free)

## Persistent local alternative

Run `docker compose -f infrastructure/docker/compose.yaml up -d`. Initialize MongoDB with `docker compose -f infrastructure/docker/compose.yaml exec mongo mongosh --eval "rs.initiate()"`. Open MinIO on port 9001 using the local Compose credentials and create a private bucket named `music`. Copy `.env.example` to `.env`, set MongoDB to `mongodb://localhost:27017/?directConnection=true&replicaSet=rs0`, use `http://localhost:9000` for the S3 endpoint and fill in local development secrets. Start the API with `pnpm --filter @resonant/api dev`. Keep this Compose stack on loopback.


## Vercel projects

| Project | Vercel root | Production environment |
| --- | --- | --- |
| resonant-admin-song-upload | apps/web | API_ORIGIN set to the stable HTTPS URL of the API project |
| resonant-music-api | apps/api | MONGO_URI, MONGO_DB, OWNER_PASSWORD, APP_SECRET, PUBLIC_API_URL, WEB_ORIGIN, R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CRON_SECRET and optional quota settings |

Set **PUBLIC_API_URL** to the API project's HTTPS origin and **WEB_ORIGIN** to the dashboard's HTTPS origin. Keep both values free of a trailing slash. Generate **CRON_SECRET** as a separate random value of at least 16 characters. Redeploy both projects after setting environment variables. The API's daily Cron job deletes expired staging data. You can also run cleanup from the dashboard's Settings.

Vercel's Function and proxy limits apply to verification and metadata backups. Audio uploads and playback transfer directly through signed R2 URLs. Verify the cloud flow with a small file before importing the library. [Function limits](https://vercel.com/docs/functions/limitations)
