import java.io.File

plugins {
    id("com.android.application")
}

// The app is a WebView shell for the phone page the relay serves, so it carries the same
// version as the plugin and the shell: one number for the whole release.
val versionParts = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(File(rootProject.projectDir, "../ds-bot/package.json").readText())
    ?.groupValues?.get(1)?.substringBefore('-')
    ?.split('.')?.map { it.toIntOrNull() ?: 0 }
    ?: listOf(0, 0, 0)
val appVersionName = versionParts.joinToString(".")
val appVersionCode = versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2]

// A release build is signed with the key in the repository's secrets when it has one; without
// it the debug key is used, which installs fine but changes on every build, so an update needs
// an uninstall first.
val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_PATH")

android {
    namespace = "top.d1.dsbot"
    compileSdk = 34

    defaultConfig {
        applicationId = "top.d1.dsbot"
        minSdk = 24
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = File(keystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = if (keystorePath != null) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
