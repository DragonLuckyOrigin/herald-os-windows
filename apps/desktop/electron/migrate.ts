import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export interface LegacyLocations {
  hermesHome: string
  /** Actual Electron Known Folder for the current identity. */
  appData: string
  userData: string
  /** Observed before the caller obtained its still-held Electron singleton. */
  userDataWasEmpty?: boolean
  isDev?: boolean
}
export interface MigrationResult {
  status: 'no-source' | 'skipped' | 'completed' | 'blocked'
  messages: string[]
  error?: string
}
const RECEIPT = '.herald-legacy-migration-v1.json'
const NEXT = RECEIPT + '.next'
const STAGE = '.herald-legacy-stage-'
const MAX_RECEIPT_BYTES = 32 * 1024 * 1024
const PARTITIONS = ['web', 'viewer', 'preview']
const require = createRequire(import.meta.url)
type Entry = { from: string; to: string; kind: 'directory' } | { from: string; to: string; kind: 'file'; size: number; sha256: string }
type Kind = 'shell' | 'profile' | 'partitions'
interface Receipt {
  version: 1
  id: string
  state: 'incomplete' | 'complete'
  kind: Kind
  source: string
  target: string
  partitions: string[]
  entries: Entry[]
  stages: Record<string, { dev: string; ino: string }>
}
function stat(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function relativeName(name: string): void {
  if (!name || name.includes('\\') || name.startsWith('/') ||
      name.split('/').some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[ .]$/.test(p) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Migration contains an ambiguous relative path')
}
function canonical(file: string): string {
  if (!path.isAbsolute(file)) throw new Error('Migration requires absolute native paths')
  relativeName(file.slice(path.parse(file).root.length).split(path.sep).join('/'))
  const absolute = path.resolve(file)
  if (process.platform === 'win32' && !/^[a-z]:\\/i.test(absolute)) throw new Error('Migration requires local Windows paths')
  relativeName(absolute.slice(path.parse(absolute).root.length).split(path.sep).join('/'))
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
function contained(a: string, b: string): boolean { return b === a || b.startsWith(a + path.sep) }
function names(dir: string): string[] { return stat(dir) ? fs.readdirSync(dir).sort() : [] }
function regular(file: string): fs.Stats {
  const info = fs.lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Migration requires a regular single-link file')
  return info
}

/**
 * Electron 44.5.1 / Chromium 152.0.7977.130 process_singleton_win.cc holds root/lockfile
 * with GENERIC_WRITE, FILE_SHARE_READ and DELETE_ON_CLOSE. Reserve the legacy singleton
 * while retaining directory handles against replacement. Unsupported ownership fails closed.
 */
function windowsGuard() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Legacy ownership is not qualified on this platform')
  const system = process.env.SystemRoot
  if (!system || !/^[a-z]:[\\/]/i.test(system)) throw new Error('Windows system directory is unavailable')
  const ffi = require('koffi') as typeof import('koffi')
  const kernel = ffi.load(path.join(system, 'System32', 'kernel32.dll'))
  const open = kernel.func('void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)')
  const info = kernel.func('int __stdcall GetFileInformationByHandle(void *handle, void *information)')
  const close = kernel.func('int __stdcall CloseHandle(void *handle)')
  const last = kernel.func('uint32_t __stdcall GetLastError()')
  const move = kernel.func('int __stdcall MoveFileExW(const char16_t *from, const char16_t *to, uint32_t flags)')
  const finalPath = kernel.func('uint32_t __stdcall GetFinalPathNameByHandleW(void *handle, void *name, uint32_t length, uint32_t flags)')
  const handles: unknown[] = []
  const directories = new Set<string>()
  function acquire(file: string, access: number, share: number, disposition: number, flags: number): unknown {
    const handle = open(file, access, share, null, disposition, flags | 0x00200000, null)
    if (!handle || ffi.address(handle) === 0xffffffffffffffffn) throw new Error(`Migration cannot hold native ownership (Windows ${last()})`)
    handles.push(handle)
    return handle
  }
  function inspect(handle: unknown, directory: boolean): Buffer {
    const bytes = Buffer.alloc(52)
    if (!info(handle, bytes)) throw new Error('Migration cannot inspect native identity')
    const attrs = bytes.readUInt32LE(0)
    if ((attrs & 0x400) || Boolean(attrs & 0x10) !== directory || (!directory && bytes.readUInt32LE(40) !== 1)) throw new Error('Migration rejects reparse points and file aliases')
    return bytes
  }
  function holdDirectories(dir: string): void {
    const abs = path.resolve(dir), parent = path.dirname(abs), key = abs.toLowerCase()
    if (directories.has(key)) return
    if (parent !== abs) holdDirectories(parent)
    if (!stat(abs)) return
    const handle = acquire(abs, 0x80, 1 | 2, 3, 0x02000000)
    inspect(handle, true)
    const buffer = Buffer.alloc(65536)
    const count = finalPath(handle, buffer, 32768, 0) // Normalized DOS path, including 8.3/SUBST resolution.
    if (!count || count >= 32768) throw new Error('Migration cannot resolve native directory identity')
    const resolved = buffer.subarray(0, count * 2).toString('utf16le')
    if (!resolved.startsWith('\\\\?\\') || resolved.slice(4).toLowerCase() !== key) throw new Error('Migration rejects native path aliases')
    directories.add(key)
  }
  function lock(profile: string): void {
    holdDirectories(profile)
    if (!stat(profile)?.isDirectory()) throw new Error('Legacy profile ownership domain is missing')
    const file = path.join(profile, 'lockfile')
    if (stat(file)) {
      const held = inspect(acquire(file, 0x80000000, 1, 3, 0), false)
      if (held.readUInt32LE(32) || held.readUInt32LE(36)) throw new Error('Legacy lock artifact is ambiguous')
    } else {
      // Only our newly created native ownership artifact is removed on close, never source data.
      inspect(acquire(file, 0x40000000 | 0x00010000, 1, 1, 0x04000000), false)
    }
  }
  function ownArtifact(dir: string): boolean {
    if (!stat(path.join(dir, 'lockfile'))) return false
    const held = inspect(acquire(path.join(dir, 'lockfile'), 0x80, 1 | 2 | 4, 3, 0), false)
    if (held.readUInt32LE(32) || held.readUInt32LE(36)) throw new Error('Destination ownership artifact is ambiguous')
    return true
  }
  function holdFile(file: string): () => void {
    const handle = acquire(file, 0x80, 1 | 2, 3, 0)
    inspect(handle, false)
    return () => { const index = handles.indexOf(handle); if (index >= 0) { handles.splice(index, 1); close(handle) } }
  }
  return {
    holdDirectories, lock, ownArtifact, holdFile,
    // Same-volume native publication; absence of MOVEFILE_REPLACE_EXISTING is intentional.
    publish: (from: string, to: string) => { if (!move(from, to, 8)) throw new Error(`Migration exclusive publication failed (Windows ${last()})`) },
    close: () => { for (const handle of handles.reverse()) close(handle) }
  }
}
type Guard = ReturnType<typeof windowsGuard>
function safeTree(file: string, guard: Guard): void {
  guard.holdDirectories(path.dirname(file))
  const s = stat(file)
  if (s?.isSymbolicLink() || (s && !s.isDirectory() && !s.isFile())) throw new Error('Migration rejects reparse or special paths')
  if (s?.isDirectory()) guard.holdDirectories(file)
  else if (s) regular(file)
}
function digest(file: string): { size: number; sha256: string } {
  const fd = fs.openSync(file, 'r')
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1) throw new Error('Migration file identity is ambiguous')
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
    let size = 0, count: number
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) { hash.update(buffer.subarray(0, count)); size += count }
    const after = fs.fstatSync(fd)
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Migration source changed during verification')
    return { size, sha256: hash.digest('hex') }
  } finally { fs.closeSync(fd) }
}
function sameBytes(file: string, entry: Extract<Entry, { kind: 'file' }>): boolean {
  regular(file)
  const value = digest(file)
  return value.size === entry.size && value.sha256 === entry.sha256
}
function manifest(source: string, kind: Kind, partitions: string[], guard: Guard): Entry[] {
  const result: Entry[] = [], targets = new Set<string>()
  function visit(from: string, to: string): void {
    relativeName(from); relativeName(to)
    if (to.split('/').some(p => p.startsWith(STAGE) || p.startsWith(RECEIPT))) throw new Error('Legacy data conflicts with migration metadata')
    const key = to.toLowerCase()
    if (targets.has(key)) throw new Error('Legacy data contains colliding names')
    targets.add(key)
    const file = path.join(source, from)
    safeTree(file, guard)
    if (fs.lstatSync(file).isDirectory()) {
      result.push({ from, to, kind: 'directory' })
      for (const name of names(file)) visit(from + '/' + name, to + '/' + name)
    } else result.push({ from, to, kind: 'file', ...digest(file) })
  }
  if (kind === 'partitions') {
    for (const p of partitions) visit('Partitions/hermes-' + p, 'Partitions/herald-' + p)
  } else {
    for (const name of names(source)) {
      if (kind === 'profile' && name === 'lockfile') continue // Exact held native artifact.
      if (kind === 'profile' && name === 'Partitions') {
        safeTree(path.join(source, name), guard)
        result.push({ from: name, to: name, kind: 'directory' }); targets.add(name.toLowerCase())
        const children = names(path.join(source, name))
        for (const child of children) {
          const suffix = child.startsWith('hermes-') ? child.slice(7) : ''
          if (PARTITIONS.includes(suffix)) {
            if (!children.includes('herald-' + suffix)) visit(name + '/' + child, name + '/herald-' + suffix)
          } else visit(name + '/' + child, name + '/' + child)
        }
      } else visit(name, name)
    }
  }
  return result.sort((a, b) => a.to.localeCompare(b.to, 'en'))
}
function parseReceipt(file: string, source: string, target: string, kind?: Kind): Receipt {
  regular(file)
  if (fs.statSync(file).size > MAX_RECEIPT_BYTES) throw new Error('Migration receipt is too large')
  const r = JSON.parse(fs.readFileSync(file, 'utf8')) as Receipt
  if (!r || Object.keys(r).sort().join(',') !== 'entries,id,kind,partitions,source,stages,state,target,version' ||
      r.version !== 1 || !/^[a-f0-9-]{36}$/.test(r.id) || !['incomplete', 'complete'].includes(r.state) ||
      !['shell', 'profile', 'partitions'].includes(r.kind) || (kind && r.kind !== kind) ||
      r.source !== canonical(source) || r.target !== canonical(target) ||
      !Array.isArray(r.partitions) || r.partitions.some(p => !PARTITIONS.includes(p)) || new Set(r.partitions).size !== r.partitions.length ||
      (r.kind !== 'partitions' && r.partitions.length !== 0) || (r.kind === 'partitions' && !r.partitions.length) || !Array.isArray(r.entries) ||
      !r.stages || typeof r.stages !== 'object' || Array.isArray(r.stages)) throw new Error('Migration receipt identity or schema is invalid')
  const destinations = new Set<string>()
  for (const e of r.entries) {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') throw new Error('Migration receipt path is invalid')
    relativeName(e.from); relativeName(e.to)
    if (destinations.has(e.to.toLowerCase())) throw new Error('Migration receipt contains aliases')
    destinations.add(e.to.toLowerCase())
    const fields = Object.keys(e).sort().join(',')
    if (e.kind === 'directory' ? fields !== 'from,kind,to' :
      e.kind !== 'file' || fields !== 'from,kind,sha256,size,to' || !Number.isSafeInteger(e.size) || e.size < 0 || !/^[a-f0-9]{64}$/.test(e.sha256)) throw new Error('Migration receipt entry is invalid')
  }
  for (const [index, identity] of Object.entries(r.stages)) {
    if (!/^(0|[1-9][0-9]*)$/.test(index) || r.entries[Number(index)]?.kind !== 'file' || !identity ||
        Object.keys(identity).sort().join(',') !== 'dev,ino' || !/^\d+$/.test(identity.dev) || !/^\d+$/.test(identity.ino)) throw new Error('Migration staging identity is invalid')
  }
  return r
}
function stageName(r: Receipt, index: number): string { return STAGE + r.id + '-' + index }
function samePlan(a: Receipt, b: Receipt): boolean { return JSON.stringify({ ...a, state: 'incomplete', stages: {} }) === JSON.stringify({ ...b, state: 'incomplete', stages: {} }) }
function stagingIdentity(file: string): { dev: string; ino: string } {
  regular(file)
  const s = fs.lstatSync(file, { bigint: true })
  return { dev: String(s.dev), ino: String(s.ino) }
}
function verifyStage(file: string, r: Receipt, index: number): void {
  const expected = r.stages[String(index)]
  const actual = stagingIdentity(file)
  if (!expected || expected.dev !== actual.dev || expected.ino !== actual.ino) throw new Error('Interrupted staging file identity changed; retained for inspection')
}
function writeReceipt(r: Receipt, target: string, initial: boolean, guard: Guard): void {
  const serialized = JSON.stringify(r)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECEIPT_BYTES) throw new Error('Migration receipt is too large')
  const pending = path.join(target, NEXT), final = path.join(target, RECEIPT)
  const fd = fs.openSync(pending, 'wx', 0o600)
  let owned: ReturnType<typeof stagingIdentity> | undefined
  try {
    try {
      owned = stagingIdentity(pending)
      fs.writeFileSync(fd, serialized)
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    if (initial) guard.publish(pending, final)
    else fs.renameSync(pending, final) // Only the validated owned receipt, never a user file.
  } catch (error) {
    // An ordinary error still has in-memory ownership evidence. A process crash does not;
    // on a subsequent launch malformed pending metadata must remain preserved and blocking.
    try {
      if (owned && stat(pending)) {
        const actual = stagingIdentity(pending)
        if (actual.dev === owned.dev && actual.ino === owned.ino) fs.unlinkSync(pending)
      }
    } catch { /* Retain anything whose cleanup cannot be proved. */ }
    throw error
  }
}
function transfer(r: Receipt, target: string, guard: Guard, ownLock: boolean): void {
  if (JSON.stringify(manifest(r.source, r.kind, r.partitions, guard)) !== JSON.stringify(r.entries)) throw new Error('Legacy source no longer matches the incomplete receipt')
  const pending = path.join(target, NEXT), receipt = path.join(target, RECEIPT)
  if (stat(pending)) {
    const next = parseReceipt(pending, r.source, target, r.kind)
    if (!samePlan(r, next)) throw new Error('Pending receipt disagrees with the owned plan')
    for (const [index, identity] of Object.entries(r.stages)) {
      if (JSON.stringify(next.stages[index]) !== JSON.stringify(identity)) throw new Error('Pending staging ownership changed')
    }
    r = next
  }
  const allowed = new Set(r.entries.map(e => e.to.toLowerCase()))
  const stages = new Map(r.entries.map((_, i) => [stageName(r, i), i]))
  function inspectTree(dir: string, prefix: string): void {
    for (const name of names(dir)) {
      const rel = prefix ? prefix + '/' + name : name
      if (!prefix && (name === RECEIPT || name === NEXT || (ownLock && name === 'lockfile'))) continue
      if (!prefix && stages.has(name)) { verifyStage(path.join(dir, name), r, stages.get(name)!); continue }
      if (r.kind === 'partitions' && !r.partitions.some(p => rel === 'Partitions' || rel === 'Partitions/herald-' + p || rel.startsWith('Partitions/herald-' + p + '/'))) continue
      if (!allowed.has(rel.toLowerCase()) && !(r.kind === 'partitions' && rel === 'Partitions')) throw new Error('Unrecorded data exists in the incomplete destination')
      const file = path.join(dir, name)
      safeTree(file, guard)
      if (fs.lstatSync(file).isDirectory()) inspectTree(file, rel)
    }
  }
  inspectTree(target, '')
  // Verify all existing finals before publishing any missing file.
  for (const e of r.entries) {
    const final = path.join(target, e.to)
    safeTree(final, guard)
    if (r.state === 'complete' && !stat(final)) throw new Error('Pending completion is missing a verified final entry')
    if (stat(final) && (e.kind === 'directory' ? !fs.lstatSync(final).isDirectory() : !sameBytes(final, e))) throw new Error('Destination changed during incomplete migration')
  }
  // Promotion follows validation; neither a tampered plan nor unknown partial data authorizes writes.
  if (stat(pending)) {
    if (stat(receipt)) fs.renameSync(pending, receipt)
    else guard.publish(pending, receipt)
  }
  const created: Array<{ file: string; index: number }> = []
  try {
    // Allocate every missing stage, then persist their identities in one batch. Receipt I/O is
    // linear in the manifest size, rather than rewriting the entire manifest for every file.
    for (const [i, e] of r.entries.entries()) {
      if (e.kind !== 'file' || stat(path.join(target, e.to))) continue
      const staged = path.join(target, stageName(r, i))
      if (stat(staged)) { verifyStage(staged, r, i); continue }
      if (r.stages[String(i)]) throw new Error('Owned staging file disappeared before publication')
      const fd = fs.openSync(staged, 'wx', 0o600)
      try { r.stages[String(i)] = stagingIdentity(staged); created.push({ file: staged, index: i }) } finally { fs.closeSync(fd) }
    }
    if (created.length) writeReceipt(r, target, false, guard)
  } catch (error) {
    if (!stat(pending)) for (const item of created) {
      try {
        verifyStage(item.file, r, item.index)
        if (fs.statSync(item.file).size === 0) fs.unlinkSync(item.file)
      } catch { /* Unknown/replaced/nonempty artifacts are retained, never blindly removed. */ }
    }
    throw error
  }
  for (const [i, e] of r.entries.entries()) {
    const final = path.join(target, e.to)
    if (e.kind === 'directory') { fs.mkdirSync(final, { recursive: true }); guard.holdDirectories(final); continue }
    fs.mkdirSync(path.dirname(final), { recursive: true }); guard.holdDirectories(path.dirname(final))
    const staged = path.join(target, stageName(r, i))
    if (stat(staged)) verifyStage(staged, r, i)
    if (stat(final)) { if (stat(staged)) fs.unlinkSync(staged); continue }
    if (!stat(staged)) throw new Error('Owned staging file disappeared before publication')
    const release = guard.holdFile(staged)
    try {
      verifyStage(staged, r, i)
      fs.copyFileSync(path.join(r.source, e.from), staged)
      if (!sameBytes(staged, e)) throw new Error('Staged copy failed verification')
      const fd = fs.openSync(staged, 'r+')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    } finally { release() }
    guard.publish(staged, final)
  }
  if (JSON.stringify(manifest(r.source, r.kind, r.partitions, guard)) !== JSON.stringify(r.entries)) throw new Error('Legacy source changed during migration')
  inspectTree(target, '')
  for (const e of r.entries) if (e.kind === 'file' && !sameBytes(path.join(target, e.to), e)) throw new Error('Final copy failed verification')
  writeReceipt({ ...r, state: 'complete' }, target, false, guard)
}

