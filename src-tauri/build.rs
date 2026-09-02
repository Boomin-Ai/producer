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
    // The one seam that decides whether this is a live build. Each supported OS
    // resolves its own artifact and emits its own link flags; anything else
    // returns and the ~50 cfg(have_engine) sites compile to stubs.
    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("macos") => link_live_engine_macos(),
        Ok("windows") => link_live_engine_windows(),
        _ => {}
    }
}

fn link_live_engine_macos() {
    println!("cargo:rerun-if-env-changed=PRODUCER_ENGINE_DIR");
    println!("cargo:rerun-if-changed=../engine/obs.lock");

    let engine_dir = std::env::var("PRODUCER_ENGINE_DIR")
        .map(PathBuf::from)
        .ok()
        .or_else(|| find_default_artifact("macos"));
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

/// Newest artifact for `os` by mtime.
///
/// Deliberately NOT hash-checked. The artifact name embeds sha256(obs.lock), so
/// a lock edit re-keys every platform's name at once — and a hash check here
/// would break local development the moment anyone touched the lock, before CI
/// had a chance to publish the re-keyed artifacts. CI resolves BY hash
/// (release.yml computes it from the lock); local dev resolves by recency. That
/// asymmetry is intentional.
fn find_default_artifact(os: &str) -> Option<PathBuf> {
    let artifacts = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../engine/artifacts");
    let prefix = format!("producer-libobs-{os}-");
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&artifacts)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(&prefix))
        })
        .collect();
    candidates.sort_by_key(|p| p.metadata().and_then(|m| m.modified()).ok());
    candidates.pop()
}

/// Windows engine linkage.
///
/// The artifact mirrors an OBS Windows install rather than a macOS bundle:
/// `bin/` (obs.dll + the import library), `obs-plugins/64bit/`, `data/`, `cef/`.
/// There is no framework concept and no rpath — Windows resolves DLLs from the
/// executable's directory, so bundling copies the artifact beside the exe and
/// nothing needs baking into the binary.
fn link_live_engine_windows() {
    println!("cargo:rerun-if-env-changed=PRODUCER_ENGINE_DIR");
    println!("cargo:rerun-if-changed=../engine/obs.lock");

    let engine_dir = std::env::var("PRODUCER_ENGINE_DIR")
        .map(PathBuf::from)
        .ok()
        .or_else(|| find_default_artifact("windows"));
    let Some(engine_dir) = engine_dir else {
        println!("cargo:warning=live engine artifact not found; building without live support");
        return;
    };

    // TWO LAYOUTS ARE VALID, and both exist in practice:
    //   flat   — obs.dll at the artifact root, which is what an extracted
    //            official OBS Windows release looks like (obs.lock's R1
    //            "official-release-extract" fallback mode)
    //   bin/   — what a source build under our preset produces
    // Probing for the DLL rather than assuming a shape means a locally-dropped
    // extract and a CI-built artifact both just work.
    let root = engine_dir.clone();
    let bin = engine_dir.join("bin");
    let libdir = if bin.join("obs.dll").exists() {
        bin
    } else if root.join("obs.dll").exists() {
        root
    } else {
        println!(
            "cargo:warning=no obs.dll under {} or its bin/; building without live support",
            engine_dir.display()
        );
        return;
    };

    println!("cargo:rustc-cfg=have_engine");
    println!("cargo:rustc-link-search=native={}", libdir.display());

    // NO link-lib directive for obs here, deliberately. Cargo's build-script
    // protocol has no `raw-dylib` kind — it is a SOURCE attribute — so the
    // linkage lives on the extern blocks in src/live/ffi.rs instead. See the
    // note there: an extracted OBS release ships obs.dll with no obs.lib, and
    // raw-dylib is what lets a downloaded release double as a dev engine.
    //
    // The link-search above still matters: it is how the DLL is found.

    // The Win32 half of shim.m. Same exported symbols, so ffi.rs is unchanged;
    // see src/live/shim_win.c for what is real and what is a deliberate no-op.
    println!("cargo:rerun-if-changed=src/live/shim_win.c");
    cc::Build::new()
        .file("src/live/shim_win.c")
        .compile("producer_live_shim");
    // User32/Gdi32: the preview child HWND. Ole32: COM init for the DirectShow
    // device enumeration the camera picker uses.
    println!("cargo:rustc-link-lib=dylib=user32");
    println!("cargo:rustc-link-lib=dylib=gdi32");
    println!("cargo:rustc-link-lib=dylib=ole32");
}
