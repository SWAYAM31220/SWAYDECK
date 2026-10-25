# Changelog

All notable changes to SwayDeck are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-23

First public beta.

### Added

- **SwayDeck agent** (`swaydeck-agent`): local-only Node.js server on
  `127.0.0.1:3000` that pairs a phone over USB (`adb reverse`) with a shared token.
  - PC control actions: Calculator, Chrome, VS Code, open current project in
    VS Code, volume up/down/mute, media play/pause/next/previous, lock and sleep.
  - System monitor: CPU, memory, uptime and CPU temperature (temperature is `N/A`
    when no readable sensor exists).
  - Clipboard snippets: opt-in, in-memory only, skips likely secrets.
  - `npm run pair`: checks for `adb`, runs `adb reverse tcp:3000 tcp:3000` and opens
    the pairing link on the phone.
  - Fullscreen landscape PWA UI installable from Chrome.
- **SwayDeck Bridge** (`swaydeck-vscode`): VS Code extension that detects the active
  workspace and project type, reports it to the agent, and can run the project
  (fixed `npm run dev` / `python main.py` in a trusted workspace) or a static
  server from the phone.
- Repository hygiene: `.gitignore`, MIT `LICENSE`, `SECURITY.md`,
  `CONTRIBUTING.md`, issue templates and docs.

### Known limitations

- Windows-only PC actions; USB-only pairing.
- Sleep may hibernate if hibernation is enabled (`powercfg -h off` to disable).
- No volume level or now-playing information.

[0.1.0]: https://github.com/SWAYAM31220/swaydeck/releases/tag/v0.1.0
