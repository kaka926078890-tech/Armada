plugins {
    kotlin("jvm") version "2.0.21" apply false
    kotlin("android") version "2.0.21" apply false
    kotlin("plugin.serialization") version "2.0.21" apply false
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}

tasks.register("clean", Delete::class) {
    delete(rootProject.layout.buildDirectory)
}
