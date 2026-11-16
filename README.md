# Herald OS for Windows

A Windows 11 port of [Herald OS](https://github.com/iamlukethedev/Herald-OS) by Luke The Dev (@iamlukethedev). Herald OS is an agent-native desktop shell for [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research.

- **Windows port and German localization:** Dragon Lucky Eagle Origin
- **Original project and design:** Herald OS by Luke The Dev
- **License:** MIT (see `LICENSE`; third-party notices in `THIRD_PARTY_NOTICES.md`)
- **Price:** free

This is an independent community port. It is not an official release of the upstream Herald OS project. The port is offered to Luke for future official maintenance. That depends on his acceptance, which has not been given yet.

## What it does on Windows

- Runs the Herald OS shell as a native Windows 11 x64 desktop app.
- Uses a German or English interface, switchable in Settings.
- Attaches to a Hermes Agent that is already running on the same PC. Herald never starts, installs or modifies Hermes.
- Supports both Hermes host modes on Windows:
  - the Hermes server host (`hermes-host-v1`)
  - the Hermes Desktop host (`hermes-desktop-host-v1`)

## Requirements

- Windows 11, x64.
- Hermes Agent for Windows (Hermes Stable package `NousResearch.HermesBundled` 2026.6864.2132.0 or newer), installed and running for the same Windows user.
- A protected local connection policy at `%USERPROFILE%\DRAGON_OS\connection-policy.json`. The folder name is part of a fixed, shared connection contract. At normal start Herald only reads this file. Only the explicit enrollment command creates it, and it never overwrites an existing policy.
  - With the Hermes server host, create it once by running `"Herald OS.exe" --enroll-windows-v3`.
  - With the Hermes Desktop host, Herald can use an existing Desktop-host policy. Herald cannot create one itself yet (see Known limitations).

## Install

1. Download `HeraldOS-0.1.5-win-x64-Setup.exe` and `HeraldOS-0.1.5-win-x64-Setup.exe.sha256` from the release.
2. Check the hash in PowerShell:
   ```powershell
   (Get-FileHash .\HeraldOS-0.1.5-win-x64-Setup.exe -Algorithm SHA256).Hash
   ```
   It must equal `9DEC330B9E70A8C8B35731ADB0168C837DDFF4EF7DC203D0EFD7018DE20B4AB9`.
3. Quit Herald OS if it is running. The installer stops rather than closing the app for you.
4. Run the installer. It installs per user and does not need administrator rights.

The installer is **not code-signed**. Windows SmartScreen or Smart App Control may warn about it or block it.

For update, uninstall and rollback steps, see `docs/release/INSTALL_AND_ROLLBACK.md`.

## Known limitations

- The installer is unsigned.
- If Hermes is offline for more than two minutes after Herald starts, Herald stops trying. Click **Retry** when Hermes is back.
- Herald cannot yet create a Desktop-host connection policy itself. Enrollment writes only server-host policies.
- When Herald and another client of the same shared contract run for one Windows user, they share `%LOCALAPPDATA%\Hermes-Stable\herald-os\notifications.json`.
- Tested on one Windows 11 machine with Hermes Desktop host, accepted by the owner. It has not been tested on further machines or through two successive updates.

## Build from source

Use Node.js 22.12 or newer and the npm workspaces in this repository:

```powershell
npm ci
npm run typecheck
npm run build
cd apps/desktop
npx electron-builder --config build/windows.cjs --win nsis --x64 --publish never
```

## Credits

- **Herald OS:** Luke The Dev (@iamlukethedev), MIT.
- **Hermes Agent:** Nous Research, MIT.
- **Windows port and German localization:** Dragon Lucky Eagle Origin.

## App ID note
This Windows port uses the upstream App ID `dev.iamluke.heraldos`. An official upstream Windows build with the same App ID would install over this one (and the other way round). Coordination with the upstream author is in progress.
