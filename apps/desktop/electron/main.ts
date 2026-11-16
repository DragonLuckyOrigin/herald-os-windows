import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Notification, protocol, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type EnvInfo, type HeraldOSPrefs, IPC, type PrefsPatch, type RestRequest, type ShellCommand, type WindowState } from '../shared/ipc.ts'
import { BackendManager } from './backend/manager.ts'
import { assertBackendSender, registerBackendTransport } from './ipc/backend-transport.ts'
import { reverseControlDisabled, enrollWindowsV3 } from './backend/coexist.ts'
import { forgetInheritedSession } from './backend/session-env.ts'
import { CrashWatcher } from './crash/watch.ts'
import { mayOpenExternally } from './external-url.ts'
import { fireEventAutomations } from './events/automations.ts'
import { events } from './events/bus.ts'
import { runHooks } from './events/hooks.ts'
import { run } from './platform/exec.ts'
import { startEventSources } from './events/sources.ts'
import { registerAppsIpc } from './ipc/apps.ts'
import { registerBridgeIpc } from './ipc/bridge.ts'
import { registerCanvasIpc } from './canvas/ipc.ts'
import { registerModelIpc } from './canvas/model-ipc.ts'
import { registerOfficeIpc } from './office/ipc.ts'
import { MODEL_SCHEME } from '../shared/canvas/models.ts'
import { registerCaptureIpc } from './ipc/capture.ts'
import { registerControlsIpc } from './ipc/controls.ts'
import { registerCatalogIpc } from './ipc/catalog.ts'
import { registerSetupIpc } from './ipc/setup.ts'
import { PluginHost } from './plugins/host.ts'
import { registerDictationIpc } from './ipc/dictation.ts'
import { registerContextIpc } from './ipc/context.ts'
import { registerFsIpc } from './ipc/fs.ts'
import { registerSystemIpc } from './ipc/system.ts'
import { registerTerminalIpc } from './ipc/terminal.ts'
import { registerThemeIpc, syncHermesSkin } from './ipc/theme.ts'
import { applyVoiceHotkey, registerVoiceIpc } from './ipc/voice.ts'
import { registerEditIpc } from './ipc/edit.ts'
import { registerWebIpc } from './ipc/web.ts'
import { systemLanguages } from './i18n.ts'
import { log, logTail } from './log.ts'
import { migrateLegacyData, type MigrationResult } from './migrate.ts'
import { registerNotificationHistoryIpc } from './notifications-history.ts'
import { registerPetIpc } from './pet/ipc.ts'
import { PetWindow } from './pet/window.ts'
import { SwitchService } from './switches.ts'
import { hermesHome, heraldOsDataDir, isDev } from './paths.ts'
import { readPrefs, writePrefs } from './prefs.ts'
import { handleAdoptLegacyNotify, sendPrefsToOthers } from './prefs-ipc.ts'
import { forwardRendererConsole } from './renderer-console.ts'
import { isOmarchy, readOmarchyTheme } from './theme/omarchy.ts'
import { prefsForTheme } from './theme/themes.ts'
import { ControlSocket } from './shell/control-socket.ts'
import { DesktopHost, type ShellHost } from './shell/host.ts'
import { shellMode } from './shell/mode.ts'
import { createCompositor, detectCompositor } from './wm/compositor.ts'
import { NotificationDaemon } from './shell/notification-daemon.ts'
import { handleUiRequest, OsCommandBridge, OsControlServer, osControlToken } from './shell/os-control.ts'
import { PanelShell } from './shell/panels.ts'
import { registerBrandingIpc } from './shell/branding.ts'
import { EmojiPanel } from './shell/emoji-panel.ts'
import { registerMenuExtensionsIpc } from './shell/menu-extensions.ts'
import { registerServiceIpc } from './shell/services.ts'
import { WallpaperService } from './shell/wallpaper.ts'
import { appIconPath, createMainWindow } from './window.ts'

