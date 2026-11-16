import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shell } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc.ts'
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) }, shell: { openPath: vi.fn(), showItemInFolder: vi.fn() } }))
vi.mock('../platform/index.ts', () => ({ hostPlatform: vi.fn() }))
const { normalizeUserPath, assertWritable, registerFsIpc } = await import('./fs.ts')
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', platform)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('fully qualified Windows path syntax', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\Example')
  })
  it('expands home and accepts local drive paths without touching them', () => {
    expect(normalizeUserPath('~\\Report.txt')).toBe('C:\\Users\\Example\\Report.txt')
    expect(normalizeUserPath('C:/Work/a.txt')).toBe('C:\\Work\\a.txt')
  })
  it.each([String.raw`\\server\share\a.txt`, '//server/share/a.txt', String.raw`\\?\UNC\server\share\a.txt`, String.raw`\\.\pipe\name`, String.raw`\??\C:\file`])('rejects network/device input before IPC file access: %s', async target => {
    const readdir = vi.spyOn(fs.promises, 'readdir').mockRejectedValue(new Error('unexpected filesystem I/O'))
    const stat = vi.spyOn(fs.promises, 'stat').mockRejectedValue(new Error('unexpected filesystem I/O'))
    const realpath = vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => { throw new Error('unexpected filesystem I/O') })
    expect(() => normalizeUserPath(target)).toThrow(/UNC|device/)
    registerFsIpc(() => null)
    for (const channel of [IPC.fsReadDir, IPC.fsReadFile, IPC.fsDirSize, IPC.fsOpenPath]) {
      await expect(handlers.get(channel)!({}, target)).rejects.toThrow(/UNC|device/)
    }
    expect(readdir).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
    expect(realpath).not.toHaveBeenCalled()
    expect(shell.openPath).not.toHaveBeenCalled()
  })
  it.each(['D:\\outside\\a.txt', 'C:\\Users\\Example-other\\a.txt'])('rejects an outside target before filesystem I/O: %s', async target => {
    vi.spyOn(os, 'tmpdir').mockReturnValue('C:\\PrivateTemp')
    const realpath = vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => { throw new Error('unexpected filesystem probe') })
    const stat = vi.spyOn(fs.promises, 'stat').mockRejectedValue(new Error('unexpected stat'))
    expect(() => assertWritable(target)).toThrow('only edits')
    registerFsIpc(() => null)
    await expect(handlers.get(IPC.fsListTree)!({}, target, 20)).rejects.toThrow('project folders')
    await expect(handlers.get(IPC.fsWatchTree)!({ sender: {} }, target)).rejects.toThrow('project folders')
    expect(realpath).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
  })
  it.each(['C:relative', '\\implicit', '\\\\?\\C:\\file', '\\\\.\\pipe\\x', 'C:\\a.txt:stream', 'C:\\folder.\\file', 'C:\\folder \\file', 'C:\\nul.txt', 'C:\\a\0.txt'])('rejects ambiguous or device path %s', value => {
    expect(() => normalizeUserPath(value)).toThrow()
  })
})

describe.skipIf(process.platform !== 'win32')('native writable destination confinement', () => {
  let home: string, temporary: string, outside: string
  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-path-boundaries-'))
    roots.push(root)
    home = path.join(root, 'Home')
    temporary = path.join(root, 'Temp')
    outside = path.join(root, 'Outside')
    for (const item of [home, temporary, outside]) fs.mkdirSync(item)
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    vi.spyOn(os, 'tmpdir').mockReturnValue(temporary)
  })
  it('accepts case variants, new descendants and its explicit temp root', () => {
    expect(assertWritable(path.join(home.toUpperCase(), 'New', 'Report.txt')).toLowerCase()).toBe(path.join(home, 'New', 'Report.txt').toLowerCase())
    expect(assertWritable(path.join(temporary, 'Export.pdf'))).toBe(path.join(temporary, 'Export.pdf'))
    expect(() => assertWritable(path.join(home + '-other', 'file'))).toThrow('only edits')
    expect(() => assertWritable(path.join(outside, 'file'))).toThrow('only edits')
  })
  it('protects case variants of SSH and junction aliases into SSH', () => {
    fs.mkdirSync(path.join(home, '.ssh'))
    expect(() => assertWritable(path.join(home, '.SSH', 'key'))).toThrow('protected')
    const alias = path.join(home, 'alias')
    fs.symlinkSync(path.join(home, '.ssh'), alias, 'junction')
    expect(() => assertWritable(path.join(alias, 'key'))).toThrow('protected')
  })
  it('rejects a junction escape for existing and new destination suffixes', () => {
    const alias = path.join(home, 'escape')
    fs.symlinkSync(outside, alias, 'junction')
    fs.writeFileSync(path.join(outside, 'existing.txt'), 'disposable fixture')
    expect(() => assertWritable(path.join(alias, 'existing.txt'))).toThrow('only edits')
    expect(() => assertWritable(path.join(alias, 'new', 'file.txt'))).toThrow('only edits')
  })
  it('protects an SSH directory even when it itself resolves into the temp root', () => {
    fs.mkdirSync(path.join(temporary, 'keys'))
    fs.symlinkSync(path.join(temporary, 'keys'), path.join(home, '.ssh'), 'junction')
    expect(() => assertWritable(path.join(home, '.ssh', 'key'))).toThrow('protected')
    expect(() => assertWritable(path.join(temporary, 'keys', 'key'))).toThrow('protected')
  })
})

describe('Unix path contract', () => {
  it('preserves home and protected/root boundaries without native Windows lookups', () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    vi.spyOn(os, 'homedir').mockReturnValue('/home/example')
    expect(normalizeUserPath('~/notes')).toBe('/home/example/notes')
    expect(assertWritable('/home/example/file')).toBe('/home/example/file')
    expect(assertWritable('/tmp/file')).toBe('/tmp/file')
    expect(() => assertWritable('/home/example-other/file')).toThrow()
    expect(() => assertWritable('/home/example/.ssh/key')).toThrow('protected')
    expect(() => assertWritable('/usr/file')).toThrow()
  })
})
