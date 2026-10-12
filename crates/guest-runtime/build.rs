fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // LiveKit's WebRTC Objective-C categories must survive static linking.
        println!("cargo:rustc-link-arg=-ObjC");
    }
}
