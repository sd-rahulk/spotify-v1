# Verification

The API suite runs against a real disposable MongoDB replica set and an S3-compatible test server. The browser suite drives the dashboard using generated WAV fixtures. The fixture code lives under the test directories and ships no catalog.

```powershell
npx.cmd --yes pnpm@10.30.3 check
npx.cmd --yes pnpm@10.30.3 test
npx.cmd --yes pnpm@10.30.3 build
npx.cmd --yes pnpm@10.30.3 --filter @resonant/web exec playwright install chromium
npx.cmd --yes pnpm@10.30.3 --filter @resonant/web exec playwright test
```

Use a fresh disposable API between repeated browser test runs. If you reuse its URL with a fresh database, clear the Android test app data before pairing to that fixture library. The browser suite leaves the fixtures in the local test library so the emulator can test the same data.

## Results from this workspace

| Check | Result |
|---|---|
| Workspace TypeScript | API, web and mobile passed |
| API integration | Four tests passed using MongoDB 8.0.12 and local S3. Covers owner/device scopes, Unicode tags, verification, byte ranges, duplicate and quota handling, cancellation, sync and deletion, multipart and manifest recovery |
| Chromium | Uploaded 20 valid generated WAV files, detected an exact duplicate, edited a title, created and populated a playlist, played and paused the preview, and generated a pairing code |
| React Native unit | Local-first launch and import entry point passed with a test bridge |
| Builds | Next.js production build and bundled x86_64/arm64-v8a debug APK passed. Android SDK apksigner verified the APK |
| Android API 37 emulator | Paired and synced, searched SQLite, streamed the browser fixture, played on the home screen and with the display asleep, handled simulated Android media keys, verified a WorkManager download, restored the queue after process stop, played without Wi-Fi, mobile data or cached streaming chunks, and received a playlist edit after reconnect |

The complete emulator smoke script passed after resolving build and UI automation issues. A debug emulator capture recorded 151 janky frames out of 312 during development. This environment did not demonstrate the 60 FPS target. Release-mode profiling on physical hardware is still needed.

## Emulator smoke test

Install the debug build, start the disposable API and dashboard, and run the browser suite. With an Android emulator connected and an unpaired Resonant install, run `python infrastructure/scripts/android-smoke.py` from the repository root. Debug builds can require a local-network permission prompt on API 37. Allow it for the loopback verification.

## Physical device and cloud acceptance

1. Start the dashboard and API with Atlas and R2 credentials. Upload 20 files that you own. Inspect metadata in Atlas and the private objects in R2.
2. Edit tags and create a playlist. Generate a one-time pairing code. Pair Android and search for the renamed track.
3. Play, pause, seek, shuffle, repeat and reorder the queue. Press Home and verify that the native clock advances. Inspect the media notification, tap to open and verify lock/unlock playback.
4. Connect Bluetooth headphones and send transport commands. Disconnect the headphones during playback and check for pause. Repeat with wired audio when available. Test competing audio focus and an incoming call.
5. Download the playlist, turn off Wi-Fi and mobile data, and play all downloaded tracks. Restore connectivity, edit the playlist on the web and verify foreground sync.
6. Validate interrupted download resumption, rapid track skipping, error recovery, process death and the last playback checkpoint. Test disabled and expired credentials and slow-network behavior.
7. Profile UI frame timing, SQLite search latency and background energy on representative hardware before making performance claims.

Live Atlas and R2 require owner credentials. Bluetooth, lock screen behavior across OEMs, calls and energy measurements require a physical Android test device.
