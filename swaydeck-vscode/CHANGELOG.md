# Changelog

## [0.1.0] - 2026-10-23

First public beta.

### Added

- Connects to the local SwayDeck PC agent (`ws://127.0.0.1:3000/ext`) using a
  pairing token stored in VS Code SecretStorage.
- Detects the active workspace: project type (`node`, `python`, `static`,
  `ambiguous`, `unknown`, `none`), workspace folders, trust state, and the active
  file's basename — and reports it to the agent.
- Reports the workspace again on request (`get_workspace`) and after changes
  (debounced, triggered by workspace/editor/trust changes and root-file changes).
- Runs the detected project from the deck: the fixed `npm run dev` or
  `python main.py` in a VS Code terminal (trusted workspaces only), or a local
  static server (Live Server if available, otherwise a built-in server on
  `127.0.0.1`, ports 5600-5610) for plain HTML projects.
- Status bar item and commands: Set Pairing Token, Reconnect, Show Workspace Info,
  Show Status, Run Project, Stop Static Server.
- Standby handoff so only one VS Code window controls the deck at a time.

[0.1.0]: https://github.com/SWAYAM31220/swaydeck/releases/tag/v0.1.0
