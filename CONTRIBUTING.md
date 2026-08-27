# Contributing to Producer

Thanks for being here. Producer is early and moving fast — small, focused
PRs land quickest.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- [Rust](https://rustup.rs) stable (via rustup)
- **Windows**: Visual Studio Build Tools (Desktop development with C++) and
  the WebView2 runtime (preinstalled on Windows 11 / recent Windows 10)
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: `libwebkit2gtk-4.1-dev build-essential curl wget file
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`

## Development loop

```sh
bun install
bun run tauri dev    # full app (Rust + webview, hot reload)
bun run dev          # frontend only, in a browser tab
```

Before pushing:

```sh
bun run build                  # typecheck + frontend build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Where help is wanted

The platform senders are the heart of the roadmap — each one (YouTube, X,
TikTok, …) is a well-scoped module behind a common publish-job interface.
Check issues labeled `good first issue` and `platform-sender`.

## Ground rules

- One change per PR; describe the user-visible effect in the first line.
- No secrets in code, config, or tests — ever. CI greps for it.
- Match the style of the file you're editing.
