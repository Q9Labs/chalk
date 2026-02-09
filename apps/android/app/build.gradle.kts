plugins {
	alias(libs.plugins.androidApplication)
	alias(libs.plugins.kotlinAndroid)
	alias(libs.plugins.compose)
}

android {
	namespace = "ai.q9labs.chalk.nativeapp"
	compileSdk = libs.versions.compileSdk.get().toInt()

	defaultConfig {
		applicationId = "ai.q9labs.chalk.nativeapp"
		minSdk = libs.versions.minSdk.get().toInt()
		targetSdk = libs.versions.targetSdk.get().toInt()
		versionCode = 1
		versionName = "0.0.1"
	}

	buildTypes {
		release {
			isMinifyEnabled = false
			proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
		}
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}

	kotlinOptions { jvmTarget = JavaVersion.VERSION_17.toString() }

	buildFeatures {
		compose = true
	}
}

dependencies {
	implementation(project(":meetingkit"))

	implementation(libs.androidx.core.ktx)
	implementation(libs.androidx.activity.compose)
	implementation(libs.androidx.lifecycle.runtime.ktx)
	implementation(libs.androidx.lifecycle.runtime.compose)
	implementation(libs.androidx.lifecycle.viewmodel.compose)

	implementation(platform(libs.compose.bom))
	implementation(libs.compose.ui)
	implementation(libs.compose.ui.tooling.preview)
	implementation(libs.compose.material3)

	debugImplementation(libs.compose.ui.tooling)
}

// Whiteboard WebView assets (built from `apps/native/whiteboard-web` in the monorepo).
val buildWhiteboardWeb = tasks.register<Exec>("buildWhiteboardWeb") {
	workingDir = rootProject.projectDir
	commandLine("bash", "../native/whiteboard-web/build.sh")

	val wbDir = rootProject.file("../native/whiteboard-web")
	inputs.dir(wbDir.resolve("src"))
	inputs.file(wbDir.resolve("package.json"))
	outputs.dir(wbDir.resolve("dist"))
}

val copyWhiteboardAssets = tasks.register<Copy>("copyWhiteboardAssets") {
	dependsOn(buildWhiteboardWeb)

	val dist = rootProject.file("../native/whiteboard-web/dist")
	val outDir = layout.buildDirectory.dir("generated/whiteboard").get().asFile

	from(dist)
	into(outDir.resolve("whiteboard"))
}

android.sourceSets.named("main") {
	assets.srcDir(layout.buildDirectory.dir("generated/whiteboard"))
}

tasks.matching { it.name == "preDebugBuild" || it.name == "preReleaseBuild" }.configureEach {
	dependsOn(copyWhiteboardAssets)
}
