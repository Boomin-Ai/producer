use std::{env, path::PathBuf, process::Command};
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=LIVEKIT_LAB_LINK_EXTERNAL_ARCHIVE");
    println!("cargo:rerun-if-changed=src/obs_bridge.m");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-ObjC");
        if env::var("LIVEKIT_LAB_LINK_EXTERNAL_ARCHIVE").as_deref() == Ok("1") {
            // Discard upstream native DWARF during linking rather than creating
            // a large unstripped binary and another objcopy temporary file.
            println!("cargo:rustc-link-arg=-Wl,-S");
        }
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
        assert!(Command::new("ar")
            .arg("rcs")
            .arg(out.join("libguest_obs_bridge.a"))
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
