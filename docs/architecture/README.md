# Architecture

| Layer | Implementation |
|---|---|
| Web | Next.js App Router, Tailwind, browser file hashing, direct object PUTs, HTML audio and Media Session |
| API | Fastify 5, TypeScript, Zod, MongoDB Node driver, AWS S3 SDK |
| Android | React Native 0.87.1, FlashList, Kotlin Media3 and WorkManager, SQLite, Android Keystore |
| Contracts | Shared metadata, playlists, usage and changes plus common validation and fetch packages |

Media3 owns the foreground notification, queue, playback clock and audio focus. Kotlin resolves the source when ExoPlayer opens it. This allows the same native pipeline to play private downloads or scoped cloud streams while the React activity is absent. [MediaSessionService documentation](https://developer.android.com/media/media3/session/background-playback)

Tracks store tags, hash, audio key, optional cover and listening summaries. Artists and albums are derived from track tags. Playlists store ordered IDs. A revisioned change document records each entity's current state or tombstone. SQLite applies a page and cursor in a transaction. Schema version 2 backfills indexed fields from existing records and avoids depending on SQLite JSON extensions on older Android versions. Durable offline writes are posted before the next pull. Operation IDs deduplicate retries. The API uses last accepted writes for conflicts. Concurrent changes to a playlist's full membership or order replace that field.

The owner authenticates with a password. Session cookies are HttpOnly and SameSite Strict and are Secure in production. Five-minute pairing codes are consumed in a transaction. Device tokens are restricted, revocable, and encrypted by an Android Keystore-backed AES-GCM key. A revoked or expired credential can be replaced through pairing. Verified offline audio remains available on the device.

## Upload and storage

The browser reads tags and hashes bytes incrementally, then reserves the nonduplicate batch. Multipart uses direct signed part PUTs. The browser switches from progress to verification at the end of each transfer. The API copies the upload to an immutable key, verifies size and content type, computes SHA-256 while streaming to a temporary file, parses its metadata and commits it transactionally. Original audio is preserved. Expired jobs are reconciled after the signed PUT lifetime. Track deletion creates a tombstone and queues physical object deletion. Accounting keeps deleted objects charged until cleanup succeeds.

A native read checks verified offline files first, then Media3's LRU streaming cache, then a fresh signed URL. Explicit downloads have a separate private directory and use WorkManager with the selected network constraint. Partial HTTP transfers can resume. The app verifies size and SHA-256 before promoting a completed file. Playback checkpoints preserve queue, position, repeat and shuffle. An Android force-stop terminates playback.

## Backup

Export the manifest and independently copy audio and artwork from the private bucket. Restore the original keys to a bucket, connect an empty database, then import the manifest from Settings. Restore checks expected object sizes and stored hash metadata. The manifest contains no audio, credentials or full listening history. Re-pair devices after rebuilding the database.

## Current scope

Playlists can use a member track as their cover. Albums use member artwork. Independent artwork objects for groups and playlists, Wi-Fi prefetch, data-use counters, detailed audio-route labels and offline artwork retention beyond platform caching are pending. Interrupted browser transfers can resume server verification when their part receipts were saved. Partial browser transfers otherwise require reselection or retry. Android and browser decoder support differ. No transcoding or optional Spotify integration is included. Frame rate and battery performance require device profiling.
