import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, type TerminalCreateOptions, type TerminalHandle } from '../../shared/ipc.ts'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn(), spawn: vi.fn(), home: "C:\\Users\\Zoë & O'Connor" }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle, on: mocks.on } }))
vi.mock('node:module', () => ({
  createRequire: () => Object.assign(() => ({ spawn: mocks.spawn }), { resolve: () => 'C:\\fixtures\\node-pty\\lib\\index.js' })
}))
vi.mock('node:os', async importOriginal => { const actual = await importOriginal<typeof import('node:os')>(); return { ...actual, default: { ...actual, homedir: () => mocks.home } } })
vi.mock('../log.ts', () => ({ log: vi.fn() }))
vi.mock('./fs.ts', () => ({ normalizeUserPath: (value: string) => value }))
vi.mock('./catalog.ts', () => ({ loadCatalog: () => [{ id: 'agents', label: 'Agents', entries: [{ id: 'claude-code', label: 'Claude', terminal: true, bin: ['claude'], install: [] }] }] }))
const { registerTerminalIpc, terminalShell, ensureSpawnHelperExecutable, spawnHelperPaths } = await import('./terminal.ts')
const nativePlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function fakePty(pid = 1234) {
  let dataListener: (data: string) => void = () => undefined
  let exitListener: (event: { exitCode: number }) => void = () => undefined
  return {
    pid, write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: vi.fn((listener: typeof dataListener) => { dataListener = listener; return { dispose: vi.fn() } }),
    onExit: vi.fn((listener: typeof exitListener) => { exitListener = listener; return { dispose: vi.fn() } }),
    emitData: (data: string) => dataListener(data), emitExit: (exitCode: number) => exitListener({ exitCode })
  }
}
function owner() { return Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false }) }
function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = mocks.handle.mock.calls.find(call => call[0] === channel)?.[1]
  if (!handler) throw new Error('Missing IPC handler')
  return handler(...args)
}
function send(channel: string, ...args: unknown[]): void {
  const handler = mocks.on.mock.calls.find(call => call[0] === channel)?.[1]
  if (!handler) throw new Error('Missing IPC listener')
  handler(...args)
}
function create(sender: ReturnType<typeof owner>, options: Partial<TerminalCreateOptions> = {}): TerminalHandle {
  return invoke(IPC.terminalCreate, { sender }, { cols: 80, rows: 24, ...options }) as TerminalHandle
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { ...nativePlatform, value: 'win32' })
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  vi.stubEnv('SHELL', '/bin/bash')
  vi.spyOn(fs, 'existsSync').mockReturnValue(false)
  mocks.spawn.mockImplementation(() => fakePty())
  registerTerminalIpc(() => null)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', nativePlatform)
})

