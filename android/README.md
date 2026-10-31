# DS Bot for Android

A window onto the phone page the relay serves: one `WebView`, the relay address kept on the
device, and the page's own cookies for the sign-in. Nothing of the team runs here — the
computer runs it, and this app shows the same shell a mobile browser would.

- Default address: `https://ds.d-1.top`. On the first run the app asks once and remembers the
  answer (`HttpOnly` cookies survive restarts). To point it elsewhere later, let the address
  fail to load and pick **修改地址**, or clear the app's data.
- Links to other origins open in the browser; the back button walks the page's history first.
- The chat's attach button opens the system file picker, because a WebView cannot show the
  page's own.
- The app's version follows `ds-bot/package.json`, so it matches the plugin and the shell.

## Build

```sh
# JDK 17+, Android SDK with platform 34, Gradle 8.7
ANDROID_HOME=/path/to/android-sdk gradle assembleRelease
# app/build/outputs/apk/release/app-release.apk
```

`.github/workflows/android.yml` builds it on a push under `android/` or on a dispatch, and
keeps the APK as the `DeepSeek-Bot-android` artifact for seven days.

## Signing

Without a key the release build is signed with the debug key. It installs the same way, but
the key differs on every build, so installing a newer APK over an older one fails with a
signature mismatch and needs an uninstall first. To keep one key, add these repository
secrets:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -i app.jks` of a keystore (`keytool -genkeypair -keyalg RSA -keysize 2048 -validity 10000 -keystore app.jks -alias dsbot`) |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `dsbot` |
| `ANDROID_KEY_PASSWORD` | the key password |

The workflow decodes the keystore and the Gradle build signs with it when
`ANDROID_KEYSTORE_PATH` is set.
