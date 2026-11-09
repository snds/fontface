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

## Updates

Fontface updates itself through Sean's shared update kit
([snds/app-updates](https://github.com/snds/app-updates)). Every push to `main` is published as
the rolling `fontface-main` pre-release on [snds/releases](https://github.com/snds/releases/releases/tag/fontface-main).
Fontface checks at launch and every six hours, downloads a newer build quietly, checks its
signature, and offers **Restart to update** (or installs it when you quit). Settings › About has
**Check for updates**, **Reload app** and the **Check for updates automatically** switch; on macOS
the app menu has **Check for Updates…** too.

The public key is committed as `src-tauri/updater.pub` (key ID `A22605A6D757D9B7`); a build without
that file says "Updates are off in this build: it was made without the update key." To turn
publishing on:

1. The key: made once with `npx tauri signer generate -w ~/.tauri/fontface.key`. Keep the secret
   half in your password manager; commit only the `.pub` as `src-tauri/updater.pub`.
2. In this repo's Actions secrets, add `TAURI_SIGNING_PRIVATE_KEY` (the secret key file's
   contents), `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and `RELEASES_TOKEN` (a token that can write
   releases on snds/releases).
3. That's all: CI's `release-main` job (`.github/workflows/ci.yml`) publishes each push to `main`
   once the secrets are there. Until then it's a dry run that says which secret is missing.
   snds/releases needs at least one commit (a README) before its first release.

Builds made locally (`npm run tauri build`) carry the version `0.1.0` and don't check for updates:
only CI's `0.1.0-main.<time>` builds follow the main channel.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it fits together, and the Windows plan
- [docs/FEATURES.md](docs/FEATURES.md): phased feature plan and parity checklist
- [docs/SYNC.md](docs/SYNC.md): syncing tags and on/off choices between your computers through a folder
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md): cloud font services (Google Fonts, Adobe Fonts and others): what's allowed and the plan

## Licence

Fontface is licensed under the [Apache License 2.0](LICENSE). [NOTICE](NOTICE) lists the parts that come from other projects.
