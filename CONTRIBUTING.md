# Contributing to SwayDeck

Thanks for taking a look. SwayDeck is a small two-part project, and short, focused
changes are easiest to review.

## Setup

Requirements: Windows 10/11, Node.js 18 LTS or newer, and (for pairing) Android
platform-tools with `adb` on PATH.

```powershell
# Agent
cd swaydeck-agent
npm install

# VS Code extension
cd ..\swaydeck-vscode
npm ci
npm run compile
```

## Running both parts

```powershell
# Terminal 1 - agent (serves the phone UI, prints the pairing command)
cd swaydeck-agent
npm start

# Terminal 2 - extension: open swaydeck-vscode/ in VS Code and press F5
# (an Extension Development Host window opens with SwayDeck Bridge loaded)
```

Then pair the phone with `npm run pair` (or the two `adb` commands the agent
prints) and open the pairing URL on the phone.

## Code style

- **TypeScript** for the extension (`strict` is on; `noUnusedLocals` /
  `noUnusedParameters` are on — please keep both clean).
- **Plain CommonJS** for the agent, no build step.
- Match the surrounding style; keep functions small and keep the security comments
  that explain *why* something is done a certain way.
- Two-space indentation, double quotes, and semicolons are already the norm here.

## Pull requests

- One change per PR, with a short description of the "why".
- Keep the **security invariants** intact: the agent stays on `127.0.0.1`, the
  phone only gets the fixed action allowlist, no phone text ever becomes a command,
  and the extension only sends the two fixed command literals in a trusted
  workspace.
- If you change the port, the pairing flow, or the agent/extension protocol, update
  the root `README.md` (and the extension `README.md`) in the same PR so the docs
  match the code.
- Run `npm run compile` in `swaydeck-vscode/` before opening the PR.

## Reporting security issues

Please do not open a public issue — see [SECURITY.md](SECURITY.md).
