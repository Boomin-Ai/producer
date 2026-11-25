fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=native/macos.m");
        println!("cargo:rerun-if-changed=native/studio_audio.c");
        println!("cargo:rerun-if-changed=native/room.h");
        println!("cargo:rerun-if-changed=native/recording.inc");
        println!("cargo:rerun-if-changed=native/p0_pressure.inc");
        println!("cargo:rerun-if-changed=native/render_graph.inc");
        println!("cargo:rerun-if-changed=native/geometry.inc");
        println!("cargo:rerun-if-changed=../../../src-tauri/src/window_vibrancy.m");
        if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("aarch64") {
            let shim = "../../../src-tauri/src/live/shim.m";
            println!("cargo:rerun-if-changed={shim}");
            println!("cargo:rerun-if-changed=native/virtual_camera.m");
            cc::Build::new().file(shim).file("native/virtual_camera.m")
                .flag("-fobjc-arc").flag("-fblocks").flag("-Wno-deprecated-declarations")
                .compile("producer_virtual_camera");
            for framework in ["SystemExtensions", "CoreMediaIO", "Security"] {
                println!("cargo:rustc-link-lib=framework={framework}");
            }
        }
        cc::Build::new().file("native/studio_audio.c").flag("-mmacosx-version-min=13.0").compile("producer_studio_audio");
        cc::Build::new()
            .file("native/macos.m")
            .file("../../../src-tauri/src/window_vibrancy.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .flag("-Wno-deprecated-declarations")
            .flag("-mmacosx-version-min=13.0")
            .compile("producer_room_platform");
        for framework in [
            "Foundation",
            "UniformTypeIdentifiers",
            "AppKit",
            "WebKit",
            "AVFoundation",
            "AVKit",
            "AudioToolbox",
            "ScreenCaptureKit",
            "CoreMedia",
            "CoreVideo",
            "VideoToolbox",
            "CoreText",
            "Metal",
            "QuartzCore",
            "CoreGraphics",
            "CoreImage",
            "IOSurface",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
}
