import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { holdProtectedWindowsFile } from './connection-identity.ts'

/** SC1 reads the inspected native file handle, while every ancestor is held against replacement. */
export function readProtectedAttachFile(file: string): string {
  const held = holdProtectedWindowsFile(file)
  try { return held.bytes.toString('utf8') } finally { held.bytes.fill(0); held.close() }
}

export interface ControlPublication {
  file: string
  socket: string
  token: string
  pid: number
  instance: string
}

export interface ControlFileOptions {
  /** Only the endpoint returned by this desktop's successfully awaited Unix OsControlServer.start().
   * Never infer this acknowledgement from a configured path; panels and Windows do not supply it. */
  boundUnixSocket?: string
  warn?: (message: string) => void
}

/** A verified cleanup left an owned record at this pathname; retain it for the next attempt. */
export class ControlCleanupError extends Error {
  declare readonly publication: ControlPublication

  constructor(message: string, publication: ControlPublication) {
    super(message)
    this.name = 'ControlCleanupError'
    // The ownership record contains a token; do not expose it through ordinary error enumeration.
    Object.defineProperty(this, 'publication', { value: publication })
  }
}

/** Only emitted after this publication reached linkSync and its rollback failed. */
export class ControlPublicationError extends ControlCleanupError {
  override name = 'ControlPublicationError'
}

const MAX_FILE_BYTES = 4096
const SHARING_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES'])

// Windows PowerShell 5.1/.NET Framework can supply FileSecurity to CreateNew. The token is raw
// UTF-8 on stdin, never an argument, command fragment, environment variable or diagnostic.
// Do not replace this with chmod (not a Windows DACL) or a write-then-tighten sequence.
const CREATE_PRIVATE_FILE = String.raw`
$ErrorActionPreference = 'Stop'
$stream = $null
$created = $false
$complete = $false
try {
  $file = $env:HERALD_CONTROL_TEMP_PATH
  $directory = [System.IO.Path]::GetDirectoryName($file)
  $root = [System.IO.Path]::GetPathRoot($directory)
  if ($root -notmatch '^[A-Za-z]:\\$') { throw 'Local NTFS is required' }
  $drive = [System.IO.DriveInfo]::new($root)
  if ($drive.DriveFormat -ne 'NTFS' -or $drive.DriveType -ne [System.IO.DriveType]::Fixed) { throw 'Fixed local NTFS is required' }
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  # TrustedInstaller may own a protected ancestor on a standard Windows system volume.
  $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $item = [System.IO.DirectoryInfo]::new($directory)
  $leaf = $true
  while ($null -ne $item) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse directories are not supported' }
    $acl = $item.GetAccessControl()
    if ($trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'A directory is owned by another account' }
    $rights = [System.Security.AccessControl.FileSystemRights]::Delete -bor
      [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
      [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
      [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    if ($leaf) { $rights = $rights -bor [System.Security.AccessControl.FileSystemRights]::Write }
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
      if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
      if ($trusted -contains $rule.IdentityReference.Value) { continue }
      if (($rule.FileSystemRights -band $rights) -ne 0) { throw 'The control directory can be modified by another account' }
    }
    $leaf = $false
    $item = $item.Parent
  }
  $security = [System.Security.AccessControl.FileSecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  foreach ($identity in @($sid, $system)) {
    $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      $identity, [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow))
  }
  $stream = [System.IO.FileStream]::new($file, [System.IO.FileMode]::CreateNew,
    [System.Security.AccessControl.FileSystemRights]::Write, [System.IO.FileShare]::None,
    4096, [System.IO.FileOptions]::WriteThrough, $security)
  $created = $true
  [Console]::OpenStandardInput().CopyTo($stream)
  $stream.Flush($true)
  $complete = $true
} catch {
  [Console]::Error.WriteLine('Could not create a private Herald OS control file on local NTFS.')
  exit 1
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
  if ($created -and -not $complete) { [System.IO.File]::Delete($file) }
}
`

async function createPrivateFile(file: string, bytes: Buffer): Promise<void> {
  if (process.platform !== 'win32') {
    const descriptor = fs.openSync(file, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, bytes)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    return
  }
  const windowsRoot = process.env.SystemRoot
  if (!windowsRoot || !/^[A-Za-z]:[\\/]/.test(windowsRoot)) {
    throw new Error('Cannot locate Windows PowerShell 5.1 for private control-file creation')
  }
  const powershell = path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', CREATE_PRIVATE_FILE], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, HERALD_CONTROL_TEMP_PATH: file },
      timeout: 10_000
    })
    let failed = false
    child.once('error', () => { failed = true })
    child.stdin.on('error', () => { failed = true; child.kill() })
    child.once('close', code => {
      if (failed || code !== 0) {
        reject(new Error('Could not create a private control file. Local NTFS and Windows PowerShell 5.1 are required. Check directory permissions: untrusted accounts must not be able to write to the control directory, delete or replace it or its ancestors, or change their permissions or ownership. Use a private HERMES_HOME in your user profile; also check Windows application-control policy.'))
      } else resolve()
    })
    child.stdin.end(bytes)
  })
}

