use std::path::PathBuf;

fn main() {
    println!("cargo:rustc-check-cfg=cfg(have_engine)");
    link_live_engine();
    tauri_build::build()
}

/// Link the Producer engine artifact (libobs + plugin allowlist; see
/// engine/obs.lock and LIVE-REVIEW.md). When no artifact is present the app
/// still builds — live features compile to stubs.
fn link_live_engine() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    println!("cargo:rerun-if-env-changed=PRODUCER_ENGINE_DIR");
    println!("cargo:rerun-if-changed=../engine/obs.lock");

    let engine_dir = std::env::var("PRODUCER_ENGINE_DIR")
        .map(PathBuf::from)
        .ok()
        .or_else(find_default_artifact);
    let Some(engine_dir) = engine_dir else {
        println!("cargo:warning=live engine artifact not found; building without live support");
        return;
    };
    let frameworks = engine_dir.join("Frameworks");
    if !frameworks.join("libobs.framework").exists() {
        println!(
            "cargo:warning=no libobs.framework under {}; building without live support",
            frameworks.display()
        );
        return;
    }

    println!("cargo:rustc-cfg=have_engine");
    println!("cargo:rustc-link-search=framework={}", frameworks.display());
    println!("cargo:rustc-link-lib=framework=libobs");
    println!("cargo:rustc-link-lib=framework=CoreFoundation");

    // AppKit/AVFoundation shim (M-L6 preview + TCC + device lookup).
    println!("cargo:rerun-if-changed=src/live/shim.m");
    cc::Build::new()
        .file("src/live/shim.m")
        .flag("-fobjc-arc")
        .flag("-fmodules")
        .compile("producer_live_shim");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=CoreMediaIO");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    // Virtual camera (R13): OSSystemExtensionManager activation.
    println!("cargo:rustc-link-lib=framework=SystemExtensions");
    println!("cargo:rustc-link-lib=framework=CoreGraphics");
    println!("cargo:rustc-link-lib=framework=CoreMedia");
    // Bundled app resolves the engine beside the executable. Debug builds may
    // also run from target/, so they get an extra rpath into the artifact;
    // release binaries carry ONLY the bundle-relative rpath so the M-L1
    // relocation test cannot be masked by a repo-absolute path.
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", frameworks.display());
    }
}

fn find_default_artifact() -> Option<PathBuf> {
    let artifacts = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../engine/artifacts");
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&artifacts)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("producer-libobs-macos-"))
        })
        .collect();
    candidates.sort_by_key(|p| p.metadata().and_then(|m| m.modified()).ok());
    candidates.pop()
}
