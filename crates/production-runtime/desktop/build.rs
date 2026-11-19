fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=native/macos.m");
        println!("cargo:rerun-if-changed=native/room.h");
        println!("cargo:rerun-if-changed=native/recording.inc");
        cc::Build::new()
            .file("native/macos.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .flag("-Wno-deprecated-declarations")
            .flag("-mmacosx-version-min=13.0")
            .compile("producer_room_platform");
        for framework in [
            "Foundation",
            "UniformTypeIdentifiers",
            "AppKit",
            "AVFoundation",
            "AudioToolbox",
            "ScreenCaptureKit",
            "CoreMedia",
            "CoreVideo",
            "CoreText",
            "Metal",
            "QuartzCore",
            "CoreGraphics",
            "IOSurface",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
}
