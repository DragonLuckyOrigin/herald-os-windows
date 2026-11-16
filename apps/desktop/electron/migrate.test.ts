import fs from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateLegacyData } from './migrate.ts'

let root = ''
let fixtureOwner: unknown
  function native() {
    const ffi = createRequire(import.meta.url)('koffi') as typeof import('koffi')
    const kernel = ffi.load(path.join(process.env.SystemRoot!, 'System32/kernel32.dll'))
    const open = kernel.func('void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)')
    const close = kernel.func('int __stdcall CloseHandle(void *handle)')
    return {
      open: (file: string) => {
        const h = open(file, 0x40000000 | 0x10000, 1, null, 2, 0x04000000, null)
        return h && ffi.address(h) !== 0xffffffffffffffffn ? h : null
      },
      close
    }
  }



function write(rel: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

function read(rel: string): string | null {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8')
  } catch {
    return null
  }
}

function locations() {
  return { hermesHome: path.join(root, '.hermes'), appData: path.join(root, 'appData'), userData: path.join(root, 'appData', 'Herald OS'), userDataWasEmpty: true }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-migrate-'))
  if (process.platform === 'win32') {
    fs.mkdirSync(locations().userData, { recursive: true })
    fixtureOwner = native().open(path.join(locations().userData, 'lockfile'))
    expect(fixtureOwner).not.toBeNull()
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  if (fixtureOwner) { native().close(fixtureOwner); fixtureOwner = undefined }
  fs.rmSync(root, { recursive: true, force: true })
})

describe('portable migration skips', () => {
  it('does not inspect or adopt legacy data into the permanent DRAGON profile', () => {
    write('appData/Hermes OS/Preferences', 'legacy browser state')
    write('.hermes/hermes-os/prefs.json', '{"theme":"legacy"}')
    const inspect = vi.spyOn(fs, 'lstatSync')
    const userData = path.join(root, 'appData', 'DRAGON OS')
    expect(migrateLegacyData({ ...locations(), userData }).status).toBe('skipped')
    expect(inspect).not.toHaveBeenCalled()
    expect(fs.existsSync(userData)).toBe(false)
    expect(read('.hermes/herald-os/prefs.json')).toBeNull()
    expect(read('appData/Hermes OS/Preferences')).toBe('legacy browser state')
  })

  it('does not inspect any filesystem path in development', () => {
    const inspect = vi.spyOn(fs, 'lstatSync').mockImplementation(() => { throw new Error('unexpected inspection') })
    expect(migrateLegacyData({ ...locations(), isDev: true }).status).toBe('skipped')
    expect(inspect).not.toHaveBeenCalled()
  })
  it('leaves a fresh install without migration metadata', () => {
    expect(migrateLegacyData(locations()).status).toBe('no-source')
    expect(read('appData/Herald OS/.herald-legacy-migration-v1.json')).toBeNull()
  })
  it('leaves a noncanonical profile override untouched', () => {
    write('appData/Hermes OS/Preferences', 'legacy')
    expect(migrateLegacyData({ ...locations(), userData: path.join(root, 'override') }).status).toBe('skipped')
    expect(read('override/Preferences')).toBeNull()
  })
})

