import { execFile, execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Script } from 'node:vm'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn() }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))
vi.mock('./probe.ts', () => ({ waitForStatus: vi.fn() }))
vi.mock('./local-files.ts', () => ({ backendReadsLocalFiles: vi.fn().mockResolvedValue(true) }))
vi.mock('./bridge-plugin.ts', () => ({ ensureBridgePlugin: vi.fn() }))
vi.mock('./resolve.ts', () => ({ pendingInstall: vi.fn(), resolveBackendRuntime: vi.fn() }))
vi.mock('./shell-env.ts', () => ({ loginShellPath: vi.fn() }))
vi.mock('./coexist.ts', async importOriginal => ({ ...await importOriginal<typeof import('./coexist.ts')>(), foreignGateway: vi.fn(() => null) }))
vi.mock('./control-file.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./control-file.ts')>()
  return { ...actual, publishControlFile: vi.fn(), removeControlFile: vi.fn() }
})

import { type ControlPublication, ControlCleanupError, ControlPublicationError, publishControlFile, removeControlFile } from './control-file.ts'
import { BackendManager } from './manager.ts'
import { waitForStatus } from './probe.ts'
import { log } from '../log.ts'
import { ensureBridgePlugin } from './bridge-plugin.ts'
import { pendingInstall, resolveBackendRuntime } from './resolve.ts'
import { loginShellPath } from './shell-env.ts'
import { IPC } from '../../shared/ipc.ts'

const testHome = path.join(os.tmpdir(), 'herald-manager-unit-test-only')
const endpoint = { socket: 'tcp://127.0.0.1:12345', token: 'test-control-token' }
const publication: ControlPublication = {
  file: path.join(testHome, 'herald-os', 'control.json'), ...endpoint,
  pid: process.pid, instance: '11111111-1111-4111-8111-111111111111'
}
const replacement = { ...publication, instance: '22222222-2222-4222-8222-222222222222' }
let ownedMode = false
const hostPlatform = process.platform

