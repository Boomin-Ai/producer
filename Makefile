.PHONY: setup dev check check-macos-engine

# Bun >=1.3, stable Rust and macOS Command Line Tools are prerequisites.
setup:
	bun install --frozen-lockfile
	bash scripts/prepare-macos-engine.sh

dev:
	bash scripts/dev.sh

check:
	bun run build
	bash scripts/check-macos-engine.sh "$$(bash scripts/prepare-macos-engine.sh --print-path)"
	PRODUCER_ENGINE_DIR="$$(bash scripts/prepare-macos-engine.sh --print-path)" PRODUCER_REQUIRE_ENGINE=1 cargo check --manifest-path src-tauri/Cargo.toml --features guest-rtc-production

check-macos-engine:
	bash scripts/check-macos-engine.sh "$$(bash scripts/prepare-macos-engine.sh --print-path)"
