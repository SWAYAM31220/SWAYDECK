# Security Policy

## Supported versions

SwayDeck is in public beta. Only the latest `0.1.x` release of each part is
supported with security fixes:

| Part | Version | Supported |
| --- | --- | --- |
| SwayDeck agent (`swaydeck-agent`) | 0.1.x | Yes |
| SwayDeck Bridge (`swaydeck-vscode`) | 0.1.x | Yes |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately using either:

- GitHub's **private security advisories** on the repository
  (`Security` → `Report a vulnerability`), or
- email **swayamsujjal@gmail.com**.

Please include what you did, what happened, the affected part and version, and any
proof-of-concept or logs. We aim to acknowledge reports within a few days and to
keep you updated while we work on a fix.

## Threat model

SwayDeck assumes a single trusted user on a single Windows PC, with the phone
attached over USB.

**In scope / defended against**

- **Anyone else on the network.** The agent binds `127.0.0.1` only and is never
  exposed to the LAN. The phone reaches it only through the USB `adb reverse`
  tunnel.
- **Unauthenticated clients.** Every connected client (phone and extension) must
  present the shared pairing token; comparison is timing-safe, and repeated
  failures trigger a lockout (5 failures in 60 seconds).
- **A malicious web page in the phone's browser.** `/ws` only accepts connections
  from the local origin, and `/ext` only accepts non-browser clients, so a page
  cannot drive the deck or impersonate the extension.
- **Command injection from the phone.** The phone can only request actions on a
  fixed allowlist. Actions spawn fixed executables (`shell: false`) or run one
  fixed PowerShell snippet with integer key codes; no phone-supplied text becomes
  part of a command.
- **Accidental secret exposure through clipboard sync.** Sync is off by default,
  snippets live in memory only, and text that looks like a secret is skipped.

**Explicitly out of scope**

- A local attacker who already runs code as your Windows user, or who can read the
  `.swaydeck-token` file.
- Physical access to an unlocked, already-paired phone.
- Anyone who obtains the pairing token itself (it is the whole shared secret).
- Other devices on your LAN trying to reach the agent — they can't; it only listens
  on loopback.

## Scope of what's collected

SwayDeck collects nothing and sends nothing off your PC. There is no telemetry, no
account, and no analytics. The agent reads local system stats and (only when you
enable it) the Windows clipboard, and keeps both in memory.