app.setName('Herald OS')
if (process.platform === 'win32') {
  app.setAppUserModelId('dev.iamluke.heraldos')
  // Electron 44 setPath overrides without creating the directory. Bind the same profile before
  // singleton acquisition in installed and HMR runs; only one may own it at a time.
  app.setPath('userData', path.join(app.getPath('appData'), 'Herald OS'))
}
// Chromium turns WebGL off where it does not accelerate the graphics (virtual machines, drivers it
// blocklists), and Herald Canvas draws with WebGL: there it falls back to SwiftShader, Chromium's
// software renderer, rather than to nothing. Machines it accelerates are not affected.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
}
// Widget plugins load from herald-plugin://<id>/, Canvas's verified models from herald-model://<model>/
// (registered before the app is ready, as Electron requires).
protocol.registerSchemesAsPrivileged([
  { scheme: 'herald-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: MODEL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

// Observe before the singleton creates its native ownership artifact. Reading is not migration;
// only the successful owner may write data, log, register hooks or start services.
const userData = app.getPath('userData')
let userDataWasEmpty = false
let profileInspectionError: unknown
if (!isDev) {
  try { userDataWasEmpty = fs.readdirSync(userData).length === 0 } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') userDataWasEmpty = true
    else profileInspectionError = error
  }
}
const enrollmentRequested = process.argv.includes('--enroll-windows-v3')
const primaryInstance = app.requestSingleInstanceLock({ windowsV3Enrollment: enrollmentRequested })
if (enrollmentRequested) {
  if (process.platform !== 'win32' || !primaryInstance || profileInspectionError) {
    console.error('Herald OS: Windows V3 enrollment refused; native profile and exclusive ownership are required.')
    app.exit(1)
  } else {
    void app.whenReady().then(() => enrollWindowsV3()).then(
      () => app.exit(0),
      () => { console.error('Herald OS: Windows V3 enrollment failed; no automatic repair or normal startup.'); app.exit(1) }
    )
  }
} else {
// Normal desktop startup remains separate from enrollment.
const migration: MigrationResult | null = primaryInstance
  ? profileInspectionError
    ? { status: 'blocked', messages: [], error: 'The native profile could not be inspected before ownership.' }
    : process.platform === 'win32'
      ? { status: 'skipped', messages: ['Legacy migration skipped for the standalone Herald Windows client.'] }
      : migrateLegacyData({ hermesHome: hermesHome(), appData: app.getPath('appData'), userData, userDataWasEmpty, isDev })
  : null
const startupAllowed = primaryInstance && migration?.status !== 'blocked'

process.on('uncaughtException', error => {
  if (startupAllowed) log('main', `uncaught exception: ${error.stack ?? error.message}`)
})
if (startupAllowed) {
  forwardRendererConsole()
  // Child processes must not inherit the launching Hermes conversation's session identity.
  for (const name of forgetInheritedSession()) log('main', `dropped the inherited ${name}`)
  for (const line of migration?.messages ?? []) log('migrate', line)
}
const backend = new BackendManager()
let mainWindow: BrowserWindow | null = null
const mode = shellMode()
// Panels mode (niri): several surface windows, compositor state mirror, control socket for hotkeys.
const panels = mode === 'panels' ? new PanelShell(win => attachMainWindow(win)) : null
const wallpaper = panels ? new WallpaperService(panels) : null
// Panels mode: the desktop pet is a window of its own, which main moves through niri.
const petWindow = panels ? new PetWindow(panels) : null
// The agent's `os_ui` tool and the CLI run registry commands in the Hermes window through this bridge.
const osBridge = new OsCommandBridge(() => (panels ? panels.mainWindow() : mainWindow))
const plugins = new PluginHost(
  () => BrowserWindow.getAllWindows(),
  () => (panels ? panels.mainWindow() : mainWindow),
  osBridge
)
/** Preferences changed outside a renderer (the CLI, a theme): every window and the wallpaper follow. */
function broadcastPrefs(next: HeraldOSPrefs): void {
  wallpaper?.apply(next.wallpaper)

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.prefsChanged, next)
  }
}

const switches = new SwitchService({
  session: Boolean(panels),
  getWindows: () => BrowserWindow.getAllWindows(),
  onPrefs: broadcastPrefs,
  showScreensaver: () => mainWindow?.webContents.send(IPC.shellCommand, { type: 'screensaver' } satisfies ShellCommand)
})
// Linux without the panels session: Herald as an app inside Hyprland or Omarchy, or the cage kiosk.
// The `herald-os` CLI (and so the compositor's hotkeys) reaches the one window through the same socket.
const appHost = !panels && process.platform === 'linux' ? new DesktopHost(() => mainWindow, createCompositor(detectCompositor())) : null
// macOS: Cmd+Ctrl+E opens the emoji picker over any app (Herald OS Linux binds it in niri).
const emojiPanel = !panels && process.platform === 'darwin' ? new EmojiPanel(() => mainWindow) : null
const shellHost: ShellHost | null = panels ?? appHost
const control = shellHost
  ? new ControlSocket(
      shellHost,
      broadcastPrefs,
      osBridge,
      spec => {
        syncHermesSkin(spec, backend)
        events.emit('theme-set', { theme: spec.name })
      },
      () => void switches.broadcast(),
      plugins
    )
  : null
// Desktop mode has no compositor CLI socket; the OS control server gives it the same `ui*` surface.
const osControlPath = panels ? path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`, 'herald-os', 'control.sock') : path.join(heraldOsDataDir(), 'control.sock')
const reverseControlOff = process.platform === 'win32' && reverseControlDisabled()
const osControl = panels || reverseControlOff
  ? null
  : new OsControlServer(osControlPath, async request => {
      // OsControlServer authenticates every request before dispatch, including these conveniences.
      const ui = await handleUiRequest(request as unknown as Parameters<typeof handleUiRequest>[0], osBridge)

      if (ui) {
        return ui
      }

      // A few CLI conveniences the Linux socket also offers, relayed as ShellCommands.
      const cmd = String(request.cmd ?? '')
      const args = Array.isArray(request.args) ? (request.args as string[]) : []
      const relay = (command: ShellCommand) => {
        mainWindow?.webContents.send(IPC.shellCommand, command)
        mainWindow?.show()
      }

      switch (cmd) {
        case 'page':
          relay({ type: 'show-page', args })

          return { ok: true }
        case 'notify':
          relay({ type: 'notify', args })

          return { ok: true }
        case 'voice':
          relay({ type: 'voice', args: [args[0] ?? 'toggle'] })

          return { ok: true }
        case 'os':
          relay({ type: 'os', args: [args[0]], payload: args[1] ? (JSON.parse(args[1]) as Record<string, unknown>) : undefined })

          return { ok: true }
        default:
          return { ok: false, error: `unknown command ${cmd}` }
      }
    }, undefined, error => {
      log('main', `OS control listener stopped: ${error.message}`)
      // Normal quit joins both pipe I/O and the backend's owned publication cleanup.
      app.quit()
    })
// Serves org.freedesktop.Notifications so other apps' notifications reach the shell.
const notifications = panels ? new NotificationDaemon(panels) : null
/** Deliver a ShellCommand to the Hermes window; panels mode queues it until that window has loaded. */
const toHermesWindow = (command: ShellCommand) => (panels ? panels.relay('main', command) : mainWindow?.webContents.send(IPC.shellCommand, command))
const crashes = new CrashWatcher(
  report => toHermesWindow({ type: 'crash', payload: { ...report } }),
  () => [backend.childPid()].filter((pid): pid is number => pid !== null),
  report => events.emit('crash', { app: report.app, pid: report.pid, reason: report.reason })
)
// Every event runs the person's hook scripts and fires the Hermes automations waiting for it.
if (startupAllowed) events.on(event => {
  runHooks(event)
  void fireEventAutomations(event, backend)
})


function windowState(win: BrowserWindow): WindowState {
  return { fullscreen: win.isFullScreen(), focused: win.isFocused() }
}

function broadcastWindowState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.windowState, windowState(mainWindow))
  }
}

function registerCoreIpc(): void {
  const knownBackendSender = (sender: Electron.WebContents) => sender === mainWindow?.webContents
  const authorizeBackend = (event: Electron.IpcMainInvokeEvent) => { if (process.platform === 'win32') assertBackendSender(event, knownBackendSender) }
  const authorizedMainWindow = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const win = mainWindow

    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      throw new Error('main window access denied')
    }

    return win
  }
  registerBackendTransport(backend, knownBackendSender)
  ipcMain.handle(IPC.backendGetState, event => { authorizeBackend(event); return backend.getState() })
  ipcMain.handle(IPC.backendRestart, event => {
    authorizeBackend(event)
    if (quitting) throw new Error('Herald OS is quitting; retry Quit to finish cleanup')
    return backend.restart()
  })
  ipcMain.handle(IPC.backendRest, (event, request: RestRequest) => { authorizeBackend(event); return backend.rest(request) })
  ipcMain.handle(IPC.backendLogTail, (event, lines: number) => { authorizeBackend(event); return [...logTail(lines), ...backend.getState().logTail] })

  ipcMain.handle(IPC.notifyNative, (_event, title: string, body: string) => {
    if (Notification.isSupported()) {
      const notification = new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 400), silent: true })
      // macOS only shows notifications from code-signed apps; unsigned builds fail here.
      notification.on('failed', (_event, error) => log('notify', `native notification failed: ${error}`))
      notification.show()
    }
  })

  ipcMain.handle(IPC.windowGetState, () => (mainWindow ? windowState(mainWindow) : { fullscreen: false, focused: false }))
  ipcMain.handle(IPC.windowToggleFullscreen, () => {
    if (mainWindow) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
    }
  })
  ipcMain.handle(IPC.windowHide, event => authorizedMainWindow(event).hide())
  ipcMain.handle(IPC.windowShow, event => {
    const win = authorizedMainWindow(event)

    if (win.isMinimized()) {
      win.restore()
    }

    win.show()
    win.focus()
  })
  ipcMain.handle(IPC.windowQuit, () => app.quit())

  ipcMain.handle(IPC.shellOpenExternal, (_event, url: unknown) => {
    if (mayOpenExternally(url)) {
      return shell.openExternal(url)
    }

    throw new Error(process.platform === 'darwin' ? 'only http(s) URLs and Privacy & Security settings may be opened externally' : 'only http(s) URLs may be opened externally')
  })

  ipcMain.handle(IPC.prefsGet, () => readPrefs())
  ipcMain.handle(IPC.prefsSet, (_event, patch: PrefsPatch) => {
    const next = writePrefs(patch)

    if ('wallpaper' in patch) {
      wallpaper?.apply(next.wallpaper)
    }

    if (patch.voice) {
      applyVoiceHotkey(next.voice.enabled ? next.voice.hotkey : '', () => BrowserWindow.getAllWindows())
    }

    if ('idle' in patch || 'screensaver' in patch) {
      void switches.applyIdle(next)
    }

    if ('doNotDisturb' in patch || 'screensaver' in patch) {
      void switches.broadcast()
    }

    // The keymap lives in niri's config, which the CLI renders (niri reloads it by itself).
    if ('keymap' in patch && process.platform === 'linux') {
      void run('herald-os', ['keymap', next.keymap === 'omarchy' ? 'omarchy' : 'herald'], 10_000).then(result => result.code !== 0 && log('keymap', result.stderr.trim()))
    }

    // Every surface window sees the same preferences.
    sendPrefsToOthers(BrowserWindow.getAllWindows(), _event.sender, next)

    return next
  })
  ipcMain.handle(IPC.prefsAdoptLegacyNotify, (event, flags: unknown) => handleAdoptLegacyNotify(BrowserWindow.getAllWindows(), event.sender, flags))

  ipcMain.handle(
    IPC.envInfo,
    (): EnvInfo => ({ platform: process.platform, hermesHome: hermesHome(), homeDir: os.homedir(), version: app.getVersion(), isDev, shellMode: mode, languages: systemLanguages() })
  )

  registerFsIpc(() => mainWindow)
  registerCanvasIpc(() => mainWindow)
  registerModelIpc()
  registerOfficeIpc(() => mainWindow)
  registerAppsIpc()
  registerBridgeIpc()
  registerServiceIpc()
  registerMenuExtensionsIpc()
  registerBrandingIpc()
  registerSystemIpc(() => BrowserWindow.getAllWindows())
  registerContextIpc(
    () => BrowserWindow.getAllWindows(),
    back => events.emit('returned', { reason: back.reason, away_minutes: Math.round(back.awayMs / 60_000) })
  )
  registerThemeIpc({ panels: Boolean(panels), broadcast: broadcastPrefs, backend })
  registerCaptureIpc(state => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.captureRecordChanged, state)
    }
  })
  registerControlsIpc()
  registerNotificationHistoryIpc()
  registerPetIpc({ hermesWindow: () => (panels ? panels.mainWindow() : mainWindow), petWindow })
  registerDictationIpc(() => (panels ? panels.mainWindow() : mainWindow))
  registerCatalogIpc()
  registerSetupIpc()
  plugins.registerIpc()
  plugins.registerProtocol()
  plugins.watch()
  emojiPanel?.register()
  registerTerminalIpc(() => mainWindow)
  registerVoiceIpc(backend, authorizeBackend)
  // Desktop mode layers pages over the shell window; panels mode gives them compositor windows.
  const webViews = registerWebIpc(mode === 'desktop')
  registerEditIpc(() => webViews)
}

function attachMainWindow(win: BrowserWindow): void {
  mainWindow = win

  win.on('enter-full-screen', broadcastWindowState)
  win.on('leave-full-screen', broadcastWindowState)
  win.on('focus', broadcastWindowState)
  win.on('blur', broadcastWindowState)

  if (!panels) {
    win.on('close', event => {
      if (cleanupComplete) return
      // Retain the desktop window so failed cleanup still has a reachable Quit action.
      event.preventDefault()
      app.quit()
    })
  }

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })
}

function createWindow(): void {
  if (!startupAllowed || quitting) return
  if (panels) {
    panels.start()
    petWindow?.start()
    void notifications?.start()
    control?.start()
    wallpaper?.start(readPrefs().wallpaper)

    return
  }

  attachMainWindow(createMainWindow(readPrefs()))
  appHost?.start()
  control?.start()

  // Inside Omarchy, Herald wears Omarchy's theme from the start (its theme-set hook keeps it in step),
  // unless a Herald theme was picked since.
  const themeName = readPrefs().themeName
  const omarchy = appHost && isOmarchy() && (!themeName || themeName.startsWith('omarchy-')) ? readOmarchyTheme() : null

  if (omarchy) {
    broadcastPrefs(writePrefs(prefsForTheme(omarchy.spec, omarchy.dir)))
  }
}

app.whenReady().then(async () => {
  if (!startupAllowed || quitting) return
  log('main', `Herald OS ${app.getVersion()} starting (dev=${isDev}, mode=${mode}, libuv=${process.versions.uv}, HERMES_HOME=${hermesHome()})`)
  // A packaged app carries its icon in the bundle; `electron .` would show Electron's.
  const icon = isDev ? appIconPath() : undefined

  if (icon && process.platform === 'darwin') {
    app.dock?.setIcon(icon)
  }

  registerCoreIpc()
  events.registerIpc()
  crashes.start()
  startEventSources()
  switches.start()
  backend.onState(state => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (process.platform !== 'win32' || win === mainWindow) win.webContents.send(IPC.backendState, state)
    }
  })
  createWindow()
  // Windows receives the endpoint only after its native listener and DACL are verified.
  // Panels retain their existing compositor ControlSocket path.
  if (reverseControlOff) {
    log('main', 'reverse OS control disabled for this required attached-backend launch')
  } else {
    try {
      const controlEndpoint = osControl ? await osControl.start() : osControlPath
      if (quitting) return
      // Only the awaited desktop Unix listener can authorize migration of its old control.json.
      // Panels have no readiness acknowledgement here, and Windows has no Unix legacy migration.
      backend.setControl(controlEndpoint, osControlToken(), osControl && process.platform !== 'win32' ? controlEndpoint : undefined)
    } catch (error) {
      log('main', `OS control could not start: ${error instanceof Error ? error.message : String(error)}`)
      if (process.platform === 'win32') {
        if (!quitting) {
          dialog.showErrorBox('Herald OS could not start', 'The private Windows OS-control endpoint could not be initialized. Check the Herald OS logs and restart the app.')
          app.quit()
        }
        return
      }
      // Preserve the original Unix desktop fallback without publishing an endpoint we do not own.
    }
  }
  if (quitting) return
  // Cmd+Ctrl+F is the standard macOS fullscreen toggle; register it as a local shortcut so the
  // user can always leave the environment. Only this shortcut follows focus: the voice hotkey
  // (ipc/voice.ts) must keep working while another app is in front.
  const fullscreenAccelerator = process.platform === 'darwin' ? 'Command+Control+F' : 'F11'
  app.on('browser-window-focus', () => {
    globalShortcut.register(fullscreenAccelerator, () => {
      mainWindow?.setFullScreen(!mainWindow.isFullScreen())
    })
  })
  app.on('browser-window-blur', () => globalShortcut.unregister(fullscreenAccelerator))
  const voicePrefs = readPrefs().voice
  applyVoiceHotkey(voicePrefs.enabled ? voicePrefs.hotkey : '', () => BrowserWindow.getAllWindows())
  void backend.start()
}).catch(error => {
  if (startupAllowed) log('main', `startup failed: ${error instanceof Error ? error.message : String(error)}`)
})

app.on('second-instance', (_event, argv, _directory, additionalData) => {
  if (argv.includes('--enroll-windows-v3') || (additionalData as {windowsV3Enrollment?:boolean})?.windowsV3Enrollment) return
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('window-all-closed', () => {
  // In panels mode the menu bar and dock keep the session alive; closing the Hermes window is fine.
  if (!panels) {
    app.quit()
  }
})

let quitting = false
let cleanupComplete = false
let cleanupPending = false
let controlStopped: Promise<void> | undefined
app.on('before-quit', event => {
  if (!startupAllowed || cleanupComplete) return
  event.preventDefault()
  if (cleanupPending) return
  cleanupPending = true
  if (!quitting) {
    // Keep startup cancelled across failed quit attempts. Stop these services once;
    // OsControlServer drops its handles before awaiting cleanup, so a second stop
    // must not replace an unconfirmed first result with a no-op success.
    quitting = true
    globalShortcut.unregisterAll()
    crashes.stop()
    plugins.stop()
    emojiPanel?.stop()
    control?.stop()
    controlStopped = osControl?.stop()
    wallpaper?.stop()
    notifications?.stop()
    panels?.stop()
    appHost?.stop()
  }
  void Promise.allSettled([controlStopped, backend.stop()]).then(results => {
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    for (const failure of failures) log('main', `shutdown cleanup failed: ${String(failure.reason)}`)
    if (failures.length) {
      if (!panels) {
        dialog.showErrorBox('Herald OS cleanup needs attention', 'The app could not finish stopping its backend or local control endpoint and will stay open. Check the Herald OS logs before trying Quit again.')
      }
      return
    }
    cleanupComplete = true
    app.quit()
  }).finally(() => { cleanupPending = false })
})

// All state and handlers exist before quit can synchronously emit before-quit.
if (!primaryInstance) app.quit()
else if (!startupAllowed) {
  dialog.showErrorBox('Herald OS migration needs attention', migration?.error ?? 'Legacy data could not be safely migrated. Source data has been preserved.')
  app.quit()
}
}