function manager(): BackendManager {
  const backend = new BackendManager()
  backend.setControl(endpoint.socket, endpoint.token)
  return backend
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

// Execute the complete production main module with inert Electron/host boundaries.
// Its actual before-quit listener and the real BackendManager remain under test;
// no Electron process, listener, migration, backend executable or user data is used.
function quitHarness(backend: BackendManager, controlStop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined), options: { platform?: 'win32' | 'darwin'; primary?: boolean; blocked?: boolean; dev?: boolean; startup?: boolean; inspectionError?: 'ENOENT' | 'EACCES'; populated?: boolean } = {}) {
  const source = fs.readFileSync(new URL('../main.ts', import.meta.url), 'utf8')
  const ready = deferred<void>()
  const processEvents = new EventEmitter()
  const order: string[] = []
  const migrate = vi.fn(() => { order.push('migration'); return Object.assign([], { status: options.blocked ? 'blocked' : 'completed', messages: [], error: options.blocked ? 'fixture migration blocked' : undefined }) })
  const startService = vi.fn(() => { order.push('service') })
  const hookRegistration = vi.fn()
  const fakeWindow = Object.assign(new EventEmitter(), {
    webContents: { send: vi.fn() },
    hide: vi.fn(), show: vi.fn(), focus: vi.fn(), restore: vi.fn(),
    isMinimized: vi.fn(() => false), isDestroyed: vi.fn(() => false)
  })
  const app = Object.assign(new EventEmitter(), {
    setName: vi.fn(), setAppUserModelId: vi.fn(), setPath: vi.fn(),
    getPath: vi.fn(() => testHome), getVersion: vi.fn(() => 'test'),
    requestSingleInstanceLock: vi.fn(() => { order.push('ownership'); return options.primary !== false }), whenReady: vi.fn(() => ready.promise),
    quit: vi.fn()
  })
  const requestQuit = () => {
    const event = { preventDefault: vi.fn() }
    app.emit('before-quit', event)
    return event
  }
  const exitAllowed: boolean[] = []
  app.quit.mockImplementation(() => { exitAllowed.push(requestQuit().preventDefault.mock.calls.length === 0) })
  const showErrorBox = vi.fn(), unregisterAll = vi.fn(), stopService = vi.fn()
  const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.ES2022, true)
  const enrollment = parsed.statements.find((statement): statement is ts.IfStatement =>
    ts.isIfStatement(statement) && ts.isIdentifier(statement.expression) && statement.expression.text === 'enrollmentRequested')
  const normalStartup = enrollment?.elseStatement
  if (!normalStartup || !ts.isBlock(normalStartup)) throw new Error('Expected the explicit enrollment/normal-startup boundary')
  const exportAt = normalStartup.end - 1
  // Expose the same real functions inside their lexical block, only in this inert test realm.
  const testSource = source.slice(0, exportAt) + '\nexports.registerCoreIpc = registerCoreIpc; exports.attachMainWindow = attachMainWindow;\n' + source.slice(exportAt)
  const modules: Record<string, unknown> = {}
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings
      modules[statement.moduleSpecifier.text] = bindings && ts.isNamedImports(bindings)
        ? Object.fromEntries(bindings.elements.filter(item => item.name.text.startsWith('register')).map(item => [item.name.text, vi.fn()]))
        : {}
    }
  }
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  Object.assign(modules, {
    electron: {
      app, BrowserWindow: { getAllWindows: () => [] }, dialog: { showErrorBox }, globalShortcut: { unregisterAll, register: vi.fn(), unregister: vi.fn() }, protocol: { registerSchemesAsPrivileged: vi.fn() },
      ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) }
    },
    '../shared/ipc.ts': { IPC },
    'node:os': os, 'node:path': path, 'node:fs': { readdirSync: () => { if (options.inspectionError) throw Object.assign(new Error('inspection failed'), { code: options.inspectionError }); return options.populated ? ['Preferences'] : [] } },
    './backend/manager.ts': { BackendManager: class { constructor() { return backend } } },
    './ipc/backend-transport.ts': { registerBackendTransport: vi.fn(), assertBackendSender: vi.fn() },
    './backend/coexist.ts': { reverseControlDisabled: () => false },
    './backend/session-env.ts': { forgetInheritedSession: () => ['HERMES_SESSION_ID'] },
    './log.ts': { log }, './renderer-console.ts': { forwardRendererConsole: vi.fn() },
    './migrate.ts': { migrateLegacyData: migrate },
    './paths.ts': { hermesHome: () => testHome, heraldOsDataDir: () => testHome, isDev: options.dev ?? false },
    './shell/mode.ts': { shellMode: () => 'desktop' },
    './shell/os-control.ts': {
      OsCommandBridge: class {}, OsControlServer: class { stop = controlStop; start = async () => endpoint.socket }, osControlToken: () => endpoint.token
    },
    './plugins/host.ts': { PluginHost: class { stop = stopService; registerIpc = vi.fn(); registerProtocol = vi.fn(); watch = startService } },
    './switches.ts': { SwitchService: class { start = startService } },
    './crash/watch.ts': { CrashWatcher: class { stop = vi.fn(); start = startService } },
    './events/bus.ts': { events: { on: hookRegistration, registerIpc: startService } },
    './events/sources.ts': { startEventSources: startService },
    './prefs.ts': { readPrefs: () => ({ voice: { enabled: false, hotkey: '' } }) },
    './ipc/voice.ts': { registerVoiceIpc: vi.fn(), applyVoiceHotkey: vi.fn() },
    './shell/emoji-panel.ts': { EmojiPanel: class { register = vi.fn(); stop = vi.fn() } },
    './window.ts': { createMainWindow: () => fakeWindow, appIconPath: () => undefined }
  })
  const compiled = ts.transpileModule(testSource, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
  } }).outputText
  const entrypoints: { registerCoreIpc?: () => void; attachMainWindow?: (window: unknown) => void } = {}
  new Script(compiled, { filename: 'main.ts' }).runInNewContext({
    exports: entrypoints, process: { platform: options.platform ?? 'win32', argv: [], env: {}, versions: { uv: 'fixture' }, on: processEvents.on.bind(processEvents) },
    require: (name: string) => {
      if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected main dependency: ${name}`)
      return modules[name]
    }
  })
  if (!options.startup) entrypoints.registerCoreIpc!()
  return { processEvents, order, migrate, startService, hookRegistration, fakeWindow, app, requestQuit, exitAllowed, showErrorBox, unregisterAll, stopService, controlStop, ready,
    restart: () => Promise.resolve().then(() => handlers.get(IPC.backendRestart)!({})),
    invoke: (channel: string, event: unknown, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!(event, ...args)),
    attachWindow: entrypoints.attachMainWindow!
  }
}

// Drain the promise reactions from the registered event handler, not a guessed delay.
const settleQuit = () => new Promise<void>(resolve => setImmediate(resolve))

describe('main startup ownership and migration', () => {
  it.each([false, true])('binds the permanent Windows identity before ownership (development=%s)', async dev => {
    const backend = manager()
    const start = vi.spyOn(backend, 'start').mockResolvedValue(undefined)
    const main = quitHarness(backend, undefined, { dev, startup: true })
    expect(main.app.setName).toHaveBeenCalledWith('Herald OS')
    expect(main.app.setAppUserModelId).toHaveBeenCalledWith('dev.iamluke.heraldos')
    expect(main.app.setPath).toHaveBeenCalledWith('userData', path.join(testHome, 'Herald OS'))
    expect(main.app.setPath.mock.invocationCallOrder[0]).toBeLessThan(main.app.requestSingleInstanceLock.mock.invocationCallOrder[0]!)
    expect(main.migrate).not.toHaveBeenCalled()
    main.ready.resolve(undefined)
    await settleQuit()
    expect(main.migrate).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledOnce()
    expect(main.startService).toHaveBeenCalled()
    expect(main.showErrorBox).not.toHaveBeenCalled()
    expect(vi.mocked(log).mock.calls.flat().join('\n')).not.toContain('startup failed')
  })

  it.each([
    { inspectionError: 'ENOENT' as const, expectedEmpty: true },
    { populated: true, expectedEmpty: false }
  ])('passes the pre-ownership native profile observation to migration: %j', options => {
    const main = quitHarness(manager(), undefined, { ...options, platform: 'darwin', startup: true })
    expect(main.migrate).toHaveBeenCalledWith(expect.objectContaining({ userDataWasEmpty: options.expectedEmpty }))
  })

  it('a pre-ownership inspection error withholds migration and services and shows a blocking dialog', async () => {
    const main = quitHarness(manager(), undefined, { inspectionError: 'EACCES', startup: true })
    main.ready.resolve(undefined)
    await settleQuit()
    expect(main.migrate).not.toHaveBeenCalled()
    expect(main.startService).not.toHaveBeenCalled()
    expect(main.showErrorBox).toHaveBeenCalledOnce()
    expect(main.exitAllowed).toEqual([true])
    expect(log).not.toHaveBeenCalled()
  })

  it('acquires non-Windows ownership before migration or persistent logging and reaches backend startup', async () => {
    const backend = manager()
    const start = vi.spyOn(backend, 'start').mockResolvedValue(undefined)
    const main = quitHarness(backend, undefined, { platform: 'darwin', startup: true })
    expect(main.order[0]).toBe('ownership')
    expect(main.migrate.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(log).mock.invocationCallOrder[0]!)
    expect(main.app.requestSingleInstanceLock.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(log).mock.invocationCallOrder[0]!)
    main.ready.resolve(undefined)
    await settleQuit()
    expect(start).toHaveBeenCalledOnce()
    expect(main.startService).toHaveBeenCalled()
    expect(main.showErrorBox).not.toHaveBeenCalled()
    expect(vi.mocked(log).mock.calls.flat().join('\n')).not.toContain('startup failed')
    main.app.emit('second-instance', {}, [], testHome, {})
    expect(main.fakeWindow.focus).toHaveBeenCalledOnce()
  })

  it('a secondary instance quits without migration, logs, hooks or services', async () => {
    const backend = manager()
    const start = vi.spyOn(backend, 'start').mockResolvedValue(undefined)
    const main = quitHarness(backend, undefined, { primary: false, startup: true })
    main.ready.resolve(undefined)
    await settleQuit()
    main.processEvents.emit('uncaughtException', new Error('secondary exception'))
    expect(main.migrate).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(main.hookRegistration).not.toHaveBeenCalled()
    expect(main.startService).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(main.exitAllowed).toEqual([true])
  })

  it('a blocking migration visibly prevents all normal startup', async () => {
    const backend = manager()
    const start = vi.spyOn(backend, 'start').mockResolvedValue(undefined)
    const main = quitHarness(backend, undefined, { platform: 'darwin', blocked: true, startup: true })
    main.ready.resolve(undefined)
    await settleQuit()
    main.app.emit('activate')
    expect(main.showErrorBox).toHaveBeenCalledOnce()
    expect(main.startService).not.toHaveBeenCalled()
    expect(main.hookRegistration).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(main.exitAllowed).toEqual([true])
  })

  it('passes the existing development policy to migration before starting normally', async () => {
    const backend = manager()
    const start = vi.spyOn(backend, 'start').mockResolvedValue(undefined)
    const main = quitHarness(backend, undefined, { platform: 'darwin', dev: true, startup: true })
    expect(main.migrate).toHaveBeenCalledWith(expect.objectContaining({ isDev: true }))
    main.ready.resolve(undefined)
    await settleQuit()
    expect(start).toHaveBeenCalledOnce()
  })
})

describe('main-window visibility IPC', () => {
  it('lets only the main renderer hide and restore its window without closing the app', async () => {
    const main = quitHarness(manager())
    main.attachWindow(main.fakeWindow)
    main.fakeWindow.isMinimized.mockReturnValue(true)
    const event = { sender: main.fakeWindow.webContents }

    await expect(main.invoke(IPC.windowHide, event)).resolves.toBeUndefined()
    await expect(main.invoke(IPC.windowShow, event)).resolves.toBeUndefined()

    expect(main.fakeWindow.hide).toHaveBeenCalledOnce()
    expect(main.fakeWindow.restore).toHaveBeenCalledOnce()
    expect(main.fakeWindow.show).toHaveBeenCalledOnce()
    expect(main.fakeWindow.focus).toHaveBeenCalledOnce()
    expect(main.fakeWindow.restore.mock.invocationCallOrder[0]).toBeLessThan(main.fakeWindow.show.mock.invocationCallOrder[0]!)
    expect(main.fakeWindow.show.mock.invocationCallOrder[0]).toBeLessThan(main.fakeWindow.focus.mock.invocationCallOrder[0]!)
    expect(main.app.quit).not.toHaveBeenCalled()
  })

  it('shows and focuses a main window that is not minimized without restoring it', async () => {
    const main = quitHarness(manager())
    main.attachWindow(main.fakeWindow)
    main.fakeWindow.isMinimized.mockReturnValue(false)

    await expect(main.invoke(IPC.windowShow, { sender: main.fakeWindow.webContents })).resolves.toBeUndefined()

    expect(main.fakeWindow.restore).not.toHaveBeenCalled()
    expect(main.fakeWindow.show).toHaveBeenCalledOnce()
    expect(main.fakeWindow.focus).toHaveBeenCalledOnce()
    expect(main.fakeWindow.show.mock.invocationCallOrder[0]).toBeLessThan(main.fakeWindow.focus.mock.invocationCallOrder[0]!)
  })

  it('rejects foreign renderers and a destroyed main window', async () => {
    const main = quitHarness(manager())
    main.attachWindow(main.fakeWindow)

    for (const channel of [IPC.windowHide, IPC.windowShow]) {
      await expect(main.invoke(channel, { sender: {} })).rejects.toThrow('main window access denied')
    }

    main.fakeWindow.isDestroyed.mockReturnValue(true)
    for (const channel of [IPC.windowHide, IPC.windowShow]) {
      await expect(main.invoke(channel, { sender: main.fakeWindow.webContents })).rejects.toThrow('main window access denied')
    }
    expect(main.fakeWindow.hide).not.toHaveBeenCalled()
    expect(main.fakeWindow.show).not.toHaveBeenCalled()
  })

  it('rejects hide and show after the main window closes', async () => {
    const main = quitHarness(manager())
    main.attachWindow(main.fakeWindow)
    main.fakeWindow.emit('closed')

    for (const channel of [IPC.windowHide, IPC.windowShow]) {
      await expect(main.invoke(channel, { sender: main.fakeWindow.webContents })).rejects.toThrow('main window access denied')
    }
  })
})

beforeEach(() => {
  // Legacy attach/owned cleanup continues on Linux; native Windows V2 has separate tests.
  Object.defineProperty(process,'platform',{value:'linux',configurable:true})
  ownedMode = false
  vi.resetAllMocks()
  vi.stubEnv('HERMES_HOME', testHome)
  vi.stubEnv('HERALD_OS_BACKEND_URL', 'http://127.0.0.1:9119')
  vi.stubEnv('HERALD_OS_BACKEND_TOKEN', 'test-backend-token')
  vi.mocked(waitForStatus).mockResolvedValue(undefined)
  vi.mocked(publishControlFile).mockResolvedValue(publication)
  vi.mocked(removeControlFile).mockResolvedValue(undefined)
})

afterEach(() => {
  // Attach lifecycle tests use no real backend, process, network or control-file helper.
  if (!ownedMode) expect(spawn).not.toHaveBeenCalled()
  expect(execFile).not.toHaveBeenCalled()
  expect(execFileSync).not.toHaveBeenCalled()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  Object.defineProperty(process,'platform',{value:hostPlatform,configurable:true})
})

describe('owned backend lifecycle generations', () => {
  const children: Array<ReturnType<typeof fakeChild>> = []
  function fakeChild(pid: number | undefined, ready = true) {
    const stream = () => Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
    const child = Object.assign(new EventEmitter(), {
      pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      stdout: stream(), stderr: stream(),
      kill: vi.fn<(signal?: NodeJS.Signals) => boolean>()
    })
    child.kill.mockImplementation(() => {
      child.exitCode = 0
      queueMicrotask(() => child.emit('exit', 0, null))
      return true
    })
    if (ready) queueMicrotask(() => child.stdout.emit('data', 'HERMES_BACKEND_READY port=42123\n'))
    return child
  }
  beforeEach(() => {
    ownedMode = true
    children.length = 0
    vi.stubEnv('HERALD_OS_BACKEND_URL', '')
    vi.mocked(pendingInstall).mockReturnValue(null)
    vi.mocked(resolveBackendRuntime).mockReturnValue({ kind: 'path', label: 'fixture', command: ['fake-hermes'] })
    vi.mocked(ensureBridgePlugin).mockResolvedValue(null)
    vi.mocked(loginShellPath).mockResolvedValue('fixture-path')
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'rmSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'readdirSync').mockReturnValue([])
    vi.mocked(spawn).mockImplementation((() => {
      const child = fakeChild(10000 + children.length)
      children.push(child)
      return child
    }) as unknown as typeof spawn)
  })
  afterEach(() => {
    for (const child of children) expect(child.exitCode).toBe(0)
  })

  it('main quit retains a refused child and retries cleanup only on another explicit quit', async () => {
    const backend = manager()
    await backend.start()
    const child = children[0]
    child.kill.mockReturnValue(false)
    const main = quitHarness(backend)
    try {
      expect(main.requestQuit().preventDefault).toHaveBeenCalledOnce()
      await settleQuit()
      expect(backend.childPid()).toBe(child.pid)
      expect(main.app.quit).not.toHaveBeenCalled()
      expect(main.showErrorBox).toHaveBeenCalledOnce()
      main.ready.resolve(undefined)
      await settleQuit()
      expect(main.app.getVersion).not.toHaveBeenCalled()
      child.exitCode = 0
      child.emit('exit', 0, null)
      expect(main.requestQuit().preventDefault).toHaveBeenCalledOnce()
      await settleQuit()
      expect(main.exitAllowed).toEqual([true])
      expect(backend.childPid()).toBeNull()
      expect(main.controlStop).toHaveBeenCalledOnce()
      expect(main.stopService).toHaveBeenCalledOnce()
    } finally {
      child.exitCode = 0
      child.emit('exit', 0, null)
      await backend.stop()
    }
  })

  it('main quit coalesces pending requests and waits for the owned exit before allowing quit', async () => {
    const backend = manager()
    await backend.start()
    const child = children[0]
    child.kill.mockReturnValue(true)
    const stopping = vi.spyOn(backend, 'stop')
    const main = quitHarness(backend)
    try {
      main.requestQuit()
      main.requestQuit()
      await settleQuit()
      expect(stopping).toHaveBeenCalledOnce()
      expect(main.app.quit).not.toHaveBeenCalled()
      child.exitCode = 0
      child.emit('exit', 0, null)
      await settleQuit()
      expect(main.exitAllowed).toEqual([true])
      expect(main.showErrorBox).not.toHaveBeenCalled()
    } finally {
      child.exitCode = 0
      child.emit('exit', 0, null)
      await backend.stop()
    }
  })

  it('main rejects restart during pending and failed quit while preserving ordinary restart', async () => {
    const backend = manager()
    await backend.start()
    const main = quitHarness(backend)
    await main.restart()
    expect(children).toHaveLength(2)
    const child = children[1]
    child.kill.mockReturnValue(true)
    const restart = vi.spyOn(backend, 'restart')
    let pendingRestart: Promise<unknown> | undefined
    try {
      main.requestQuit()
      pendingRestart = main.restart().then(() => 'resolved', error => error)
      await settleQuit()
      expect(restart).not.toHaveBeenCalled()
      expect(await pendingRestart).toMatchObject({ message: expect.stringContaining('quitting') })
      child.emit('error', new Error('termination unconfirmed'))
      await settleQuit()
      expect(main.app.quit).not.toHaveBeenCalled()
      await expect(main.restart()).rejects.toThrow('quitting')
      expect(restart).not.toHaveBeenCalled()
      expect(children).toHaveLength(2)
    } finally {
      for (const entry of children) { entry.exitCode = 0; entry.emit('exit', 0, null) }
      await pendingRestart
      await backend.stop()
    }
  })

  it('main keeps the desktop window available when close cleanup fails and permits close after success', async () => {
    const backend = manager()
    await backend.start()
    const child = children[0]
    child.kill.mockReturnValue(false)
    const main = quitHarness(backend)
    const window = new EventEmitter()
    main.attachWindow(window)
    const close = () => {
      const event = { preventDefault: vi.fn() }
      window.emit('close', event)
      return event
    }
    try {
      expect(close().preventDefault).toHaveBeenCalledOnce()
      await settleQuit()
      expect(main.exitAllowed).toEqual([false])
      expect(main.showErrorBox).toHaveBeenCalledOnce()
      child.exitCode = 0
      child.emit('exit', 0, null)
      expect(close().preventDefault).toHaveBeenCalledOnce()
      await settleQuit()
      expect(main.exitAllowed).toEqual([false, false, true])
      expect(close().preventDefault).not.toHaveBeenCalled()
    } finally {
      child.exitCode = 0
      child.emit('exit', 0, null)
      await backend.stop()
    }
  })

  it('replaces an early restarted child when startup supplies the verified control endpoint', async () => {
    const backend = new BackendManager()
    try {
      await backend.restart()
      const first = children[0]
      backend.setControl(endpoint.socket, endpoint.token)
      await backend.start()
      expect(first.kill).toHaveBeenCalled()
      expect(first.exitCode).toBe(0)
      expect(children).toHaveLength(2)
      expect(vi.mocked(spawn).mock.calls[1][2]?.env?.HERALD_OS_CONTROL_SOCKET).toBe(endpoint.socket)
    } finally {
      await backend.stop()
      // Cleanup an orphan on the RED implementation without hiding the assertion above.
      for (const child of children) if (child.exitCode === null) child.kill()
    }
  })

  it.each(['bridge', 'path'] as const)('does not spawn a superseded launch suspended in %s discovery', async stage => {
    const entered = deferred<void>(), gate = deferred<string | null>()
    if (stage === 'bridge') vi.mocked(ensureBridgePlugin).mockImplementationOnce(() => { entered.resolve(undefined); return gate.promise })
    else vi.mocked(loginShellPath).mockImplementationOnce(() => { entered.resolve(undefined); return gate.promise as Promise<string> })
    const backend = manager()
    const old = backend.start()
    try {
      await entered.promise
      await backend.restart()
      const latestPid = backend.childPid()
      const writes = vi.mocked(fs.rmSync).mock.calls.length
      gate.resolve(stage === 'bridge' ? null : 'old-path')
      await old
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(backend.childPid()).toBe(latestPid)
      expect(fs.rmSync).toHaveBeenCalledTimes(writes)
      expect(backend.getState().phase).toBe('ready')
    } finally {
      gate.resolve(null)
      await backend.stop()
      for (const child of children) if (child.exitCode === null) child.kill()
    }
  })

  it.each(['bridge', 'path'] as const)('does not spawn after stop during %s discovery', async stage => {
    const entered = deferred<void>(), gate = deferred<string | null>()
    if (stage === 'bridge') vi.mocked(ensureBridgePlugin).mockImplementationOnce(() => { entered.resolve(undefined); return gate.promise })
    else vi.mocked(loginShellPath).mockImplementationOnce(() => { entered.resolve(undefined); return gate.promise as Promise<string> })
    const backend = manager()
    const old = backend.start()
    await entered.promise
    await backend.stop()
    const writes = vi.mocked(fs.rmSync).mock.calls.length
    gate.resolve(stage === 'bridge' ? null : 'old-path')
    try {
      await old
      expect(spawn).not.toHaveBeenCalled()
      expect(fs.rmSync).toHaveBeenCalledTimes(writes)
      expect(backend.getState().phase).toBe('stopped')
    } finally {
      await backend.stop()
      for (const child of children) if (child.exitCode === null) child.kill()
    }
  })

  it('waits for the same terminating child before the newest concurrent restart replaces it', async () => {
    const backend = manager()
    await backend.start()
    const first = children[0]
    first.kill.mockImplementation(() => true)
    const older = backend.restart(), newer = backend.restart()
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(spawn).toHaveBeenCalledTimes(1)
    } finally {
      first.exitCode = 0
      first.emit('exit', 0, null)
      await Promise.all([older, newer])
      await backend.stop()
      for (const child of children) if (child.exitCode === null) child.kill()
    }
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it.each(['stop', 'restart'] as const)('retains ownership when %s cannot confirm exit after forced termination', async action => {
    const backend = manager()
    await backend.start()
    const child = children[0]
    child.kill.mockReturnValue(true)
    vi.useFakeTimers()
    const result = backend[action]().then(() => 'resolved', error => error)
    try {
      await vi.advanceTimersByTimeAsync(5001)
      expect(await result).toBeInstanceOf(Error)
      expect(backend.getState()).toMatchObject({ phase: 'failed', baseUrl: undefined, wsUrl: undefined })
      expect(backend.childPid()).toBe(child.pid)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(child.kill.mock.calls.map(args => args[0])).toEqual(['SIGTERM', 'SIGKILL'])
      await vi.advanceTimersByTimeAsync(20000)
      expect(spawn).toHaveBeenCalledTimes(1)
      // A later confirmed exit permits an explicit retry; a timeout alone never does.
      child.exitCode = 0
      child.emit('exit', 0, null)
      await backend.restart()
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(backend.getState().phase).toBe('ready')
    } finally {
      for (const entry of children) { entry.exitCode = 0; entry.emit('exit', 0, null) }
      await result
      await backend.stop()
      vi.useRealTimers()
    }
  })

  it.each([
    ['SIGTERM', 'refused'], ['SIGTERM', 'throw'], ['SIGTERM', 'error'],
    ['SIGKILL', 'refused'], ['SIGKILL', 'throw'], ['SIGKILL', 'error']
  ] as const)('does not drop a live child when %s signalling is %s', async (stage, failure) => {
    const backend = manager()
    await backend.start()
    const child = children[0]
    child.kill.mockImplementation(signal => {
      if (signal !== stage) return true
      if (failure === 'throw') throw new Error('signal denied')
      if (failure === 'error') queueMicrotask(() => child.emit('error', new Error('signal denied')))
      return failure !== 'refused'
    })
    vi.useFakeTimers()
    const result = backend.stop().then(() => 'resolved', error => error)
    try {
      await vi.advanceTimersByTimeAsync(5001)
      expect(await result).toBeInstanceOf(Error)
      expect(backend.getState().phase).toBe('failed')
      expect(backend.childPid()).toBe(child.pid)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      child.exitCode = 0
      child.emit('exit', 0, null)
      await result
      await backend.stop()
      vi.useRealTimers()
    }
  })

  it.each([['restart', 'stop'], ['stop', 'restart']] as const)('retains the child when concurrent %s and %s both time out', async (first, second) => {
    const backend = manager()
    await backend.start()
    const child = children[0]
    child.kill.mockReturnValue(true)
    vi.useFakeTimers()
    const older = backend[first]().then(() => 'resolved', error => error)
    await vi.advanceTimersByTimeAsync(1000)
    const newer = backend[second]().then(() => 'resolved', error => error)
    try {
      await vi.advanceTimersByTimeAsync(4001)
      expect(await older).toBeInstanceOf(Error)
      expect(backend.childPid()).toBe(child.pid)
      expect(backend.getState().phase).not.toBe('stopped')
      await vi.advanceTimersByTimeAsync(1000)
      expect(await newer).toBeInstanceOf(Error)
      expect(backend.getState().phase).toBe('failed')
      expect(backend.childPid()).toBe(child.pid)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      child.exitCode = 0
      child.emit('exit', 0, null)
      await Promise.all([older, newer])
      await backend.stop()
      vi.useRealTimers()
    }
  })

  it('waits for the actual exit after SIGKILL instead of treating delivery as completion', async () => {
    const backend = manager()
    await backend.start()
    const child = children[0]
    child.kill.mockReturnValue(true)
    vi.useFakeTimers()
    let finished = false
    const stopping = backend.stop().then(() => { finished = true })
    try {
      await vi.advanceTimersByTimeAsync(4000)
      expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
      expect(finished).toBe(false)
      expect(backend.childPid()).toBe(child.pid)
      child.signalCode = 'SIGKILL'
      child.emit('exit', null, 'SIGKILL')
      await stopping
      expect(backend.childPid()).toBeNull()
      expect(backend.getState().phase).toBe('stopped')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      child.exitCode = 0
      child.emit('exit', 0, null)
      await stopping
      await backend.stop()
      vi.useRealTimers()
    }
  })

  it('contains a cleanup failure on initial start without forgetting the existing child', async () => {
    const backend = manager()
    await backend.start()
    const child = children[0]
    child.kill.mockImplementation(() => { throw new Error('signal denied') })
    try {
      await expect(backend.start()).resolves.toBeUndefined()
      expect(backend.getState().phase).toBe('failed')
      expect(backend.childPid()).toBe(child.pid)
      expect(spawn).toHaveBeenCalledTimes(1)
    } finally {
      for (const entry of children) { entry.exitCode = 0; entry.emit('exit', 0, null) }
      await backend.stop()
    }
  })

  it.each(['initial', 'wait', 'retry'] as const)('contains uncertain cleanup after a failed probe on the %s launch path', async route => {
    const backend = manager()
    vi.useFakeTimers()
    if (route === 'wait') vi.mocked(resolveBackendRuntime).mockReturnValueOnce(null)
    if (route !== 'initial') await backend.start()
    vi.mocked(waitForStatus).mockRejectedValue(new Error('probe failed'))
    vi.mocked(spawn).mockImplementation((() => {
      const child = fakeChild(10000 + children.length)
      child.kill.mockReturnValue(true)
      children.push(child)
      return child
    }) as unknown as typeof spawn)
    if (route === 'retry') {
      children[0].exitCode = 0
      children[0].emit('exit', 0, null)
    }
    const starting = route === 'initial' ? backend.start() : Promise.resolve()
    try {
      await vi.advanceTimersByTimeAsync(10000)
      await starting
      const child = children.at(-1)!
      expect(backend.getState()).toMatchObject({ phase: 'failed', baseUrl: undefined, wsUrl: undefined })
      expect(backend.childPid()).toBe(child.pid)
      expect(spawn).toHaveBeenCalledTimes(route === 'retry' ? 2 : 1)
      await vi.advanceTimersByTimeAsync(20000)
      expect(spawn).toHaveBeenCalledTimes(route === 'retry' ? 2 : 1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      for (const child of children) { child.exitCode = 0; child.emit('exit', 0, null) }
      await starting
      await backend.stop()
      vi.useRealTimers()
    }
  })

  it('keeps the bounded retry for a failed spawn that never acquired a process identity', async () => {
    vi.mocked(spawn).mockImplementationOnce((() => {
      const child = fakeChild(undefined, false)
      child.kill.mockReturnValue(false)
      children.push(child)
      queueMicrotask(() => {
        // Node sets the negative spawn exitCode before emitting its error event.
        child.exitCode = -2
        child.emit('error', new Error('spawn ENOENT'))
      })
      return child
    }) as unknown as typeof spawn)
    const backend = manager()
    vi.useFakeTimers()
    try {
      await backend.start()
      expect(backend.getState().phase).toBe('restarting')
      expect(backend.childPid()).toBeNull()
      await vi.advanceTimersByTimeAsync(1000)
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(backend.getState().phase).toBe('ready')
    } finally {
      for (const child of children) { child.exitCode = 0; child.emit('exit', 0, null) }
      await backend.stop()
      vi.useRealTimers()
    }
  })
})

describe('attached backend control-file recovery', () => {
  it('main quit retries failed publication cleanup without killing an attached backend', async () => {
    const backend = manager()
    await backend.start()
    vi.mocked(removeControlFile).mockRejectedValueOnce(new Error('owned publication still open'))
    const main = quitHarness(backend)
    try {
      main.requestQuit()
      await settleQuit()
      expect(main.app.quit).not.toHaveBeenCalled()
      expect(main.showErrorBox).toHaveBeenCalledOnce()
      main.requestQuit()
      await settleQuit()
      expect(main.exitAllowed).toEqual([true])
      expect(vi.mocked(removeControlFile).mock.calls).toEqual([[publication], [publication]])
      expect(main.controlStop).toHaveBeenCalledOnce()
    } finally {
      await backend.stop()
    }
  })

  it('main quit preserves a prior control failure instead of replacing it with a no-op success', async () => {
    const backend = manager()
    await backend.start()
    const controlStop = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('control handle cleanup unconfirmed')).mockResolvedValue(undefined)
    const main = quitHarness(backend, controlStop)
    try {
      main.requestQuit()
      await settleQuit()
      expect(main.app.quit).not.toHaveBeenCalled()
      main.requestQuit()
      await settleQuit()
      expect(main.app.quit).not.toHaveBeenCalled()
      expect(main.showErrorBox).toHaveBeenCalledTimes(2)
      expect(controlStop).toHaveBeenCalledOnce()
      expect(main.stopService).toHaveBeenCalledOnce()
      expect(backend.getState().phase).toBe('stopped')
    } finally {
      await backend.stop()
    }
  })

  it('only lets the newest restart launch after shared publication cleanup finishes', async () => {
    const backend = manager()
    await backend.start()
    const entered = deferred<void>(), cleanup = deferred<void>()
    vi.mocked(removeControlFile).mockImplementationOnce(() => { entered.resolve(undefined); return cleanup.promise })
    const older = backend.restart()
    await entered.promise
    const newer = backend.restart()
    cleanup.resolve(undefined)
    try {
      await Promise.all([older, newer])
      expect(waitForStatus).toHaveBeenCalledTimes(2)
      expect(publishControlFile).toHaveBeenCalledTimes(2)
      expect(backend.getState().phase).toBe('ready')
    } finally { await backend.stop() }
  })

  it('publishes the pipe endpoint unchanged after backend readiness and removes only its publication', async () => {
    // Manager wiring only; the synthetic endpoint is not a native security proof.
    const pipeEndpoint = { socket: String.raw`\\.\pipe\herald-os-${process.pid}-abcdef-0123456789abcdef0123456789abcdef`, token: 'test-pipe-token' }
    const pipePublication: ControlPublication = { ...publication, ...pipeEndpoint }
    const status = deferred<void>()
    vi.mocked(waitForStatus).mockReturnValueOnce(status.promise)
    vi.mocked(publishControlFile).mockResolvedValueOnce(pipePublication)
    const backend = new BackendManager()
    backend.setControl(pipeEndpoint.socket, pipeEndpoint.token)
    const starting = backend.start()
    expect(publishControlFile).not.toHaveBeenCalled()
    status.resolve(undefined)
    await starting
    expect(publishControlFile).toHaveBeenCalledExactlyOnceWith(path.join(testHome, 'herald-os'), pipeEndpoint, expect.objectContaining({ boundUnixSocket: undefined, warn: expect.any(Function) }))
    expect(backend.getState().phase).toBe('ready')
    await backend.stop()
    expect(removeControlFile).toHaveBeenCalledExactlyOnceWith(pipePublication)
    expect(vi.mocked(log).mock.calls.flat().join('\n')).not.toContain(pipeEndpoint.token)
  })
  it('forwards retained-fragment warnings and only explicitly supplied Unix bind evidence', async () => {
    vi.mocked(publishControlFile).mockImplementationOnce(async (_directory, _endpoint, options) => {
      expect(options?.boundUnixSocket).toBeUndefined()
      options?.warn?.('Retained temporary control file: test fragment')
      return publication
    })
    const backend = manager()
    await backend.start()
    expect(log).toHaveBeenCalledWith('backend', 'Retained temporary control file: test fragment')
    await backend.stop()

    const boundUnixSocket = '/test-only/control.sock'
    backend.setControl(boundUnixSocket, endpoint.token, boundUnixSocket)
    await backend.start()
    expect(publishControlFile).toHaveBeenLastCalledWith(expect.any(String), { socket: boundUnixSocket, token: endpoint.token }, expect.objectContaining({ boundUnixSocket }))
    await backend.stop()
  })

  it('retains ownership returned by failed publication rollback before retrying a restart', async () => {
    vi.mocked(publishControlFile).mockRejectedValueOnce(new ControlPublicationError('rollback blocked', publication))
    const backend = manager()
    await backend.start()
    expect(backend.getState().phase).toBe('failed')
    expect(removeControlFile).not.toHaveBeenCalled()
    vi.mocked(publishControlFile).mockImplementationOnce(async () => {
      expect(removeControlFile).toHaveBeenCalledExactlyOnceWith(publication)
      return replacement
    })

    await backend.restart()
    expect(backend.getState().phase).toBe('ready')
    await backend.stop()
    expect(vi.mocked(removeControlFile).mock.calls).toEqual([[publication], [replacement]])
  })

  it('does not adopt cleanup ownership from a pre-publication stale-file failure', async () => {
    vi.mocked(publishControlFile).mockRejectedValueOnce(new ControlCleanupError('older cleanup blocked', replacement))
    const backend = manager()
    await backend.start()
    expect(backend.getState().phase).toBe('failed')
    await backend.stop()
    expect(removeControlFile).not.toHaveBeenCalled()
  })

  it('retries the verified tombstone path returned by failed ordinary cleanup', async () => {
    const tombstone = { ...publication, file: path.join(path.dirname(publication.file), 'control.json.test.cleanup') }
    const backend = manager()
    await backend.start()
    vi.mocked(removeControlFile).mockRejectedValueOnce(new ControlCleanupError('tombstone is still open', tombstone))

    await expect(backend.stop()).rejects.toThrow('tombstone is still open')
    expect(backend.getState()).toMatchObject({ phase: 'failed', baseUrl: undefined, wsUrl: undefined })
    await backend.stop()
    expect(vi.mocked(removeControlFile).mock.calls).toEqual([[publication], [tombstone]])
    await backend.stop()
    expect(removeControlFile).toHaveBeenCalledTimes(2)
  })

  it('retries publication after its cause has been fixed, and stops without replaying the old error', async () => {
    vi.mocked(publishControlFile).mockRejectedValueOnce(new Error('private directory unavailable'))
    const backend = manager()

    await backend.start()
    expect(backend.getState()).toMatchObject({ phase: 'failed', error: expect.stringContaining('private directory unavailable') })
    expect(removeControlFile).not.toHaveBeenCalled()

    await backend.restart()
    expect(backend.getState()).toMatchObject({ phase: 'ready', runtime: { kind: 'attached' } })
    expect(publishControlFile).toHaveBeenCalledTimes(2)
    await expect(backend.stop()).resolves.toBeUndefined()
    expect(removeControlFile).toHaveBeenCalledExactlyOnceWith(publication)
    expect(backend.getState().phase).toBe('stopped')
  })

  it('keeps a failed cleanup pending and retries only that publication on the next stop', async () => {
    const backend = manager()
    await backend.start()
    vi.mocked(removeControlFile).mockRejectedValueOnce(new Error('file temporarily open'))

    await expect(backend.stop()).rejects.toThrow('file temporarily open')
    await expect(backend.stop()).resolves.toBeUndefined()
    expect(vi.mocked(removeControlFile).mock.calls).toEqual([[publication], [publication]])
    await backend.stop()
    expect(removeControlFile).toHaveBeenCalledTimes(2)
  })

  it('does not publish over failed restart cleanup, but recovers on a subsequent restart', async () => {
    const backend = manager()
    await backend.start()
    vi.mocked(removeControlFile).mockRejectedValueOnce(new Error('cleanup blocked'))
    vi.mocked(publishControlFile).mockResolvedValueOnce(replacement)

    await expect(backend.restart()).rejects.toThrow('cleanup blocked')
    expect(backend.getState()).toMatchObject({ phase: 'failed', baseUrl: undefined, wsUrl: undefined })
    expect(publishControlFile).toHaveBeenCalledTimes(1)

    await backend.restart()
    expect(backend.getState().phase).toBe('ready')
    expect(vi.mocked(removeControlFile).mock.calls).toEqual([[publication], [publication]])
    expect(publishControlFile).toHaveBeenCalledTimes(2)
    await backend.stop()
    expect(removeControlFile).toHaveBeenLastCalledWith(replacement)
  })

  it('serializes stop behind an in-flight publish and retries failed cancellation cleanup', async () => {
    const entered = deferred<void>()
    const publishing = deferred<ControlPublication>()
    vi.mocked(publishControlFile).mockImplementationOnce(() => {
      entered.resolve(undefined)
      return publishing.promise
    })
    vi.mocked(removeControlFile).mockRejectedValueOnce(new Error('first removal blocked'))
    const backend = manager()
    const phases: string[] = []
    backend.onState(state => phases.push(state.phase))

    const starting = backend.start()
    await entered.promise
    const stopping = backend.stop()
    expect(removeControlFile).not.toHaveBeenCalled()
    publishing.resolve(publication)

    await Promise.all([starting, stopping])
    expect(vi.mocked(removeControlFile).mock.calls).toEqual([[publication], [publication]])
    expect(publishControlFile).toHaveBeenCalledTimes(1)
    expect(phases).not.toContain('ready')
    expect(backend.getState().phase).toBe('stopped')
    await backend.stop()
    expect(removeControlFile).toHaveBeenCalledTimes(2)
  })
})
