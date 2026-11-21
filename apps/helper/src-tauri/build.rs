fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=native/window_mac.m");
        for framework in ["CoreGraphics", "Foundation", "ScreenCaptureKit"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        cc::Build::new()
            .file("native/window_mac.m")
            .flags(["-fobjc-arc", "-mmacosx-version-min=14.0"])
            .compile("chalk_window");
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["view", "act"])),
    )
    .expect("failed to build Chalk Helper");
}
