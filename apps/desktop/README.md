# apps/desktop

The Herald OS shell, built on Electron. Its renderer draws everything you see in Herald OS: the menu
bar, dock, windows, launcher and Herald's own apps. Setup is in the
[root README](../../README.md); how the pieces talk to each other is in
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md); conventions for pages are in
[DESIGN.md](DESIGN.md).

## Layout

```
electron/              Electron main: owns the machine
  main.ts              entry: data migration, single-instance lock, windows, IPC, backend
  backend/             finds the Hermes install, spawns `hermes serve`, restarts it, forwards REST
  ipc/                 IPC handlers: files, apps, system stats, terminals, voice, web views, editing
  platform/            HostPlatform per OS: darwin.ts, linux.ts, win32.ts; generic.ts elsewhere
  shell/               shell modes, panels-mode windows, control socket, notification daemon
  wm/                  niri compositor IPC (Linux panels mode)
preload/index.ts       the `window.heraldOS` bridge, the renderer's only way to reach main
shared/                types shared by main, preload and renderer (IPC contract, voice settings),
                       and the translations (i18n.ts, locales/)
src/                   React renderer
  main.tsx             entry
  shell/               the desktop: ShellRoot, app registry, menu bar, dock, command bar, boot screen
    wm/                window frame for floating apps
    surfaces/          panels-mode surfaces (one Electron window each under niri)
  features/<app>/      one folder per page or app: hermes (chat), missions, memory, files, studio...
  commands/            the OS command catalogue (what the command bar, voice and Hermes can run)
  store/               nanostores state and actions (gateway, chat, windows, voice...)
  lib/                 pure helpers, unit-tested next to the code (`*.test.ts`)
  components/          shared UI primitives and the two brand marks
public/                served as-is: favicon, audio-capture worklet
build/                 app icons and macOS entitlements for electron-builder
scripts/               bundle-electron.mjs (esbuild for main and preload), after-pack.mjs (electron-builder hook), check-mac-signing-config.mjs (release check)
```

## Scripts

Run them here, or from the repository root (`npm run dev`, `npm run build`, `npm test`, ...).

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite on `127.0.0.1:5180` plus Electron; renderer edits reload live, main edits need a restart |
| `npm run build` | Renderer into `dist/renderer`, main and preload into `dist/electron` |
| `npm start` | Build, then run the built app |
| `npm run typecheck` | `tsc` for the renderer and for main and preload |
| `npm test` | Vitest over `src`, `electron`, `shared` and `scripts` |
| `npm run dist:mac` | Apple Silicon (`-mac-arm64`) and Intel (`-mac-x64`) DMGs and zips in `release/` (unsigned); `node scripts/check-mac-builds.mjs` checks every Mach-O in each app against its architecture |
| `npm run pack:mac` | The packaging half of `dist:mac`, on an existing `npm run build`; the release workflow signs here ([MACOS-SIGNING.md](../../docs/MACOS-SIGNING.md)) |
| `npm run dist:linux` | `herald-os-<version>-linux-<arch>.tar.gz` in `release/` for this machine's architecture (`-- --x64` or `-- --arm64` to pick), with the Linux CLIs, session, themes, catalog and bridge plugin in `resources/` |

## Common changes

- **A page or app.** Follow [DESIGN.md](DESIGN.md): register it in `src/shell/apps.ts`, put it in
  `src/features/<name>/`, mount pages in `src/shell/MainWindow.tsx`.
- **An action users or Hermes can trigger.** Register an `OsCommand` in `src/commands/<area>.ts`.
  The command bar, the voice fast path and the agent's `os_ui` tool all pick it up.
- **Text people read.** Add it to `shared/locales/en.ts` and show it with `t` from `useT()`
  (`src/store/i18n.ts`); [docs/TRANSLATING.md](../../docs/TRANSLATING.md) has the details.
- **A native capability.** Add it to `HostPlatform` (`electron/platform/types.ts`), implement it in
  each platform file, handle it in `electron/ipc/`, expose it in `preload/index.ts` and type it in
  `shared/ipc.ts`.

## Windows evaluation build

The explicit Hermes root and managed install retain priority. For PATH discovery on Windows,
Herald checks every existing search directory for `hermes.exe` before checking the same directories
for `hermes-canary.exe`, the registered Windows launcher alias. Directory order is preserved for
each name. The selected path is passed directly as an executable; a launch failure does not switch
to another candidate. On Windows x64, an accessible alias whose protected target rejects the
ordinary file check can also qualify through its own reparse-point metadata: the existing Koffi
binding opens the local drive path with `FILE_READ_ATTRIBUTES` and `OPEN_REPARSE_POINT`, requires
the exact `IO_REPARSE_TAG_APPEXECLINK` tag on a non-directory, and closes the handle. This fallback
does not follow or execute the target; any native failure rejects the candidate. Discovery does
not verify package signatures, current registration or future launch success. It does not install
a runtime or choose credentials, a provider or a model. No package-version path is pinned, so
Hermes can update the alias target through its own installer.

Windows Files and Explorer reveal accept local drive paths only; manually entered UNC and device
paths are refused before filesystem or shell access. This lexical check does not establish that
mapped drives or reparse links cannot reach a network location.

Run `npm run dist:win` on Windows x64 to build an unsigned per-user NSIS candidate in `release/`.
The command neither installs nor launches it. Windows uses Node 22, existing node-pty/ConPTY and
a Windows-only Koffi binding for protected control pipes. Preserve the unpacked native payloads,
bridge, license resources and Office package exclusions when changing packaging.

PowerShell/CIM diagnostics use bounded constant commands without changing execution policy.
The native pipe tests require `HERALD_TEST_PYTHON` to identify a Windows x64 Python interpreter.
Set it only for that test invocation; unrelated Office validator tests interpret that variable too.
The Windows CI job lists its affected-scope tests explicitly and does not claim full-suite coverage.

An unsigned candidate is not an installation recommendation. Packaged GUI behavior, native module
loading, Start menu/restart behavior, install/upgrade/uninstall, signing and application-control
compatibility need separate checks. Do not disable Windows security policies to turn a blocked
check into a pass. The Windows release job is manual, does not attach candidates to tagged releases,
and has a separate artifact-upload input. Existing macOS/Linux release jobs retain their behavior.