describe('terminal shell selection', () => {
  it('uses native PowerShell despite an inherited Unix shell', () => {
    expect(terminalShell('win32', { SystemRoot: 'D:\\Windows', SHELL: '/bin/bash' })).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(() => terminalShell('win32', { SystemRoot: 'relative' })).toThrow('SystemRoot')
    expect(terminalShell('darwin', {})).toBe('/bin/zsh')
    expect(terminalShell('linux', { SHELL: '/bin/fish' })).toBe('/bin/fish')
  })
})
describe('terminal IPC with mocked PTY', () => {
  it('passes native shell, literal Unicode cwd and bounded dimensions to ConPTY', () => {
    const handle = create(owner(), { cwd: "C:\\Work Ä & O'Connor", cols: 0, rows: 0 })
    const [shell, args, options] = mocks.spawn.mock.calls[0]
    expect(shell).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args).toEqual(['-NoLogo', '-NoProfile'])
    expect(options).toMatchObject({ cwd: "C:\\Work Ä & O'Connor", cols: 2, rows: 1, useConpty: true })
    expect(handle).toMatchObject({ id: 't1', pid: 1234, shell })
  })
  it('passes the selected catalog executable as data instead of PowerShell source', () => {
    const selected = path.join(mocks.home, '.local', 'bin', 'claude.exe')
    vi.mocked(fs.existsSync).mockImplementation(candidate => candidate === selected)
    create(owner(), { program: 'claude-code' })
    const [, args, options] = mocks.spawn.mock.calls[0]
    expect(options.env.HERALD_OS_TERMINAL_PROGRAM).toBe(selected)
    expect(args).toContain('-NoExit')
    const command = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
    expect(command).toContain('$env:HERALD_OS_TERMINAL_PROGRAM')
    expect(command).toContain('-CommandType Application')
    expect(command).not.toContain(selected)
  })
  it('rejects unknown catalog ids before spawning', () => {
    expect(() => create(owner(), { program: 'unknown' })).toThrow('not a terminal program')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('routes output and removes exited sessions', () => {
    const child = fakePty()
    mocks.spawn.mockReturnValueOnce(child)
    const sender = owner(), handle = create(sender)
    child.emitData('Grüße 世界')
    expect(sender.send).toHaveBeenCalledWith(IPC.terminalData, handle.id, 'Grüße 世界')
    child.emitExit(7)
    expect(sender.send).toHaveBeenCalledWith(IPC.terminalExit, handle.id, 7)
    send(IPC.terminalWrite, { sender }, handle.id, 'after exit')
    expect(child.write).not.toHaveBeenCalled()
  })
  it('writes, resizes, disposes and does not kill twice', () => {
    const child = fakePty()
    mocks.spawn.mockReturnValueOnce(child)
    const sender = owner(), handle = create(sender)
    send(IPC.terminalWrite, { sender }, handle.id, 'hello\r')
    send(IPC.terminalResize, { sender }, handle.id, 0, 0)
    expect(child.write).toHaveBeenCalledWith('hello\r')
    expect(child.resize).toHaveBeenCalledWith(2, 1)
    invoke(IPC.terminalDispose, { sender }, handle.id)
    sender.emit('destroyed')
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
  it.each(['did-navigate', 'destroyed'])('cleans only the owning page on %s', event => {
    const firstChild = fakePty(1), secondChild = fakePty(2)
    mocks.spawn.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    const first = owner(), second = owner()
    create(first); create(second)
    first.emit(event)
    expect(firstChild.kill).toHaveBeenCalledTimes(1)
    expect(secondChild.kill).not.toHaveBeenCalled()
    second.emit('destroyed')
    expect(secondChild.kill).toHaveBeenCalledTimes(1)
  })
})

describe('spawnHelperPaths', () => {
  it('looks outside app.asar, where a packaged app runs the helper from', () => {
    const resources = '/Applications/Herald OS.app/Contents/Resources'

    expect(spawnHelperPaths(`${resources}/app.asar/node_modules/node-pty/lib/index.js`, 'darwin', 'arm64')).toEqual([
      `${resources}/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper`,
      `${resources}/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`
    ].map(value => path.normalize(value)))
  })

  it('keeps the path of a checkout, or one already outside the archive', () => {
    expect(spawnHelperPaths('/Users/sam/Herald-OS/node_modules/node-pty/lib/index.js', 'darwin', 'x64')[1]).toBe(path.normalize('/Users/sam/Herald-OS/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper'))
    expect(spawnHelperPaths('/opt/herald-os/resources/app.asar.unpacked/node_modules/node-pty/lib/index.js', 'linux', 'arm64')[0]).toBe(path.normalize('/opt/herald-os/resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper'))
  })
})

describe('ensureSpawnHelperExecutable', () => {
  let root = ''

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  it.skipIf(nativePlatform.value === 'win32')('gives the prebuilt helper back the execute bit npm strips', () => {
    Object.defineProperty(process, 'platform', nativePlatform)
    vi.restoreAllMocks()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-'))
    const pty = path.join(root, 'node_modules', 'node-pty')
    const helper = path.join(pty, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    fs.mkdirSync(path.dirname(helper), { recursive: true })
    fs.writeFileSync(helper, '')
    fs.chmodSync(helper, 0o644)

    ensureSpawnHelperExecutable(path.join(pty, 'lib', 'index.js'))

    expect(fs.statSync(helper).mode & 0o777).toBe(0o755)
  })
})
