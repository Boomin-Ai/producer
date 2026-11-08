# Intel macOS development

The public Intel installer through 0.4.87 intentionally omits the live engine.
The normal UI-only build therefore cannot request native capture permissions,
open a live room, record, or install the virtual camera.

Use the extracted-engine development path on an Intel Mac with Command Line
Tools, stable Rust and Bun installed:

```sh
bun install --frozen-lockfile
PRODUCER_ENGINE_PACK=0 bash scripts/extract-engine.sh
bash scripts/dev.sh
```

Extraction verifies the official Intel OBS 32.1.2 image against
`engine/macos-intel-fallback.json`, checks the source lock version, compiles
Producer's patched Metal backend, Qt-free browser plugin and helper apps, and
builds both camera-extension bundles for the host architecture. The Intel pin
is separate so the existing release engine lock identity stays unchanged.
Engine selection and app linkage reject an incompatible architecture.

If a build sandbox cannot mount disk images, open the verified image in
Finder and supply `PRODUCER_OBS_CONTENTS=/Volumes/<image>/OBS.app/Contents`.
Set `PRODUCER_METAL_COMPILE_ONLY=1` only when GPU tests cannot run in the build
environment. `metal-tested.json` records that those tests remain unverified.
Compilation alone does not qualify Metal rendering.

On the physical Intel Iris Plus Graphics 645 Mac running macOS 15.7.3,
the initial 0.4.88 dev bundle bootstrapped every required engine module and
displayed live camera video. Metal initialization failed and the engine used
OpenGL with software x264 encoding; the video reset phase took 64.8 seconds.
Hardware encoding, Metal, recording, streaming and external virtual-camera
frames are not qualified by this camera-input check.

An ad-hoc local bundle can run the engine and request capture permissions,
but cannot install its camera system extension. A working install requires
the existing Producer Developer ID identity, camera provisioning profile,
hardened runtime entitlements, notarization, and an app under `/Applications`.
The `Signed Intel development candidate` workflow produces a separate,
signed/notarized Actions artifact and does not publish a release or update
the public updater manifest. It runs the existing camera-pair/signing gates.
The signed candidate still needs physical virtual-camera acceptance in a
second application after the user approves macOS's extension prompt.

Physical acceptance on 2026-11-08: installed the Developer ID-signed,
Apple-notarized `caca7a9` candidate as `/Applications/Producer Intel Dev.app`.
Enabled its camera extension in macOS General → Login Items & Extensions →
Camera Extensions. Producer reported `Cam on`; selecting Producer Virtual
Camera in Photo Booth displayed live video. This verifies camera input and
external virtual-camera video on this Intel Mac. Microphone permission was
still ungranted; audio, recording, streaming and Metal remain separate checks.
The Actions run accepted notarization and stapled the app, but failed its
subsequent online ticket validation because Apple's connection dropped. The
preserved accepted archive passed local signature and provisioning checks;
macOS successfully activated its extension. Local sandboxed `stapler` and
Gatekeeper CLI checks could not access Launch Services, so no claim is made
that the downloaded archive carries an offline ticket.
