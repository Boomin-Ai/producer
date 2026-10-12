use std::{env, path::PathBuf, process::Command};
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=LIVEKIT_LAB_LINK_EXTERNAL_ARCHIVE");
    println!("cargo:rerun-if-changed=src/obs_bridge.m");
    println!("cargo:rerun-if-changed=../../src-tauri/src/live/guest_ingest.c");
    println!("cargo:rerun-if-changed=../../src-tauri/src/live/guest_ingest.h");
    println!("cargo:rerun-if-changed=src/physical_audio.mm");
    println!("cargo:rerun-if-changed=src/physical_camera.mm");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-ObjC");
        if env::var("LIVEKIT_LAB_LINK_EXTERNAL_ARCHIVE").as_deref() == Ok("1") {
            // Discard upstream native DWARF during linking rather than creating
            // a large unstripped binary and another objcopy temporary file.
            println!("cargo:rustc-link-arg=-Wl,-S");
        }
    }
    if env::var_os("CARGO_FEATURE_PHYSICAL_AEC").is_some() {
        assert_eq!(env::var("CARGO_CFG_TARGET_OS").unwrap(), "macos");
        let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
        assert!(Command::new("clang++")
            .args([
                "-std=c++17",
                "-mmacosx-version-min=13.0",
                "-fobjc-arc",
                "-fexceptions",
                "-fobjc-arc-exceptions",
                "-c",
                "src/physical_audio.mm",
                "-o"
            ])
            .arg(out.join("physical_audio.o"))
            .status()
            .unwrap()
            .success());
        assert!(Command::new("ar")
            .arg("rcs")
            .arg(out.join("libphysical_audio.a"))
            .arg(out.join("physical_audio.o"))
            .status()
            .unwrap()
            .success());
        assert!(Command::new("clang++")
            .args([
                "-std=c++17",
                "-mmacosx-version-min=13.0",
                "-fobjc-arc",
                "-fexceptions",
                "-fobjc-arc-exceptions",
                "-c",
                "src/physical_camera.mm",
                "-o"
            ])
            .arg(out.join("physical_camera.o"))
            .status()
            .unwrap()
            .success());
        assert!(Command::new("ar")
            .arg("rcs")
            .arg(out.join("libphysical_camera.a"))
            .arg(out.join("physical_camera.o"))
            .status()
            .unwrap()
            .success());
        println!("cargo:rustc-link-lib=static=physical_camera");
        println!("cargo:rustc-link-search=native={}", out.display());
        println!("cargo:rustc-link-lib=static=physical_audio");
        for framework in [
            "CoreMedia",
            "CoreVideo",
            "AppKit",
            "AVFoundation",
            "AVFAudio",
            "CoreAudio",
            "AudioToolbox",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rustc-link-lib=c++");
    }
    if env::var_os("CARGO_FEATURE_OBS_PROOF").is_some() {
        assert_eq!(
            env::var("CARGO_CFG_TARGET_OS").unwrap(),
            "macos",
            "OBS lab currently requires macOS"
        );
        let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
        assert!(Command::new("clang")
            .args(["-c", "src/obs_bridge.m", "-o"])
            .arg(out.join("obs_bridge.o"))
            .status()
            .unwrap()
            .success());
        assert!(Command::new("clang")
            .args([
                "-Wall",
                "-Wextra",
                "-Werror",
                "-c",
                "../../src-tauri/src/live/guest_ingest.c",
                "-o"
            ])
            .arg(out.join("guest_ingest.o"))
            .status()
            .unwrap()
            .success());
        assert!(Command::new("ar")
            .arg("rcs")
            .arg(out.join("libguest_obs_bridge.a"))
            .arg(out.join("guest_ingest.o"))
            .arg(out.join("obs_bridge.o"))
            .status()
            .unwrap()
            .success());
        println!("cargo:rustc-link-search=native={}", out.display());
        println!("cargo:rustc-link-lib=static=guest_obs_bridge");
        println!(
            "cargo:rustc-link-search=framework=/Applications/Producer.app/Contents/Frameworks"
        );
        println!("cargo:rustc-link-lib=framework=libobs");
        println!("cargo:rustc-link-lib=framework=Cocoa");
        println!("cargo:rustc-link-arg=-Wl,-rpath,/Applications/Producer.app/Contents/Frameworks");
    }
}
