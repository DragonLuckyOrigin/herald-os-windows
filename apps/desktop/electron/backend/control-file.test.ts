import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ControlPublication, ControlCleanupError, ControlPublicationError, publishControlFile, removeControlFile } from './control-file.ts'

const directories: string[] = []
const endpoint = { socket: 'tcp://127.0.0.1:12345', token: 'test-only-token' }

// Each real PowerShell invocation has a 10 s deadline. Add the usual 5 s test budget for
// filesystem assertions and bounded sharing retries; leave Vitest's Unix defaults unchanged.
function nativeFileOptions(helperCalls = 1): { timeout?: number } {
  return process.platform === 'win32' ? { timeout: helperCalls * 10_000 + 5_000 } : {}
}

function directory(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'hos-control-'))
  directories.push(result)
  return result
}

function read(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}

function record(publication: ControlPublication): string {
  const { file: _file, ...data } = publication
  return JSON.stringify(data)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const folder of directories.splice(0)) fs.rmSync(folder, { recursive: true, force: true })
})

describe('private control-file publication', () => {
  it('publishes complete endpoint metadata and removes its temporary name', nativeFileOptions(), async () => {
    const folder = directory()
    const publication = await publishControlFile(folder, endpoint)
    expect(read(publication.file)).toEqual({ ...endpoint, pid: process.pid, instance: publication.instance })
    expect(fs.readdirSync(folder)).toEqual(['control.json'])
    if (process.platform !== 'win32') expect(fs.statSync(publication.file).mode & 0o777).toBe(0o600)
    await removeControlFile(publication)
    expect(fs.readdirSync(folder)).toEqual([])
  })

  it('does not replace a live publication or an unknown file', nativeFileOptions(3), async () => {
    const folder = directory()
    const original = await publishControlFile(folder, endpoint)
    await expect(publishControlFile(folder, { ...endpoint, token: 'other' })).rejects.toThrow('live or unverifiable')
    expect(read(original.file).token).toBe(endpoint.token)
    expect(fs.readdirSync(folder)).toEqual(['control.json'])
    await removeControlFile(original)
    fs.writeFileSync(original.file, 'unknown', { mode: 0o600 })
    await expect(publishControlFile(folder, endpoint)).rejects.toThrow('unknown control file')
    expect(fs.readFileSync(original.file, 'utf8')).toBe('unknown')
  })

  it('fails rather than replacing a publisher that wins after the existence check', nativeFileOptions(), async () => {
    const folder = directory()
    const realLink = fs.linkSync
    vi.spyOn(fs, 'linkSync').mockImplementationOnce((source, target) => {
      fs.writeFileSync(target, 'concurrent winner', { flag: 'wx', mode: 0o600 })
      realLink(source, target)
    })
    await expect(publishControlFile(folder, endpoint)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(fs.readFileSync(path.join(folder, 'control.json'), 'utf8')).toBe('concurrent winner')
    expect(fs.readdirSync(folder)).toEqual(['control.json'])
  })

  it('retries sharing failures only a bounded number of times', nativeFileOptions(2), async () => {
    const realLink = fs.linkSync
    let calls = 0
    vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      if (++calls < 3) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' })
      realLink(source, target)
    })
    const publication = await publishControlFile(directory(), endpoint)
    expect(calls).toBe(3)
    await removeControlFile(publication)
    calls = 0
    vi.mocked(fs.linkSync).mockImplementation(() => {
      calls++
      throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' })
    })
    const blocked = directory()
    await expect(publishControlFile(blocked, endpoint)).rejects.toMatchObject({ code: 'EBUSY' })
    expect(calls).toBe(5)
    expect(fs.readdirSync(blocked)).toEqual([])
  })

  it('reports a failed temporary-name removal and withdraws its publication', nativeFileOptions(), async () => {
    const realUnlink = fs.unlinkSync
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (String(file).endsWith('.tmp')) throw Object.assign(new Error('temporary file still open'), { code: 'EBUSY' })
      realUnlink(file)
    })
    const folder = directory()
    await expect(publishControlFile(folder, endpoint)).rejects.toThrow('cleanup also failed')
    expect(fs.existsSync(path.join(folder, 'control.json'))).toBe(false)
    expect(fs.readdirSync(folder)).toHaveLength(1)
    expect(fs.readdirSync(folder)[0]).toMatch(/\.tmp$/)
  })

  it('returns the known publication when rollback fails after linking, so its owner can retry', nativeFileOptions(), async () => {
    const folder = directory()
    const realUnlink = fs.unlinkSync
    const realRename = fs.renameSync
    let blocked = true
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (blocked && String(file).endsWith('.tmp')) throw Object.assign(new Error('temporary file open'), { code: 'EBUSY' })
      realUnlink(file)
    })
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (blocked && String(source) === path.join(folder, 'control.json')) throw Object.assign(new Error('publication open'), { code: 'EBUSY' })
      realRename(source, target)
    })

    let failure: unknown
    try { await publishControlFile(folder, endpoint) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(ControlPublicationError)
    const retained = (failure as ControlPublicationError).publication
    expect(read(retained.file)).toEqual({ ...endpoint, pid: process.pid, instance: retained.instance })
    expect(Object.keys(failure as Error)).not.toContain('publication')
    expect(String(failure)).not.toContain(endpoint.token)

    blocked = false
    await removeControlFile(retained)
    expect(fs.existsSync(retained.file)).toBe(false)
  })

  it('keeps the verified rollback tombstone even when subsequent temporary cleanup also fails', nativeFileOptions(), async () => {
    const folder = directory()
    const realUnlink = fs.unlinkSync
    let blocked = true
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (blocked && /\.(tmp|cleanup)$/.test(String(file))) throw Object.assign(new Error('file still open'), { code: 'EBUSY' })
      realUnlink(file)
    })
    let failure: unknown
    try { await publishControlFile(folder, endpoint) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(ControlPublicationError)
    const retained = (failure as ControlPublicationError).publication
    expect(retained.file).toMatch(/\.cleanup$/)
    expect(fs.existsSync(path.join(folder, 'control.json'))).toBe(false)
    expect(read(retained.file)).toEqual({ ...endpoint, pid: process.pid, instance: retained.instance })

    blocked = false
    await removeControlFile(retained)
    expect(fs.existsSync(retained.file)).toBe(false)
    // The separately retained temporary link remains outside this publication retry contract.
    expect(fs.readdirSync(folder)).toHaveLength(1)
    expect(fs.readdirSync(folder).every(name => name.endsWith('.tmp'))).toBe(true)
  })

  it('accepts only a demonstrably absent PID for stale cleanup', nativeFileOptions(2), async () => {
    const folder = directory()
    const old: ControlPublication = { file: path.join(folder, 'control.json'), ...endpoint, pid: 2147483000, instance: crypto.randomUUID() }
    fs.writeFileSync(old.file, record(old), { mode: 0o600 })
    const realKill = process.kill
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === old.pid) throw Object.assign(new Error('unknown owner'), { code: 'EPERM' })
      return realKill(pid, signal)
    })
    await expect(publishControlFile(folder, endpoint)).rejects.toThrow('live or unverifiable')
    expect(read(old.file).instance).toBe(old.instance)
    vi.mocked(process.kill).mockImplementation((pid, signal) => {
      if (pid === old.pid) throw Object.assign(new Error('not found'), { code: 'ESRCH' })
      return realKill(pid, signal)
    })
    const current = await publishControlFile(folder, endpoint)
    expect(read(current.file).instance).toBe(current.instance)
    await removeControlFile(current)
  })

  it('sweeps identifiable dead temporary records but warns and continues past ambiguous fragments', nativeFileOptions(2), async () => {
    const folder = directory()
    const old: ControlPublication = { file: '', ...endpoint, pid: 2147483000, instance: crypto.randomUUID() }
    old.file = path.join(folder, `control.json.${old.pid}.${old.instance}.tmp`)
    fs.writeFileSync(old.file, record(old), { mode: 0o600 })
    const realKill = process.kill
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === old.pid) throw Object.assign(new Error('not found'), { code: 'ESRCH' })
      return realKill(pid, signal)
    })
    const current = await publishControlFile(folder, endpoint)
    expect(fs.existsSync(old.file)).toBe(false)
    await removeControlFile(current)
    fs.writeFileSync(old.file, 'partial', { mode: 0o600 })
    const warn = vi.fn()
    const next = await publishControlFile(folder, endpoint, { warn })
    expect(fs.readFileSync(old.file, 'utf8')).toBe('partial')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(old.file))
    await removeControlFile(next)
  })

  it('warns on a per-entry access error without hiding it or blocking a new endpoint', nativeFileOptions(), async () => {
    const folder = directory()
    const old: ControlPublication = { file: '', ...endpoint, pid: 2147483000, instance: crypto.randomUUID() }
    old.file = path.join(folder, `control.json.${old.pid}.${old.instance}.tmp`)
    fs.writeFileSync(old.file, record(old), { mode: 0o600 })
    const realKill = process.kill
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === old.pid) throw Object.assign(new Error('not found'), { code: 'ESRCH' })
      return realKill(pid, signal)
    })
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(file => {
      expect(String(file)).toBe(old.file)
      throw Object.assign(new Error('access denied'), { code: 'EACCES' })
    })
    const warn = vi.fn()
    const current = await publishControlFile(folder, endpoint, { warn })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(old.file))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('access denied'))
    expect(fs.existsSync(old.file)).toBe(true)
    await removeControlFile(current)
  })

  it('still blocks if the temporary-file directory itself cannot be enumerated', nativeFileOptions(), async () => {
    const folder = directory()
    const denied = vi.spyOn(fs, 'readdirSync').mockImplementationOnce(directoryToRead => {
      expect(String(directoryToRead)).toBe(folder)
      throw Object.assign(new Error('directory denied'), { code: 'EACCES' })
    })
    const warn = vi.fn()
    await expect(publishControlFile(folder, endpoint, { warn })).rejects.toMatchObject({ code: 'EACCES' })
    expect(warn).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(folder, 'control.json'))).toBe(false)
    denied.mockRestore()
    expect(fs.readdirSync(folder)).toEqual([])
  })

  it('retains and reports a dead temporary record whose verified cleanup fails', nativeFileOptions(), async () => {
    const folder = directory()
    const old: ControlPublication = { file: '', ...endpoint, pid: 2147483000, instance: crypto.randomUUID() }
    old.file = path.join(folder, `control.json.${old.pid}.${old.instance}.tmp`)
    fs.writeFileSync(old.file, record(old), { mode: 0o600 })
    const realKill = process.kill
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === old.pid) throw Object.assign(new Error('not found'), { code: 'ESRCH' })
      return realKill(pid, signal)
    })
    const realRename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (String(source) === old.file) throw Object.assign(new Error('temporary cleanup blocked'), { code: 'EBUSY' })
      realRename(source, target)
    })
    const warn = vi.fn()
    const current = await publishControlFile(folder, endpoint, { warn })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('temporary cleanup blocked'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(old.file))
    expect(read(old.file).instance).toBe(old.instance)
    await removeControlFile(current)
  })

  it('does not migrate a legacy TCP record even with a matching claimed bind', nativeFileOptions(), async () => {
    const folder = directory()
    const file = path.join(folder, 'control.json')
    const legacy = JSON.stringify(endpoint)
    fs.writeFileSync(file, legacy, { mode: 0o600 })
    // A matching string alone is never a Unix bind acknowledgement, nor a Windows migration path.
    await expect(publishControlFile(folder, endpoint, { boundUnixSocket: endpoint.socket })).rejects.toThrow('unknown control file')
    expect(fs.readFileSync(file, 'utf8')).toBe(legacy)
  })
})

