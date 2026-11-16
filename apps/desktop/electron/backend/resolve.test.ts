import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const aliasNative = vi.hoisted(() => ({ require: vi.fn(), load: vi.fn(), open: vi.fn(), info: vi.fn(), close: vi.fn() }))
vi.mock('node:module', async importOriginal => ({
  ...await importOriginal<typeof import('node:module')>(),
  createRequire: () => aliasNative.require
}))
import { checkoutRuntime, pathRuntime, pendingInstall, resolveBackendRuntime } from './resolve.ts'

let dir: string
const launcherName = process.platform === 'win32' ? 'hermes.exe' : 'hermes'
const launcherPath = path.join('.hermes', 'bin', launcherName)
const pythonPath = path.join('venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')

function write(file: string, text: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { mode })
}

/** A Hermes Agent checkout with its `serve` subcommand and these executables (paths in the checkout). */
function checkout(root: string, executables: string[]): string {
  write(path.join(root, 'hermes_cli', 'subcommands', 'dashboard.py'), '')

  for (const file of executables) {
    write(path.join(root, file), '#!/bin/sh\n', 0o755)
  }

  return root
}

beforeEach(() => {
  for (const mock of Object.values(aliasNative)) mock.mockReset()
  aliasNative.require.mockImplementation(() => { throw new Error('Native alias fixture not enabled') })
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-resolve-'))
  vi.stubEnv('HERMES_HOME', path.join(dir, '.hermes'))
  vi.stubEnv('PATH', path.join(dir, 'empty'))
  vi.stubEnv('HERALD_OS_HERMES_ROOT', undefined)
  vi.stubEnv('HERMES_OS_HERMES_ROOT', undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('checkoutRuntime', () => {
  it("runs the launcher today's installers publish", () => {
    const root = checkout(path.join(dir, 'agent'), [launcherPath])

    expect(checkoutRuntime(root, 'managed', 'managed Hermes install')).toEqual({ kind: 'managed', label: 'managed Hermes install', root, command: [path.join(root, launcherPath)] })
  })

  it("runs an earlier installer's venv", () => {
    const root = checkout(path.join(dir, 'agent'), [pythonPath])

    expect(checkoutRuntime(root, 'env', 'override')?.command).toEqual([path.join(root, pythonPath), '-m', 'hermes_cli.main'])
  })

  it('prefers the launcher when an update left the old venv behind', () => {
    const root = checkout(path.join(dir, 'agent'), [pythonPath, launcherPath])

    expect(checkoutRuntime(root, 'managed', 'managed Hermes install')?.command).toEqual([path.join(root, launcherPath)])
  })

  it('needs the serve subcommand and something that runs', () => {
    const bare = path.join(dir, 'bare')
    write(path.join(bare, launcherPath), '#!/bin/sh\n', 0o755)
    expect(checkoutRuntime(bare, 'managed', 'x')).toBeNull()

    const cloned = checkout(path.join(dir, 'cloned'), [])
    expect(checkoutRuntime(cloned, 'managed', 'x')).toBeNull()

    // A launcher that cannot run is no launcher; the venv beside it still counts.
    if (process.platform === 'win32') {
      // Windows does not use the POSIX executable bit; a directory is never a launcher.
      fs.mkdirSync(path.join(cloned, launcherPath), { recursive: true })
    } else {
      write(path.join(cloned, launcherPath), '#!/bin/sh\n', 0o644)
    }
    expect(checkoutRuntime(cloned, 'managed', 'x')).toBeNull()
    write(path.join(cloned, pythonPath), '#!/bin/sh\n', 0o755)
    expect(checkoutRuntime(cloned, 'managed', 'x')?.command[0]).toBe(path.join(cloned, pythonPath))
  })
})

describe('resolveBackendRuntime', () => {
  it('finds the managed install in either layout', () => {
    const managed = path.join(dir, '.hermes', 'hermes-agent')
    const bin = path.join(dir, 'path')
    write(path.join(bin, 'hermes-canary.exe'), '', 0o755)
    vi.stubEnv('PATH', bin)
    checkout(managed, [launcherPath])

    expect(resolveBackendRuntime()).toMatchObject({ kind: 'managed', root: managed, command: [path.join(managed, launcherPath)] })

    fs.rmSync(path.join(managed, '.hermes'), { recursive: true })
    checkout(managed, [pythonPath])
    expect(resolveBackendRuntime()).toMatchObject({ kind: 'managed', command: [path.join(managed, pythonPath), '-m', 'hermes_cli.main'] })
  })

  it('puts HERALD_OS_HERMES_ROOT first', () => {
    checkout(path.join(dir, '.hermes', 'hermes-agent'), [launcherPath])
    const own = checkout(path.join(dir, 'own'), [launcherPath])
    const bin = path.join(dir, 'path')
    write(path.join(bin, 'hermes-canary.exe'), '', 0o755)
    vi.stubEnv('PATH', bin)
    vi.stubEnv('HERALD_OS_HERMES_ROOT', own)

    expect(resolveBackendRuntime()).toMatchObject({ kind: 'env', root: own })
  })
})

describe('pathRuntime', () => {
  it("finds the installer's ~/.local/bin command when PATH does not name it", () => {
    const bin = path.join(dir, '.local', 'bin')
    write(path.join(bin, launcherName), '#!/bin/sh\nexec /home/a/.hermes/hermes-agent/.hermes/bin/hermes "$@"\n', 0o755)

    expect(pathRuntime([])).toBeNull()
    expect(pathRuntime([bin])).toEqual({ kind: 'path', label: `hermes on PATH (${path.join(bin, launcherName)})`, command: [path.join(bin, launcherName)] })
  })

  it.each(['PATH', 'extraDirs'])('prefers a stable launcher in later %s directories over an earlier Windows alias', location => {
    const first = path.join(dir, 'first'), later = path.join(dir, 'later')
    write(path.join(first, 'hermes-canary.exe'), '', 0o755)
    const stable = path.join(later, launcherName)
    write(stable, '', 0o755)
    vi.stubEnv('PATH', location === 'PATH' ? [first, later].join(path.delimiter) : first)

    expect(pathRuntime(location === 'extraDirs' ? [later] : [])?.command).toEqual([stable])
  })

  it.each(process.platform === 'win32' ? ['hermes.exe', 'hermes-canary.exe'] : ['hermes'])('preserves directory order for %s', name => {
    const first = path.join(dir, 'first'), later = path.join(dir, 'later')
    write(path.join(first, name), '', 0o755)
    write(path.join(later, name), '', 0o755)
    vi.stubEnv('PATH', first)

    expect(pathRuntime([later])?.command).toEqual([path.join(first, name)])
  })

  it.each(['PATH', 'extraDirs'])('discovers the alias in %s only on Windows when no stable launcher exists', location => {
    const bin = path.join(dir, 'WindowsApps'), alias = path.join(bin, 'hermes-canary.exe')
    write(alias, '', 0o755)
    if (location === 'PATH') vi.stubEnv('PATH', bin)

    expect(pathRuntime(location === 'extraDirs' ? [bin] : [])).toEqual(process.platform === 'win32'
      ? { kind: 'path', label: `hermes on PATH (${alias})`, command: [alias] }
      : null)
  })

  it('returns unavailable for missing launchers and directories named like launchers', () => {
    const bin = path.join(dir, 'unavailable')
    expect(pathRuntime([bin])).toBeNull()
    fs.mkdirSync(path.join(bin, launcherName), { recursive: true })
    fs.mkdirSync(path.join(bin, 'hermes-canary.exe'))
    expect(pathRuntime([bin])).toBeNull()
  })
})

describe.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('Windows AppExecutionAlias metadata', () => {
  function aliasFixture(name = 'hermes-canary.exe'): string {
    const alias = path.join(dir, 'WindowsApps', name)
    write(alias, '', 0o755)
    vi.stubEnv('PATH', path.dirname(alias))
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const stat = fs.statSync.bind(fs)
    vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, options?: fs.StatOptions) => {
      if (file === alias) throw Object.assign(new Error('Protected package target'), { code: 'EACCES' })
      return stat(file, options as undefined)
    }) as typeof fs.statSync)
    aliasNative.open.mockReturnValue(123n)
    aliasNative.info.mockImplementation((_handle, _kind, data: Buffer) => {
      data.writeUInt32LE(0x420, 0)
      data.writeUInt32LE(0x8000001b, 4)
      return 1
    })
    aliasNative.close.mockReturnValue(1)
    aliasNative.load.mockReturnValue({ func: (signature: string) => {
      if (signature.includes('CreateFileW')) return aliasNative.open
      if (signature.includes('GetFileInformationByHandleEx')) return aliasNative.info
      if (signature.includes('CloseHandle')) return aliasNative.close
      throw new Error('Unexpected native binding')
    } })
    aliasNative.require.mockReturnValue({ load: aliasNative.load })
    return alias
  }

  it.each(['hermes.exe', 'hermes-canary.exe'])('recognizes %s without following its protected package target', name => {
    const alias = aliasFixture(name)
    const readlink = vi.spyOn(fs, 'readlinkSync')
    expect(pathRuntime([])?.command).toEqual([alias])
    expect(aliasNative.require).toHaveBeenCalledWith('koffi')
    expect(aliasNative.load).toHaveBeenCalledWith('C:\\Windows\\System32\\kernel32.dll')
    expect(aliasNative.open).toHaveBeenCalledWith(alias, 0x80, 7, null, 3, 0x00200000, null)
    expect(aliasNative.info).toHaveBeenCalledWith(123n, 9, expect.any(Buffer), 8)
    expect(aliasNative.close).toHaveBeenCalledExactlyOnceWith(123n)
    expect(readlink).not.toHaveBeenCalled()
  })

  it.each([
    ['ordinary symlink', 0x420, 0xa000000c], ['junction', 0x420, 0xa0000003],
    ['regular file', 0x20, 0], ['directory', 0x430, 0x8000001b],
    ['missing reparse attribute', 0x20, 0x8000001b]
  ])('rejects a fallback %s and closes its handle', (_kind, attributes, tag) => {
    aliasFixture()
    aliasNative.info.mockImplementation((_handle, _kind, data: Buffer) => {
      data.writeUInt32LE(attributes as number, 0); data.writeUInt32LE(tag as number, 4); return 1
    })
    expect(pathRuntime([])).toBeNull()
    expect(aliasNative.close).toHaveBeenCalledExactlyOnceWith(123n)
  })

  it.each([null, 0xffffffffffffffffn])('rejects invalid handle %s without closing it', handle => {
    aliasFixture(); aliasNative.open.mockReturnValue(handle)
    expect(pathRuntime([])).toBeNull()
    expect(aliasNative.info).not.toHaveBeenCalled()
    expect(aliasNative.close).not.toHaveBeenCalled()
  })

  it.each(['query failed', 'query threw', 'close failed', 'load failed'])('fails closed when %s', failure => {
    aliasFixture()
    if (failure === 'query failed') aliasNative.info.mockReturnValue(0)
    if (failure === 'query threw') aliasNative.info.mockImplementation(() => { throw new Error('query') })
    if (failure === 'close failed') aliasNative.close.mockReturnValue(0)
    if (failure === 'load failed') aliasNative.load.mockImplementation(() => { throw new Error('load') })
    expect(pathRuntime([])).toBeNull()
    if (failure === 'load failed') expect(aliasNative.close).not.toHaveBeenCalled()
    else expect(aliasNative.close).toHaveBeenCalledExactlyOnceWith(123n)
  })

  it('keeps the visibility gate before native loading', () => {
    const alias = aliasFixture()
    const access = fs.accessSync.bind(fs)
    vi.spyOn(fs, 'accessSync').mockImplementation((file, mode) => {
      if (file === alias) throw Object.assign(new Error('Not visible'), { code: 'EACCES' })
      return access(file, mode)
    })
    expect(pathRuntime([])).toBeNull()
    expect(aliasNative.load).not.toHaveBeenCalled()
  })

  it.each([undefined, 'relative-windows', '\\\\server\\windows'])('does not load native code for an invalid SystemRoot: %s', root => {
    aliasFixture()
    vi.stubEnv('SystemRoot', root)
    expect(pathRuntime([])).toBeNull()
    expect(aliasNative.require).not.toHaveBeenCalled()
  })

  it.each(['relative-bin', '\\\\server\\share', '\\\\?\\C:\\aliases'])('does not use native fallback for a non-local-drive candidate: %s', bin => {
    aliasFixture()
    vi.stubEnv('PATH', bin)
    // Stub both ordinary checks so this lexical-boundary test never touches the supplied paths.
    vi.spyOn(fs, 'accessSync').mockImplementation(() => undefined)
    vi.spyOn(fs, 'statSync').mockImplementation(() => { throw new Error('Ordinary file check failed') })
    expect(pathRuntime([])).toBeNull()
    expect(aliasNative.require).not.toHaveBeenCalled()
  })

  it('does not apply alias admission to a managed checkout', () => {
    const alias = aliasFixture()
    const root = checkout(path.join(dir, 'managed'), [launcherPath])
    const target = path.join(root, launcherPath)
    const stat = fs.statSync.bind(fs)
    vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, options?: fs.StatOptions) => {
      if (file === target) throw new Error('Protected checkout target')
      return stat(file, options as undefined)
    }) as typeof fs.statSync)
    expect(checkoutRuntime(root, 'managed', 'managed')).toBeNull()
    expect(aliasNative.open).not.toHaveBeenCalled()
    expect(pathRuntime([])?.command).toEqual([alias])
  })

  it('retains stable-alias priority over an earlier canary file', () => {
    const alias = aliasFixture('hermes.exe')
    const first = path.join(dir, 'earlier')
    write(path.join(first, 'hermes-canary.exe'), '', 0o755)
    vi.stubEnv('PATH', [first, path.dirname(alias)].join(path.delimiter))
    expect(pathRuntime([])?.command).toEqual([alias])
  })
})

describe('pendingInstall', () => {
  it("reads the image's note on installing Hermes", () => {
    const note = path.join(dir, 'hermes-pending')
    expect(pendingInstall(note)).toBeNull()

    write(note, 'offline\n')
    expect(pendingInstall(note)).toBe('offline')

    write(note, '')
    expect(pendingInstall(note)).toBe('pending')
  })
})
