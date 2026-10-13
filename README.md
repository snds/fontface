# Fontface

A subscription-free font manager for macOS (Windows planned). Tauri 2 + Rust + React.

It reads fonts where they live and turns them on or off for all apps, with no copying, no
account and no paywall.

## Run it

Needs Node 20+ and Rust (`rustup`).

```bash
npm install
npm run tauri dev        # development, with hot reload
npm run tauri build      # produces src-tauri/target/release/bundle/macos/Fontface.app
```

## Test

```bash
cd src-tauri && cargo test                                              # parsing + collection extraction
cd src-tauri && cargo test activation_round_trip -- --ignored --nocapture  # real CoreText on/off
npm run typecheck
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it fits together, and the Windows plan
- [docs/FEATURES.md](docs/FEATURES.md): phased feature plan and parity checklist
- [docs/SYNC.md](docs/SYNC.md): syncing tags and on/off choices between your computers through a folder
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md): cloud font services (Google Fonts, Adobe Fonts and others): what's allowed and the plan
