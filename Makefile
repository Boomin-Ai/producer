.PHONY: setup dev check check-macos-engine

# Native cc-rs module caches must be writable in sandboxed Mac checkouts too.
export CLANG_MODULE_CACHE_PATH ?= $(CURDIR)/src-tauri/target/clang-modules
export CC_SHELL_ESCAPED_FLAGS := 1
override CFLAGS += -fmodules-cache-path="$(CLANG_MODULE_CACHE_PATH)"
override CXXFLAGS += -fmodules-cache-path="$(CLANG_MODULE_CACHE_PATH)"
export CFLAGS CXXFLAGS

# Bun >=1.3, stable Rust and macOS Command Line Tools are prerequisites.
setup:
	bun install --frozen-lockfile
	bash scripts/prepare-macos-engine.sh

dev:
	bash scripts/dev.sh

check:
	bun run build
	bash scripts/check-macos-engine.sh "$$(bash scripts/prepare-macos-engine.sh --print-path)"
	mkdir -p "$(CLANG_MODULE_CACHE_PATH)"
	PRODUCER_ENGINE_DIR="$$(bash scripts/prepare-macos-engine.sh --print-path)" PRODUCER_REQUIRE_ENGINE=1 cargo check --manifest-path src-tauri/Cargo.toml --features guest-rtc-production

check-macos-engine:
	bash scripts/check-macos-engine.sh "$$(bash scripts/prepare-macos-engine.sh --print-path)"