describe.skipIf(process.platform !== 'win32')('migrateLegacyData', () => {
  it('copies the Hermes home folder and profile with mapped partitions, preserving every source', () => {
    write('.hermes/hermes-os/prefs.json', '{"theme":"ice"}')
    write('.hermes/hermes-os/permissions.yaml', 'tiers: {}')
    write('appData/Hermes OS/Local Storage/leveldb/000003.log', 'ls')
    write('appData/Hermes OS/Partitions/hermes-web/Cookies', 'cookies')
    write('appData/Hermes OS/Partitions/hermes-preview/Cookies', 'preview')

    migrateLegacyData(locations())
    expect(read('.hermes/herald-os/prefs.json')).toBe('{"theme":"ice"}')
    expect(read('.hermes/herald-os/permissions.yaml')).toBe('tiers: {}')
    expect(read('.hermes/hermes-os/prefs.json')).toBe('{"theme":"ice"}')
    expect(read('appData/Herald OS/Local Storage/leveldb/000003.log')).toBe('ls')
    expect(read('appData/Herald OS/Partitions/herald-web/Cookies')).toBe('cookies')
    expect(read('appData/Herald OS/Partitions/herald-preview/Cookies')).toBe('preview')
    expect(read('appData/Hermes OS/Partitions/hermes-web/Cookies')).toBe('cookies')
  })

  it('keeps a populated destination without merging legacy shell settings', () => {
    write('.hermes/hermes-os/permissions.yaml', 'custom policy')
    write('.hermes/hermes-os/audit.jsonl', 'old audit')
    write('.hermes/herald-os/audit.jsonl', 'new audit')

    migrateLegacyData(locations())

    expect(read('.hermes/herald-os/permissions.yaml')).toBeNull()
    expect(read('.hermes/herald-os/audit.jsonl')).toBe('new audit')
    expect(read('.hermes/hermes-os/audit.jsonl')).toBe('old audit')
  })

  it('preserves the existing destination root while copying an empty profile', () => {
    write('appData/Hermes OS/Local Storage/leveldb/000003.log', 'ls')
    fs.mkdirSync(path.join(root, 'appData/Herald OS'), { recursive: true })

    migrateLegacyData(locations())

    expect(read('appData/Herald OS/Local Storage/leveldb/000003.log')).toBe('ls')
    expect(read('appData/Hermes OS/Local Storage/leveldb/000003.log')).toBe('ls')
  })

  it('never replaces an existing profile', () => {
    write('appData/Hermes OS/Preferences', 'old')
    write('appData/Herald OS/Preferences', 'new')

    migrateLegacyData(locations())

    expect(read('appData/Herald OS/Preferences')).toBe('new')
    expect(read('appData/Hermes OS/Preferences')).toBe('old')
  })

  it('is a no-op on a fresh install and when run twice', () => {
    migrateLegacyData(locations())
    write('.hermes/hermes-os/prefs.json')
    migrateLegacyData(locations())
    write('.hermes/herald-os/prefs.json', 'new ordinary preference')
    write('.hermes/hermes-os/prefs.json', 'retained source changed')
    migrateLegacyData(locations())
    expect(read('.hermes/herald-os/prefs.json')).toBe('new ordinary preference')
  })

  it('never removes or renames an owned profile directory', () => {
    write('appData/Hermes OS/Preferences', 'legacy')
    fs.mkdirSync(locations().userData, { recursive: true })
    const remove = vi.spyOn(fs, 'rmdirSync')
    const rename = vi.spyOn(fs, 'renameSync')
    migrateLegacyData(locations())
    expect(remove).not.toHaveBeenCalled()
    expect(rename.mock.calls.some(([from, to]) => from === locations().userData || to === locations().userData)).toBe(false)
  })

  it('skips all legacy access in development mode', () => {
    write('.hermes/hermes-os/prefs.json', 'legacy')
    migrateLegacyData({ ...locations(), isDev: true })
    expect(read('.hermes/herald-os/prefs.json')).toBeNull()
    expect(read('.hermes/hermes-os/prefs.json')).toBe('legacy')
  })

  it('skips migration into an overridden userData', () => {
    write('appData/Hermes OS/Preferences', 'legacy')
    migrateLegacyData({ ...locations(), userData: path.join(root, 'override') })
    expect(read('override/Preferences')).toBeNull()
  })

  it('blocks corrupt receipts instead of adopting an unknown partial target', () => {
    write('.hermes/hermes-os/prefs.json', 'legacy')
    write('.hermes/herald-os/.herald-legacy-migration-v1.json', '{broken')
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    expect(read('.hermes/herald-os/prefs.json')).toBeNull()
  })

  it('does not turn a source permission failure into success', () => {
    fs.mkdirSync(path.join(root, 'appData/Hermes OS'), { recursive: true })
    write('.hermes/hermes-os/prefs.json', 'legacy')
    const original = fs.readdirSync
    vi.spyOn(fs, 'readdirSync').mockImplementation(((target, ...args) => {
      if (String(target) === path.join(root, '.hermes/hermes-os')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return Reflect.apply(original, fs, [target, ...args])
    }) as typeof fs.readdirSync)
    const result = migrateLegacyData(locations())
    expect(result.status).toBe('blocked')
    expect(result.error).toContain('denied')
    expect(read('.hermes/hermes-os/prefs.json')).toBe('legacy')
  })
})

describe.skipIf(process.platform !== 'win32')('native migration recovery and ownership', () => {
  const receipt = '.hermes/herald-os/.herald-legacy-migration-v1.json'
  function seed(): void {
    fs.mkdirSync(path.join(root, 'appData/Hermes OS'), { recursive: true })
    write('.hermes/hermes-os/a.txt', 'first source')
    write('.hermes/hermes-os/b.txt', 'second source')
  }
  function interruptCopy(afterFirst = false): void {
    const original = fs.copyFileSync
    let calls = 0
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, flags) => {
      calls++
      if (!afterFirst || calls === 2) {
        fs.writeFileSync(to, 'truncated')
        throw Object.assign(new Error('injected interrupted copy'), { code: 'EIO' })
      }
      original(from, to, flags)
    })
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    vi.restoreAllMocks()
    expect(JSON.parse(read(receipt)!).state).toBe('incomplete')
  }
  it.each([false, true])('recovers a truncated stage and already published finals (prior publication=%s)', afterFirst => {
    seed()
    interruptCopy(afterFirst)
    expect(read('.hermes/herald-os/a.txt')).toBe(afterFirst ? 'first source' : null)
    const result = migrateLegacyData(locations())
    expect(result.status, result.error).toBe('completed')
    expect(read('.hermes/herald-os/a.txt')).toBe('first source')
    expect(read('.hermes/herald-os/b.txt')).toBe('second source')
    expect(read('.hermes/hermes-os/a.txt')).toBe('first source')
    expect(JSON.parse(read(receipt)!).state).toBe('complete')
    expect(fs.readdirSync(path.join(root, '.hermes/herald-os')).some(n => n.startsWith('.herald-legacy-stage-'))).toBe(false)
  })

  it.each(['source', 'target', 'unknown'])('blocks changed %s during incomplete recovery', where => {
    seed(); interruptCopy(true)
    if (where === 'source') write('.hermes/hermes-os/a.txt', 'changed source')
    if (where === 'target') write('.hermes/herald-os/a.txt', 'new target')
    if (where === 'unknown') write('.hermes/herald-os/unrecorded', 'unknown')
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    expect(read('.hermes/herald-os/b.txt')).toBeNull()
    if (where === 'target') expect(read('.hermes/herald-os/a.txt')).toBe('new target')
  })

  it.each(['../escape', '/absolute', 'C:/escape', 'a:stream', 'a./b', 'a//b', 'CON.txt', '\\\\server\\share'])('rejects receipt path %s', to => {
    seed(); interruptCopy()
    const value = JSON.parse(read(receipt)!)
    value.entries[0].to = to
    write(receipt, JSON.stringify(value))
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    expect(read('.hermes/herald-os/a.txt')).toBeNull()
  })

  it('rejects mismatched receipt roots before resuming', () => {
    seed(); interruptCopy()
    const value = JSON.parse(read(receipt)!)
    value.source = path.join(root, 'unrelated')
    write(receipt, JSON.stringify(value))
    expect(migrateLegacyData(locations()).status).toBe('blocked')
  })

  it('recovers a flushed initial receipt after an actual fixture process exit before publication', () => {
    seed()
    const script = `import fs from 'node:fs'; import { migrateLegacyData } from ${JSON.stringify(new URL('./migrate.ts', import.meta.url).href)};
      const original=fs.fsyncSync; fs.fsyncSync=(fd)=>{original(fd);process.exit(77)};
      migrateLegacyData(${JSON.stringify(locations())});`
    const exited = spawnSync(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, encoding: 'utf8' })
    expect(exited.status, exited.stderr).toBe(77)
    expect(read(receipt)).toBeNull()
    expect(migrateLegacyData(locations()).status).toBe('completed')
    expect(read('.hermes/herald-os/b.txt')).toBe('second source')
  })

  it('recovers an interruption during completion receipt publication', () => {
    seed()
    const original = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith('.json.next') && JSON.parse(fs.readFileSync(from, 'utf8')).state === 'complete') throw new Error('completion interrupted')
      original(from, to)
    })
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    vi.restoreAllMocks()
    expect(JSON.parse(read(receipt)!).state).toBe('incomplete')
    expect(migrateLegacyData(locations()).status).toBe('completed')
    expect(JSON.parse(read(receipt)!).state).toBe('complete')
  })

  it('blocks a torn pending receipt without deleting it or copying data', () => {
    seed()
    write(receipt + '.next', '{"version":')
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    expect(read(receipt + '.next')).toBe('{"version":')
    expect(read('.hermes/herald-os/a.txt')).toBeNull()
  })

  it('native no-replace publication preserves a racing destination', () => {
    seed()
    const original = fs.copyFileSync
    vi.spyOn(fs, 'copyFileSync').mockImplementationOnce((from, to, flags) => {
      original(from, to, flags)
      write('.hermes/herald-os/a.txt', 'concurrent destination')
    })
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    expect(read('.hermes/herald-os/a.txt')).toBe('concurrent destination')
    expect(read('.hermes/hermes-os/a.txt')).toBe('first source')
  })

  it('completed adoption allows later source removal and ordinary destination edits', () => {
    seed()
    expect(migrateLegacyData(locations()).status).toBe('completed')
    write('.hermes/herald-os/a.txt', 'ordinary edited preference')
    fs.unlinkSync(path.join(root, '.hermes/hermes-os/b.txt'))
    expect(migrateLegacyData(locations()).status).toBe('skipped')
    expect(read('.hermes/herald-os/a.txt')).toBe('ordinary edited preference')
  })

  it('rejects an active native legacy owner and releases all acquired handles', () => {
    seed()
    const api = native(), lock = path.join(root, 'appData/Hermes OS/lockfile')
    const handle = api.open(lock)
    expect(handle).not.toBeNull()
    try {
      expect(migrateLegacyData(locations()).status).toBe('blocked')
      expect(read('.hermes/herald-os/a.txt')).toBeNull()
    } finally { api.close(handle) }
    expect(migrateLegacyData(locations()).status).toBe('completed')
  })

  it('holds the native source interlock through copying and releases only its temporary artifact', () => {
    seed()
    const api = native(), lock = path.join(root, 'appData/Hermes OS/lockfile')
    const original = fs.copyFileSync
    let excluded = false
    vi.spyOn(fs, 'copyFileSync').mockImplementationOnce((from, to, flags) => {
      const other = api.open(lock)
      excluded = other === null
      if (other) api.close(other)
      original(from, to, flags)
    })
    expect(migrateLegacyData(locations()).status).toBe('completed')
    expect(excluded).toBe(true)
    expect(fs.existsSync(lock)).toBe(false)
    const next = api.open(lock)
    expect(next).not.toBeNull()
    api.close(next)
  })

  it('preserves a stale zero-byte source artifact and never transfers it', () => {
    seed(); write('appData/Hermes OS/lockfile', '')
    expect(migrateLegacyData(locations()).status).toBe('completed')
    expect(read('appData/Hermes OS/lockfile')).toBe('')
    expect(fs.statSync(path.join(locations().userData, 'lockfile')).size).toBe(0)
  })

  it('blocks an ambiguous nonempty source lock', () => {
    seed(); write('appData/Hermes OS/lockfile', 'not an Electron artifact')
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    expect(read('appData/Hermes OS/lockfile')).toBe('not an Electron artifact')
  })

  it('preserves an actually held destination singleton and root', () => {
    seed(); write('appData/Hermes OS/Preferences', 'legacy profile')
    fs.mkdirSync(locations().userData, { recursive: true })
    const api = native(), lock = path.join(locations().userData, 'lockfile')
    native().close(fixtureOwner); fixtureOwner = undefined
    const owner = api.open(lock)
    expect(owner).not.toBeNull()
    try {
      expect(migrateLegacyData(locations()).status).toBe('completed')
      expect(read('appData/Herald OS/Preferences')).toBe('legacy profile')
      const second = api.open(lock)
      if (second) api.close(second)
      expect(second).toBeNull()
    } finally { api.close(owner) }
  })

  it('does not guess ownership when only legacy shell data exists', () => {
    write('.hermes/hermes-os/prefs.json', 'legacy')
    const result = migrateLegacyData(locations())
    expect(result.status).toBe('blocked')
    expect(result.error).toContain('ownership domain is missing')
    expect(read('.hermes/herald-os/prefs.json')).toBeNull()
  })

  it('copies only absent in-place partition destinations without merging profiles', () => {
    write('appData/Herald OS/Preferences', 'current')
    write('appData/Herald OS/Partitions/hermes-web/Cookies', 'legacy web')
    write('appData/Herald OS/Partitions/hermes-preview/Cookies', 'legacy preview')
    write('appData/Herald OS/Partitions/herald-preview/Cookies', 'current preview')
    const result = migrateLegacyData({ ...locations(), userDataWasEmpty: false })
    expect(result.status, result.error).toBe('completed')
    expect(read('appData/Herald OS/Preferences')).toBe('current')
    expect(read('appData/Herald OS/Partitions/herald-web/Cookies')).toBe('legacy web')
    expect(read('appData/Herald OS/Partitions/herald-preview/Cookies')).toBe('current preview')
    expect(read('appData/Herald OS/Partitions/hermes-web/Cookies')).toBe('legacy web')
  })

  it('rejects a candidate junction without following or changing its destination', () => {
    fs.mkdirSync(path.join(root, 'appData/Hermes OS'), { recursive: true })
    write('outside/prefs.json', 'outside')
    fs.mkdirSync(path.join(root, '.hermes'), { recursive: true })
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, '.hermes/hermes-os'), 'junction')
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    expect(read('outside/prefs.json')).toBe('outside')
  })

  it('rejects source file hardlinks', () => {
    seed()
    fs.linkSync(path.join(root, '.hermes/hermes-os/a.txt'), path.join(root, 'alias'))
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    expect(read('alias')).toBe('first source')
  })

  it('rejects overlap between shell destinations and the legacy profile before mutation', () => {
    write('appData/Hermes OS/hermes-os/prefs.json', 'legacy')
    const result = migrateLegacyData({ ...locations(), hermesHome: path.join(root, 'appData/Hermes OS') })
    expect(result.status).toBe('blocked')
    expect(read('appData/Hermes OS/herald-os/prefs.json')).toBeNull()
  })

  it('does not delete an unrelated replacement of an interrupted staging file', () => {
    seed(); interruptCopy()
    const target = path.join(root, '.hermes/herald-os')
    const staged = path.join(target, fs.readdirSync(target).find(n => n.startsWith('.herald-legacy-stage-'))!)
    fs.renameSync(staged, path.join(root, 'retained-original-stage'))
    fs.writeFileSync(staged, 'unrelated replacement')
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    expect(fs.readFileSync(staged, 'utf8')).toBe('unrelated replacement')
  })

  it('validates an initial pending receipt before promoting or changing it', () => {
    seed(); interruptCopy()
    const value = JSON.parse(read(receipt)!)
    value.entries[0].sha256 = '0'.repeat(64)
    fs.unlinkSync(path.join(root, receipt))
    write(receipt + '.next', JSON.stringify(value))
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    expect(read(receipt)).toBeNull()
    expect(read(receipt + '.next')).toBe(JSON.stringify(value))
  })

  it('blocks a missing native destination owner before either plan writes', () => {
    seed()
    native().close(fixtureOwner); fixtureOwner = undefined
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    expect(read('.hermes/herald-os/a.txt')).toBeNull()
  })

  it('rejects relative supplied roots without filesystem mutation', () => {
    seed()
    const result = migrateLegacyData({ ...locations(), userData: path.relative(process.cwd(), locations().userData) })
    expect(result.status).toBe('blocked')
    expect(read('.hermes/herald-os/a.txt')).toBeNull()
  })

  it('retains an orphan stage created before its native identity could be recorded', () => {
    seed()
    const script = `import fs from 'node:fs'; import path from 'node:path'; import { migrateLegacyData } from ${JSON.stringify(new URL('./migrate.ts', import.meta.url).href)};
      const original=fs.openSync; fs.openSync=(file,...args)=>{if(String(file).endsWith('.json.next')&&fs.readdirSync(path.dirname(String(file))).some(n=>n.startsWith('.herald-legacy-stage-')))process.exit(78);return original(file,...args)};
      migrateLegacyData(${JSON.stringify(locations())});`
    const exited = spawnSync(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, encoding: 'utf8' })
    expect(exited.status, exited.stderr).toBe(78)
    const dir = path.join(root, '.hermes/herald-os')
    const stage = path.join(dir, fs.readdirSync(dir).find(n => n.startsWith('.herald-legacy-stage-'))!)
    const identity = fs.statSync(stage).ino
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    expect(fs.statSync(stage).ino).toBe(identity)
    expect(read('.hermes/herald-os/a.txt')).toBeNull()
  })

  it('cleans only newly created empty stages on an ordinary intent-write error so a later launch can recover', () => {
    seed()
    const original = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation(((file, ...args) => {
      if (String(file).endsWith('.json.next') && fs.readdirSync(path.dirname(String(file))).some(n => n.startsWith('.herald-legacy-stage-'))) throw new Error('intent write interrupted')
      return Reflect.apply(original, fs, [file, ...args])
    }) as typeof fs.openSync)
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    vi.restoreAllMocks()
    expect(migrateLegacyData(locations()).status).toBe('completed')
    expect(read('.hermes/herald-os/a.txt')).toBe('first source')
  })

  it('rejects a native short-path alias instead of trusting lexical overlap checks', context => {
    seed()
    const ffi = createRequire(import.meta.url)('koffi') as typeof import('koffi')
    const kernel = ffi.load(path.join(process.env.SystemRoot!, 'System32/kernel32.dll'))
    const shortPath = kernel.func('uint32_t __stdcall GetShortPathNameW(const char16_t *name, void *out, uint32_t length)')
    const buffer = Buffer.alloc(65536)
    const count = shortPath(root, buffer, 32768)
    expect(count).toBeGreaterThan(0)
    const alias = buffer.subarray(0, count * 2).toString('utf16le')
    if (alias.toLowerCase() === root.toLowerCase()) { context.skip('This fixture volume has no distinct 8.3 alias'); return }
    const result = migrateLegacyData({ ...locations(), hermesHome: path.join(alias, '.hermes') })
    expect(result.status).toBe('blocked')
    expect(read('.hermes/herald-os/a.txt')).toBeNull()
  })

  it('does not reject unrelated relative HOME syntax when there is no legacy candidate', () => {
    expect(migrateLegacyData({ ...locations(), hermesHome: path.relative(process.cwd(), path.join(root, 'unused')) }).status).toBe('no-source')
  })

  it('preserves distinct decomposed Unicode source filenames', () => {
    seed(); write('.hermes/hermes-os/re\u0301sume\u0301.docx', 'decomposed document')
    const result = migrateLegacyData(locations())
    expect(result.status, result.error).toBe('completed')
    expect(read('.hermes/herald-os/re\u0301sume\u0301.docx')).toBe('decomposed document')
  })

  it('bounds receipt-write volume for a many-file profile instead of rewriting its manifest per file', () => {
    seed()
    for (let i = 0; i < 32; i++) write('.hermes/hermes-os/file-' + i, 'fixture')
    const original = fs.writeFileSync
    let metadataBytes = 0
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file, data, ...args) => {
      if (typeof data === 'string' && data.startsWith('{"version":1')) metadataBytes += Buffer.byteLength(data)
      return Reflect.apply(original, fs, [file, data, ...args])
    }) as typeof fs.writeFileSync)
    expect(migrateLegacyData(locations()).status).toBe('completed')
    expect(metadataBytes).toBeLessThan(Buffer.byteLength(read(receipt)!) * 4)
  })

  it('rejects oversized serialized metadata before publishing an unreadable receipt', () => {
    seed()
    const original = JSON.stringify
    // Inject large valid serialized metadata at the serialization boundary without creating
    // hundreds of thousands of fixture files. Reader and writer must enforce the same byte cap.
    vi.spyOn(JSON, 'stringify').mockImplementation(((value, ...args) => {
      const encoded = Reflect.apply(original, JSON, [value, ...args])
      return value?.version === 1 ? encoded + ' '.repeat(32 * 1024 * 1024) : encoded
    }) as typeof JSON.stringify)
    const result = migrateLegacyData(locations())
    expect(result.status).toBe('blocked')
    expect(result.error).toContain('too large')
    expect(read(receipt)).toBeNull()
    expect(read(receipt + '.next')).toBeNull()
    expect(read('.hermes/herald-os/a.txt')).toBeNull()
  })

  it('closes a newly opened receipt descriptor if native identity inspection fails', () => {
    seed()
    const open = fs.openSync, inspect = fs.lstatSync
    let descriptor: number | undefined
    vi.spyOn(fs, 'openSync').mockImplementation(((file, ...args) => {
      const fd = Reflect.apply(open, fs, [file, ...args])
      if (String(file).endsWith('.json.next')) descriptor = fd
      return fd
    }) as typeof fs.openSync)
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file, ...args) => {
      if (descriptor !== undefined && String(file).endsWith('.json.next')) throw new Error('receipt identity inspection failed')
      return Reflect.apply(inspect, fs, [file, ...args])
    }) as typeof fs.lstatSync)
    expect(migrateLegacyData(locations()).status).toBe('blocked')
    vi.restoreAllMocks()
    expect(descriptor).toBeDefined()
    expect(() => fs.fstatSync(descriptor!)).toThrow()
  })
})
