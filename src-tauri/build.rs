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
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        link_live_engine_windows();
        return;
    }
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
    println!("cargo:rustc-link-lib=framework=AVFoundation");
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

/// Windows: the engine links by raw-dylib (import table synthesized in ffi.rs),
/// so nothing to link here — but obs.dll resolves at process load, so the
/// artifact tree is copied next to the output executable for dev runs.
/// Release bundling places the same tree in the install root.
fn link_live_engine_windows() {
    println!("cargo:rerun-if-env-changed=PRODUCER_ENGINE_DIR");
    println!("cargo:rerun-if-changed=../engine/obs-windows.lock");
    let engine_dir = std::env::var("PRODUCER_ENGINE_DIR")
        .map(PathBuf::from)
        .ok()
        .or_else(|| find_default_artifact_prefix("producer-libobs-windows-"));
    let Some(engine_dir) = engine_dir else {
        println!("cargo:warning=live engine artifact not found; building without live support");
        return;
    };
    if !engine_dir.join("obs.dll").exists() {
        println!(
            "cargo:warning=no obs.dll under {}; building without live support",
            engine_dir.display()
        );
        return;
    }
    println!("cargo:rustc-cfg=have_engine");

    // OUT_DIR = target/<...>/<profile>/build/<pkg>/out → profile dir is 3 up.
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    if let Some(profile_dir) = out.ancestors().nth(3) {
        copy_tree_if_newer(&engine_dir, profile_dir);
    }
}

fn copy_tree_if_newer(src: &std::path::Path, dst: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(src) else {
        return;
    };
    for e in entries.filter_map(|e| e.ok()) {
        let from = e.path();
        let to = dst.join(e.file_name());
        if from.is_dir() {
            let _ = std::fs::create_dir_all(&to);
            copy_tree_if_newer(&from, &to);
        } else {
            let same = to
                .metadata()
                .ok()
                .zip(from.metadata().ok())
                .is_some_and(|(a, b)| a.len() == b.len());
            if !same {
                let _ = std::fs::copy(&from, &to);
            }
        }
    }
}

fn find_default_artifact_prefix(prefix: &str) -> Option<PathBuf> {
    let artifacts = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../engine/artifacts");
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&artifacts)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(prefix))
        })
        .collect();
    candidates.sort_by_key(|p| p.metadata().and_then(|m| m.modified()).ok());
    candidates.pop()
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
