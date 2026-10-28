import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
	id("com.android.application")
	id("org.jetbrains.kotlin.android")
}

// Release signing comes from the environment (see .github/workflows/native-apk.yml).
val keystorePath: String? = System.getenv("EDITORA_KEYSTORE_PATH")

android {
	namespace = "editora.app"
	compileSdk = 36

	defaultConfig {
		applicationId = "io.github.ichirocc.editora"
		minSdk = 26
		targetSdk = 36
		versionCode = (System.getenv("EDITORA_VERSION_CODE") ?: "1").toInt()
		versionName = "0.1.0"
	}

	signingConfigs {
		if (keystorePath != null) {
			create("release") {
				storeFile = file(keystorePath)
				storePassword = System.getenv("EDITORA_KEYSTORE_PASSWORD")
				keyAlias = System.getenv("EDITORA_KEY_ALIAS")
				keyPassword = System.getenv("EDITORA_KEY_PASSWORD")
			}
		}
	}

	buildTypes {
		release {
			isMinifyEnabled = true
			isShrinkResources = true
			proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
			signingConfig = signingConfigs.findByName("release")
		}
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}

	// Do not embed the encrypted dependency report Google Play uses.
	dependenciesInfo {
		includeInApk = false
		includeInBundle = false
	}
}

kotlin {
	compilerOptions {
		jvmTarget.set(JvmTarget.JVM_17)
	}
}

dependencies {
	implementation("editora:core:0.1.0")
}
