fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["view", "act"])),
    )
    .expect("failed to build Chalk Helper");
}