async function retrySharing(action: () => void): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      action()
      return
    } catch (error) {
      if (attempt >= 4 || !SHARING_ERRORS.has((error as NodeJS.ErrnoException).code ?? '')) throw error
      await delay(100)
    }
  }
}

function readPublication(file: string): ControlPublication | null {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return null
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object') return null
    const data = value as Record<string, unknown>
    if (typeof data.socket !== 'string' || typeof data.token !== 'string' ||
      !Number.isSafeInteger(data.pid) || Number(data.pid) <= 0 ||
      typeof data.instance !== 'string' || !/^[0-9a-f-]{36}$/.test(data.instance)) return null
    return { file, socket: data.socket, token: data.token, pid: Number(data.pid), instance: data.instance }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

function samePublication(actual: ControlPublication | null, expected: ControlPublication): boolean {
  if (!actual || actual.pid !== expected.pid || actual.instance !== expected.instance || actual.socket !== expected.socket) return false
  const actualToken = Buffer.from(actual.token, 'utf8')
  const expectedToken = Buffer.from(expected.token, 'utf8')
  return actualToken.length === expectedToken.length && crypto.timingSafeEqual(actualToken, expectedToken)
}

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function knownDead(pid: number): boolean {
  try { process.kill(pid, 0); return false }
  catch (error) {
    // An existing/reused PID or access denied is deliberately ambiguous, never permission to delete.
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
}

interface LegacyControlFile {
  identity: fs.BigIntStats
  bytes: Buffer
  socket: string
}

/** Bounded, no-follow reader for the exact pre-pid/instance Unix record; never a publication. */
function readLegacy(file: string): LegacyControlFile | null {
  let descriptor: number | undefined
  try {
    const identity = fs.lstatSync(file, { bigint: true })
    if (!identity.isFile() || identity.isSymbolicLink() || identity.size > BigInt(MAX_FILE_BYTES)) return null
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    if (!sameFile(identity, fs.fstatSync(descriptor, { bigint: true }))) return null
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0)
    if (length > MAX_FILE_BYTES || fs.fstatSync(descriptor, { bigint: true }).size !== BigInt(length)) return null
    const bytes = buffer.subarray(0, length)
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!value || typeof value !== 'object') return null
    const data = value as Record<string, unknown>
    const keys = Object.keys(data).sort()
    if (keys.length !== 2 || keys[0] !== 'socket' || keys[1] !== 'token' ||
      typeof data.socket !== 'string' || typeof data.token !== 'string') return null
    return { identity, bytes, socket: data.socket }
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '') || error instanceof SyntaxError) return null
    throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

