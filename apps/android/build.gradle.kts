plugins {
	alias(libs.plugins.androidApplication) apply false
	alias(libs.plugins.androidLibrary) apply false
	alias(libs.plugins.kotlinAndroid) apply false
	alias(libs.plugins.kotlinSerialization) apply false
	alias(libs.plugins.compose) apply false
}

// Root build file. Module build files own configuration.
