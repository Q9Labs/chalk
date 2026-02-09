plugins {
	alias(libs.plugins.androidLibrary)
	alias(libs.plugins.kotlinAndroid)
	alias(libs.plugins.kotlinSerialization)
}

android {
	namespace = "ai.q9labs.chalk.meetingkit"
	compileSdk = libs.versions.compileSdk.get().toInt()

	defaultConfig {
		minSdk = libs.versions.minSdk.get().toInt()
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}

	kotlinOptions { jvmTarget = JavaVersion.VERSION_17.toString() }
}

dependencies {
	api(libs.realtimekit.core)
	implementation(libs.okhttp)
	implementation(libs.coroutines.android)
	implementation(libs.serialization.json)
}