// Like current-record cleanup, this is not atomic pathname compare-and-delete. A raced replacement
// is restored without overwriting a winner; the public name can be briefly absent during the check.
async function removeLegacyControlFile(file: string, legacy: LegacyControlFile): Promise<void> {
  const tombstone = cleanupPath(file)
  try {
    await retrySharing(() => fs.renameSync(file, tombstone))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let moved: LegacyControlFile | null = null
  try { moved = readLegacy(tombstone) } catch { /* Restore an unreadable replacement too. */ }
  if (moved && sameFile(legacy.identity, moved.identity) && legacy.bytes.length === moved.bytes.length &&
    crypto.timingSafeEqual(legacy.bytes, moved.bytes)) {
    await retrySharing(() => fs.unlinkSync(tombstone))
    return
  }
  await restoreForeignControlFile(file, tombstone)
}

async function sweepDeadTemporaryFiles(directory: string, warn: (message: string) => void): Promise<void> {
  // Failure to enumerate the directory remains fatal; only individual retained entries are recoverable.
  for (const name of fs.readdirSync(directory)) {
    const match = /^control\.json\.([1-9][0-9]*)\.([0-9a-f-]{36})\.tmp$/.exec(name)
    if (!match || !knownDead(Number(match[1]))) continue
    const file = path.join(directory, name)
    try {
      const publication = readPublication(file)
      if (publication?.pid === Number(match[1]) && publication.instance === match[2]) {
        await removeControlFile(publication)
      } else {
        warn(`An unknown temporary control file was retained at ${file}; inspect it separately.`)
      }
    } catch (error) {
      warn(`Temporary control-file cleanup failed at ${file}; its unverified files were retained: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Publish a fully flushed, private inode by create-if-absent hard link; never replace a winner. */
export async function publishControlFile(directory: string, endpoint: { socket: string; token: string }, options: ControlFileOptions = {}): Promise<ControlPublication> {
  const publication: ControlPublication = {
    file: path.join(directory, 'control.json'), ...endpoint, pid: process.pid, instance: crypto.randomUUID()
  }
  const bytes = Buffer.from(JSON.stringify({ socket: publication.socket, token: publication.token, pid: publication.pid, instance: publication.instance }), 'utf8')
  if (bytes.length > MAX_FILE_BYTES) throw new Error('The control endpoint record is too large')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${publication.file}.${publication.pid}.${publication.instance}.tmp`
  let identity: fs.BigIntStats | null = null
  let linked = false
  try {
    await createPrivateFile(temporary, bytes)
    identity = fs.lstatSync(temporary, { bigint: true })
    if (!identity.isFile() || identity.isSymbolicLink()) throw new Error('The private control file is not a regular file')
    await sweepDeadTemporaryFiles(directory, options.warn ?? (message => console.warn(message)))
    const previous = readPublication(publication.file)
    if (previous) {
      if (!knownDead(previous.pid)) throw new Error('Another live or unverifiable process owns the control endpoint')
      await removeControlFile(previous)
    } else if (exists(publication.file)) {
      // Equality is useful only with the caller's successful Unix bind acknowledgement. The bind
      // excludes an older listener at this deterministic desktop path; a path alone proves nothing.
      const legacy = process.platform !== 'win32' && path.isAbsolute(endpoint.socket) &&
        options.boundUnixSocket === endpoint.socket ? readLegacy(publication.file) : null
      if (!legacy || legacy.socket !== endpoint.socket) {
        throw new Error('An unknown control file already exists; it was not replaced')
      }
      await removeLegacyControlFile(publication.file, legacy)
    }
    // Same directory/volume. EEXIST is never retried or replaced: a concurrent publisher won.
    await retrySharing(() => fs.linkSync(temporary, publication.file))
    linked = true
    if (!sameFile(identity, fs.lstatSync(temporary, { bigint: true })) ||
      !sameFile(identity, fs.lstatSync(publication.file, { bigint: true }))) {
      throw new Error('The control file changed during publication')
    }
    await retrySharing(() => fs.unlinkSync(temporary))
    identity = null
    return publication
  } catch (error) {
    let cleanupError: unknown
    let remainingPublication: ControlPublication | null = null
    if (linked) {
      try { await removeControlFile(publication) } catch (failure) {
        cleanupError = failure
        remainingPublication = failure instanceof ControlCleanupError ? failure.publication : publication
      }
    }
    if (identity) {
      try {
        if (exists(temporary)) {
          if (!sameFile(identity, fs.lstatSync(temporary, { bigint: true })) || !samePublication(readPublication(temporary), publication)) {
            throw new Error(`An unverified temporary control file was retained at ${temporary}`)
          }
          await retrySharing(() => fs.unlinkSync(temporary))
        }
      } catch (failure) { cleanupError = failure }
    }
    const message = error instanceof Error ? error.message : String(error)
    if (cleanupError) {
      const detail = `${message}; control-file cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
      if (remainingPublication) throw new ControlPublicationError(detail, remainingPublication)
      throw new Error(detail)
    }
    throw error
  }
}

/**
 * Recheck after moving to a unique tombstone: a raced replacement must not be deleted. Restoring
 * a foreign file uses a hard link only if the public name is free. This is not an atomic compare-
 * and-delete; a racing publisher can cause a brief absence, and failed restore retains the file.
 */
export async function removeControlFile(publication: ControlPublication): Promise<void> {
  const current = readPublication(publication.file)
  if (!current && exists(publication.file)) throw new Error('An unknown control file was retained during cleanup')
  if (!samePublication(current, publication)) return
  const tombstone = cleanupPath(publication.file)
  try {
    await retrySharing(() => fs.renameSync(publication.file, tombstone))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let owned = false
  try { owned = samePublication(readPublication(tombstone), publication) } catch { /* Restore any unverified replacement. */ }
  if (owned) {
    try {
      await retrySharing(() => fs.unlinkSync(tombstone))
    } catch (error) {
      throw new ControlCleanupError(`Owned control-file cleanup failed at ${tombstone}: ${error instanceof Error ? error.message : String(error)}`, { ...publication, file: tombstone })
    }
    return
  }
  await restoreForeignControlFile(publication.file, tombstone)
}

function cleanupPath(file: string): string {
  // Retrying a retained tombstone must not append another PID/UUID to its previous name.
  return path.join(path.dirname(file), `control.json.${process.pid}.${crypto.randomUUID()}.cleanup`)
}

/** Shared by current and legacy cleanup; never overwrite a publisher that wins during restore. */
async function restoreForeignControlFile(file: string, tombstone: string): Promise<never> {
  try {
    await retrySharing(() => fs.linkSync(tombstone, file))
  } catch {
    throw new Error(`Control-file cleanup encountered another publisher. Its file was retained at ${tombstone}; the current endpoint was not overwritten.`)
  }
  // Keep the foreign tombstone as well: never delete a pathname belonging to another publisher.
  throw new Error(`Control-file cleanup encountered another publisher. Its endpoint was restored and its file retained at ${tombstone}.`)
}