describe('cleanup ownership and replacement races', () => {
  it('retries a verified tombstone after unlink fails without growing its pathname', nativeFileOptions(), async () => {
    const publication = await publishControlFile(directory(), endpoint)
    const realUnlink = fs.unlinkSync
    let blocked = true
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (blocked && String(file).endsWith('.cleanup')) throw Object.assign(new Error('cleanup file open'), { code: 'EBUSY' })
      realUnlink(file)
    })
    let retained = publication
    let cleanupNameLength = 0
    for (let attempt = 0; attempt < 3; attempt++) {
      const previousFile = retained.file
      let failure: unknown
      try { await removeControlFile(retained) } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(ControlCleanupError)
      retained = (failure as ControlCleanupError).publication
      expect(retained.pid).toBe(publication.pid)
      expect(retained.instance).toBe(publication.instance)
      expect(fs.existsSync(previousFile)).toBe(false)
      expect(read(retained.file).token).toBe(endpoint.token)
      expect(path.dirname(retained.file)).toBe(path.dirname(publication.file))
      if (attempt === 0) cleanupNameLength = path.basename(retained.file).length
      expect(path.basename(retained.file).length).toBe(cleanupNameLength)
    }
    blocked = false
    await removeControlFile(retained)
    expect(fs.readdirSync(path.dirname(publication.file))).toEqual([])
  })

  it('does not remove a publication owned by another instance', nativeFileOptions(), async () => {
    const publication = await publishControlFile(directory(), endpoint)
    await removeControlFile({ ...publication, instance: crypto.randomUUID() })
    expect(read(publication.file).instance).toBe(publication.instance)
    await removeControlFile(publication)
  })

  it('restores a replacement that appears between checking and renaming', nativeFileOptions(), async () => {
    const publication = await publishControlFile(directory(), endpoint)
    const foreign = { ...publication, token: 'foreign-test-token', instance: crypto.randomUUID() }
    const realRename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((source, target) => {
      const replacement = `${publication.file}.replacement`
      fs.writeFileSync(replacement, record(foreign), { mode: 0o600 })
      realRename(replacement, publication.file)
      realRename(source, target)
    })
    let failure: unknown
    try { await removeControlFile(publication) } catch (error) { failure = error }
    expect(String(failure)).toContain('endpoint was restored')
    expect(failure).not.toBeInstanceOf(ControlCleanupError)
    expect(read(publication.file).instance).toBe(foreign.instance)
    const tombstone = fs.readdirSync(path.dirname(publication.file)).find(name => name.endsWith('.cleanup'))!
    expect(read(path.join(path.dirname(publication.file), tombstone)).instance).toBe(foreign.instance)
  })

  it('retains the displaced file when another publisher wins during restore', nativeFileOptions(), async () => {
    const publication = await publishControlFile(directory(), endpoint)
    const displaced = { ...publication, token: 'displaced-test-token', instance: crypto.randomUUID() }
    const newest = { ...publication, token: 'newest-test-token', instance: crypto.randomUUID() }
    const realRename = fs.renameSync
    const realLink = fs.linkSync
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((source, target) => {
      const replacement = `${publication.file}.replacement`
      fs.writeFileSync(replacement, record(displaced), { mode: 0o600 })
      realRename(replacement, publication.file)
      realRename(source, target)
    })
    vi.spyOn(fs, 'linkSync').mockImplementationOnce((source, target) => {
      fs.writeFileSync(publication.file, record(newest), { flag: 'wx', mode: 0o600 })
      realLink(source, target)
    })
    await expect(removeControlFile(publication)).rejects.toThrow('current endpoint was not overwritten')
    expect(read(publication.file).instance).toBe(newest.instance)
    const tombstone = fs.readdirSync(path.dirname(publication.file)).find(name => name.endsWith('.cleanup'))!
    expect(read(path.join(path.dirname(publication.file), tombstone)).instance).toBe(displaced.instance)
  })
})

