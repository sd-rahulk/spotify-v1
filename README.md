# Resonant

A private, single-owner music library for Android and the web. The Next.js dashboard manages audio files. Fastify authorizes transfers and stores metadata in MongoDB. Android reads from SQLite and plays through a native Media3 service.

## Windows quick start

Use Node.js 24 LTS and Android Studio. Run from the repository root. Use the `.cmd` entry points in Windows PowerShell.

```powershell
npx.cmd --yes pnpm@10.30.3 install --frozen-lockfile
npx.cmd --yes pnpm@10.30.3 check
npx.cmd --yes pnpm@10.30.3 test
npx.cmd --yes pnpm@10.30.3 build
```

Start the disposable local test API and the dashboard in separate terminals. The test API downloads a MongoDB binary on first launch and binds to loopback. Its library is temporary.

```powershell
npx.cmd --yes pnpm@10.30.3 --filter @resonant/api exec tsx test/start-local.ts
npx.cmd --yes pnpm@10.30.3 --filter @resonant/web dev
```

Open [the dashboard](http://localhost:3000) with the local test password `resonant-local-test-only`. Upload audio you own. The Android app can also import audio directly from the system file picker before pairing.

- [Android setup and release signing](docs/setup/android.md)
- [Atlas, R2 and deployment](infrastructure/deployment/README.md)
- [Architecture and current scope](docs/architecture/README.md)
- [Automated tests and device acceptance](docs/testing/README.md)

The Android bridge uses React Native Community CLI and Media3. The generated iOS scaffold requires a separate native implementation.
