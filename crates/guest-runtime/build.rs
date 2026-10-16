fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // LiveKit's WebRTC Objective-C categories must survive static linking.
        println!("cargo:rustc-link-arg=-ObjC");
        if std::env::var_os("CARGO_FEATURE_OBS_PROOF").is_some() {
            let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            let source = root.join("src-tauri/src/live/guest_ingest.c");
            let object = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap())
                .join("guest_ingest.o");
            assert!(std::process::Command::new("clang")
                .args(["-c"])
                .arg(&source)
                .arg("-o")
                .arg(&object)
                .status()
                .unwrap()
                .success());
            let engine = std::env::var("PRODUCER_ENGINE_DIR")
                .expect("OBS proof requires an explicit installed engine");
            let frameworks = std::path::Path::new(&engine).join("Frameworks");
            assert!(frameworks.join("libobs.framework").is_dir());
            println!("cargo:rerun-if-changed={}", source.display());
            println!("cargo:rerun-if-env-changed=PRODUCER_ENGINE_DIR");
            println!("cargo:rustc-link-search=framework={}", frameworks.display());
            println!("cargo:rustc-link-lib=framework=libobs");
            println!("cargo:rustc-link-arg={}", object.display());
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", frameworks.display());
        }
    }
}
