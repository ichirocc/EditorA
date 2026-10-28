import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Platform-independent editor logic (lexer, undo history, search, decoding).
// Kept free of Android APIs so it can be built and tested on any JVM.
plugins {
	kotlin("jvm") version "2.1.21"
}

group = "editora"
version = "0.1.0"

java {
	sourceCompatibility = JavaVersion.VERSION_17
	targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
	compilerOptions {
		jvmTarget.set(JvmTarget.JVM_17)
	}
}

dependencies {
	testImplementation(kotlin("test"))
}

tasks.test {
	useJUnitPlatform()
}