describe.skipIf(process.platform !== 'win32')('native Windows private-file creation', () => {
  it('does not migrate legacy path records on Windows', nativeFileOptions(), async () => {
    const folder = directory()
    const socket = path.join(folder, 'control.sock')
    const legacy = JSON.stringify({ socket, token: 'old-token' })
    const file = path.join(folder, 'control.json')
    fs.writeFileSync(file, legacy)
    await expect(publishControlFile(folder, { socket, token: endpoint.token }, { boundUnixSocket: socket })).rejects.toThrow('unknown control file')
    expect(fs.readFileSync(file, 'utf8')).toBe(legacy)
  })

  it('has a protected owner/SYSTEM DACL after hard-link publication', nativeFileOptions(2), async () => {
    const publication = await publishControlFile(directory(), endpoint)
    const executable = path.win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const command = "$env:PSModulePath = $PSHOME + '\\Modules'; $ErrorActionPreference = 'Stop'; " + '$a = Get-Acl -LiteralPath $env:HERALD_TEST_CONTROL_PATH; @{ owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; protected=$a.AreAccessRulesProtected; rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid=$_.IdentityReference.Value; inherited=$_.IsInherited; type=$_.AccessControlType.ToString() } }) } | ConvertTo-Json -Depth 4 -Compress'
    const result = JSON.parse(execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { ...process.env, HERALD_TEST_CONTROL_PATH: publication.file }
    })) as { owner: string; user: string; protected: boolean; rules: { sid: string; inherited: boolean; type: string }[] }
    expect(result.owner).toBe(result.user)
    expect(result.protected).toBe(true)
    expect(new Set(result.rules.map(rule => rule.sid))).toEqual(new Set([result.user, 'S-1-5-18']))
    expect(result.rules.every(rule => !rule.inherited && rule.type === 'Allow')).toBe(true)
    await removeControlFile(publication)
  })

  it('fails closed when the required native helper is unavailable', nativeFileOptions(), async () => {
    const folder = directory()
    vi.stubEnv('SystemRoot', path.join(folder, 'missing-windows'))
    await expect(publishControlFile(folder, endpoint)).rejects.toThrow('Could not create a private control file')
    expect(fs.existsSync(path.join(folder, 'control.json'))).toBe(false)
  })
})
