# SwayDeck Bridge

**SwayDeck Bridge** is the VS Code half of [SwayDeck](https://github.com/SWAYAM31220/swaydeck).
It connects VS Code to the **local SwayDeck PC agent** so your phone can see which
project is open and start it from the deck.

It detects the active workspace (project type, trust state, active file) and reports
it to the agent, and it can **run the detected project** — by sending the fixed
command `npm run dev` or `python main.py` to a VS Code terminal, or by starting a
local static server for a plain HTML project. It only ever runs the detected dev
command, and only in a **trusted** workspace.

> The extension needs the PC agent running. It does nothing on its own and never
> talks to the internet.

## Requirements

- The **SwayDeck agent** running on the same PC (`swaydeck-agent`, listening on
  `127.0.0.1:3000`).
- VS Code **1.85.0 or newer**.
- For running Node projects: `npm` on PATH and dependencies already installed.
- For running Python projects: `python` on PATH.
- The phone paired with the same token as the agent.

## How to pair

1. Start the agent on the PC (`npm start` in `swaydeck-agent`) and pair your phone
   (`npm run pair`) — the agent prints your pairing token.
2. In VS Code, run **SwayDeck: Set Pairing Token** and paste the token. It is stored
   in VS Code's **SecretStorage** (never in settings, never logged).
3. The status bar shows **SwayDeck: Connected** once the agent answers, and the
   **Project** screen on the phone shows your workspace.

If no token is stored, the extension does not connect: the status bar shows
**Not paired** and (once per session) a notification offers to set it.

## Settings

- `swaydeck.agentUrl` — WebSocket URL of the local agent. Default:
  `ws://127.0.0.1:3000/ext`.
  Only `ws://` URLs whose host is exactly `127.0.0.1` or `localhost` are accepted;
  anything else is refused and an error is logged.

## Commands

| Command | What it does |
| --- | --- |
| `SwayDeck: Set Pairing Token` | Password input box; stores the token in SecretStorage. |
| `SwayDeck: Reconnect` | Forces an immediate reconnect. |
| `SwayDeck: Show Workspace Info` | Writes the detected workspace JSON to the `SwayDeck` output channel. |
| `SwayDeck: Show Status` | Shows the current connection state. |
| `SwayDeck: Run Project` | Runs the detected project locally (same code path the phone triggers), and reports the outcome. |
| `SwayDeck: Stop Static Server` | Stops the built-in static server started for the current workspace. Live Server is never touched. |

The left status bar item shows `Connected`, `Offline`, `Not paired`, `Pairing
rejected` or `Standby`. Clicking it runs **SwayDeck: Show Status**.

### Multiple VS Code windows

Only one window can control the deck at a time. When a second window connects, the
agent closes the older socket (close code `4003`) and that window shows **Standby**
— it stops retrying until you focus it, at which point it takes over.

## Privacy

- The extension connects **only** to the local SwayDeck agent at
  `127.0.0.1` / `localhost`. A non-loopback URL is refused.
- **No telemetry, no analytics, no data sent anywhere.** Nothing is uploaded, and
  no remote service is contacted.
- What it reports to the agent is just the workspace summary: project name, path,
  workspace folders (name and path), trust state, project type, which of
  `package.json` / `main.py` / `index.html` exist, whether a `dev` script exists,
  and the **basename** of the active file. File contents, full paths of open files
  and environment variables are never sent.
- The **pairing token** is stored in VS Code's SecretStorage and is never logged or
  displayed.

## Security

- **Only the detected dev command is run**, as the fixed literals `npm run dev` or
  `python main.py`. No command is ever built from an agent message, `package.json`
  content, or a file name, and `npm install` is never run for you.
- **Only in a trusted workspace.** In an untrusted workspace the extension reports
  the workspace but refuses to run anything ("This workspace is not trusted.").
- The built-in static server (fallback for `static` projects) binds `127.0.0.1`
  only, answers only `GET`/`HEAD`, checks the `Host` header, refuses dot-files and
  `node_modules`, and keeps every served file inside the workspace root.

See the root [SECURITY.md](https://github.com/SWAYAM31220/swaydeck/blob/main/SECURITY.md)
for the full threat model.

## License

[MIT](LICENSE)
