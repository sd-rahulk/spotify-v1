# Android setup

Install SDK Platform 37, Build-Tools 37.0.0, the emulator and platform tools in Android Studio. Gradle can install licensed packages including NDK 27.1.12297006. Use the Android Studio bundled JDK or JDK 21 and the included Gradle 9.4.1 wrapper.

Start an Android virtual device or connect a USB debugging device. Run Metro from the repository root in its own terminal.

```powershell
npx.cmd --yes pnpm@10.30.3 --filter @resonant/mobile start
```

Use a second terminal for the build. The ADB reverse commands allow the app to reach the local test stack using `http://localhost:4100`.

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
& $adb devices
& $adb reverse tcp:8081 tcp:8081
& $adb reverse tcp:4100 tcp:4100
& $adb reverse tcp:4569 tcp:4569
Set-Location apps/mobile/android
.\gradlew.bat :app:assembleDebug -PreactNativeArchitectures=x86_64
& $adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Use `arm64-v8a` for most physical phones. To embed JavaScript and run without Metro, use `.\gradlew.bat :app:assembleDebug "-PreactNativeArchitectures=x86_64,arm64-v8a" -PbundleDebug`. In the dashboard's **Settings**, create a pairing code. In Android Settings enter the API origin and code. The emulator can also reach the host API via `http://10.0.2.2:4100`. A local S3 endpoint signed on `localhost` still needs its own ADB reverse mapping. When using Docker MinIO, reverse port 9000 in place of 4569. For wireless phone development, use a trusted HTTPS development tunnel or a LAN HTTPS endpoint with a certificate trusted by the phone.

Debug builds allow loopback and emulator HTTP endpoints. Release pairing requires HTTPS.

## Release

Run `.\gradlew.bat :app:assembleRelease -PreactNativeArchitectures=arm64-v8a` inside `apps/mobile/android`. Use Android Studio's signed APK flow or align and sign the unsigned APK with a personal key.

```powershell
$tools = Join-Path $env:ANDROID_HOME 'build-tools\37.0.0'
& "$tools\zipalign.exe" -P 16 -f -v 4 app/build/outputs/apk/release/app-release-unsigned.apk resonant-aligned.apk
& "$tools\apksigner.bat" sign --ks C:\keys\resonant-release.jks --out resonant.apk resonant-aligned.apk
& "$tools\apksigner.bat" verify --verbose resonant.apk
```

Store signing keys separately and retain the same key for updates. Check Android registration and installation requirements for your chosen distribution method.
If Ninja hits the Windows path-length limit, build with a short CMake staging directory.

```powershell
$staging = Join-Path $env:TEMP 'rs-cxx'
.\gradlew.bat :app:assembleRelease '-PreactNativeArchitectures=arm64-v8a' "-PnativeBuildStagingDir=$staging"
```
