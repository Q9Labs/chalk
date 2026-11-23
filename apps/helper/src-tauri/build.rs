fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=native/window_mac.m");
        println!("cargo:rerun-if-changed=native/credentials_mac.m");
        println!("cargo:rerun-if-changed=native/permission_mac.m");
        for framework in [
            "AppKit",
            "CoreGraphics",
            "ColorSync",
            "Foundation",
            "ScreenCaptureKit",
            "WebKit",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        let mut native = cc::Build::new();
        native
            .files([
                "native/window_mac.m",
                "native/credentials_mac.m",
                "native/permission_mac.m",
            ])
            .flags(["-fobjc-arc", "-mmacosx-version-min=14.0"]);
        if std::env::var_os("CARGO_FEATURE_FIXTURE").is_some() {
            native.define("CHALK_PREVIEW", None);
        }
        native.compile("chalk_window");
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["view", "act"])),
    )
    .expect("failed to build Chalk Helper");
}