/** Called synchronously after Electron ownership, before opening Chromium or starting services. */
export function migrateLegacyData(locations: LegacyLocations): MigrationResult {
  const messages: string[] = []
  let guard: Guard | undefined
  try {
    if (locations.isDev) return { status: 'skipped', messages: ['Legacy migration skipped in development.'] }
    const userData = path.resolve(locations.userData)
    const expected = path.resolve(locations.appData, 'Herald OS')
    const sameProfile = process.platform === 'win32' ? userData.toLowerCase() === expected.toLowerCase() : userData === expected
    if (!sameProfile) return { status: 'skipped', messages: ['Legacy migration skipped for a noncanonical profile override.'] }
    const legacy = path.join(locations.appData, 'Hermes OS')
    const shellSource = path.join(locations.hermesHome, 'hermes-os'), shellTarget = path.join(locations.hermesHome, 'herald-os')
    if (stat(path.join(shellTarget, RECEIPT)) || stat(path.join(shellTarget, NEXT)) || (stat(shellSource) && names(shellTarget).length === 0)) {
      const roots = [shellSource, shellTarget, legacy, userData].map(canonical)
      for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
        if (contained(roots[i]!, roots[j]!) || contained(roots[j]!, roots[i]!)) throw new Error('Migration plans overlap; no data was copied')
      }
    }
    let changed = false, locked = false
    function getGuard(): Guard { return guard ??= windowsGuard() }
    function ownership(): Guard {
      canonical(locations.appData); canonical(locations.userData)
      const g = getGuard()
      if (!locked) {
        g.holdDirectories(userData)
        if (!g.ownArtifact(userData)) throw new Error('Destination ownership artifact is not qualified')
        g.lock(legacy); locked = true
      }
      return g
    }
    for (const target of [shellTarget, userData]) {
      const isProfile = target === userData, originalSource = isProfile ? legacy : shellSource
      const receiptPath = path.join(target, RECEIPT), nextPath = path.join(target, NEXT)
      let r: Receipt | undefined
      if (stat(receiptPath) || stat(nextPath)) {
        const probePath = stat(receiptPath) ? receiptPath : nextPath
        regular(probePath)
        if (fs.statSync(probePath).size > MAX_RECEIPT_BYTES) throw new Error('Migration receipt is too large')
        const probe = JSON.parse(fs.readFileSync(probePath, 'utf8')) as Receipt
        const source = isProfile && probe?.kind === 'partitions' ? userData : originalSource
        r = parseReceipt(probePath, source, target, isProfile ? undefined : 'shell')
        if (isProfile && r.kind === 'shell') throw new Error('Profile receipt has an invalid kind')
        if (r.state === 'complete') {
          if (!stat(receiptPath)) throw new Error('Completed receipt has no committed adoption')
          if (stat(nextPath)) throw new Error('Unexpected pending receipt after completed adoption')
          messages.push('Completed adoption retained; ordinary destination data wins.')
          continue
        }
      }
      let kind: Kind = isProfile ? 'profile' : 'shell', source = originalSource
      let partitions: string[] = []
      const populated = names(target).filter(n => n !== RECEIPT && n !== NEXT)
      if (!r) {
        if (!stat(source) && (!isProfile || !stat(path.join(userData, 'Partitions')))) continue
        if (!isProfile && populated.length) { messages.push('Existing shell destination retained.'); continue }
        if (isProfile && (!locations.userDataWasEmpty || populated.some(n => n !== 'lockfile'))) {
          source = userData; kind = 'partitions'
          partitions = PARTITIONS.filter(p => stat(path.join(userData, 'Partitions', 'hermes-' + p)) && !stat(path.join(userData, 'Partitions', 'herald-' + p)))
          if (!partitions.length) { messages.push('Existing profile retained.'); continue }
        }
        if (!stat(source)) continue
      } else { source = r.source; kind = r.kind; partitions = r.partitions }
      if (isProfile) { canonical(locations.appData); canonical(locations.userData) }
      else canonical(locations.hermesHome)
      const from = canonical(source), to = canonical(target)
      if (kind !== 'partitions' && (contained(from, to) || contained(to, from))) throw new Error('Migration source and destination overlap')
      const g = kind === 'partitions' ? getGuard() : ownership()
      safeTree(source, g); safeTree(target, g)
      const ownLock = isProfile && g.ownArtifact(target)
      if (isProfile && !ownLock) throw new Error('Destination ownership artifact is not qualified')
      if (!r) {
        r = { version: 1, id: crypto.randomUUID(), state: 'incomplete', kind, source: from, target: to, partitions, entries: manifest(source, kind, partitions, g), stages: {} }
        fs.mkdirSync(target, { recursive: true }); g.holdDirectories(target)
        writeReceipt(r, target, true, g)
      }
      transfer(r, target, g, ownLock)
      changed = true
      messages.push(`Preserved source; completed ${kind} migration.`)
    }
    return { status: changed ? 'completed' : messages.length ? 'skipped' : 'no-source', messages }
  } catch (error) {
    return { status: 'blocked', messages, error: `Legacy migration stopped; source retained. ${error instanceof Error ? error.message : String(error)}. Close legacy applications and correct the reported access/path error before retrying. If receipt or staging identity is ambiguous, retain both folders and obtain a recovery review; do not delete migration metadata.` }
  } finally { guard?.close() }
}
