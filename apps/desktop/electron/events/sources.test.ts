import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type HeraldEvent } from '../../shared/events.ts'

vi.mock('electron', () => ({ powerMonitor: { on: () => undefined }, ipcMain: { handle: () => undefined } }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>() }))

const { batteryCrossing, networkKey } = await import('./sources.ts')
const { hookScripts, runHooks } = await import('./hooks.ts')
const { log } = await import('../log.ts')
const temporaryDirectories: string[] = []
const nativePlatform = process.platform

function temporaryDirectory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herald hooks & ' "))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('batteryCrossing', () => {
  it('fires once when the battery drops to 15% and re-arms after charging', () => {
    let armed = true
    const step = (percent: number, charging = false) => {
      const verdict = batteryCrossing(armed, { present: true, percent, charging })
      armed = verdict.armed

      return verdict.fire
    }

    expect(step(40)).toBe(false)
    expect(step(15)).toBe(true)
    expect(step(12)).toBe(false)
    expect(step(12, true)).toBe(false)
    expect(step(14)).toBe(true)
  })

  it('stays quiet without a battery', () => {
    expect(batteryCrossing(true, { present: false })).toEqual({ fire: false, armed: true })
    expect(batteryCrossing(true, undefined)).toEqual({ fire: false, armed: true })
  })
})

describe('networkKey', () => {
  it('changes when going offline or joining another Wi-Fi network', () => {
    const home = networkKey({ online: true, wifi: { connected: true, ssid: 'Home' } })

    expect(networkKey({ online: true, wifi: { connected: true, ssid: 'Home' } })).toBe(home)
    expect(networkKey({ online: true, wifi: { connected: true, ssid: 'Cafe' } })).not.toBe(home)
    expect(networkKey({ online: false })).not.toBe(home)
  })
})

describe('hookScripts', () => {
  it('runs executable scripts in name order, skipping samples and dotfiles', () => {
    const dir = temporaryDirectory()
    const suffix = process.platform === 'win32' ? '.ps1' : ''
    const write = (name: string, mode: number) => fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n', { mode })

    write(`20-second${suffix}`, 0o755)
    write(`10-first${suffix}`, 0o755)
    write(process.platform === 'win32' ? 'not-executable.txt' : 'not-executable', 0o644)
    write('30-example.sample', 0o755)
    write('.hidden', 0o755)

    expect(hookScripts(dir).map(file => path.basename(file))).toEqual([`10-first${suffix}`, `20-second${suffix}`])
    expect(hookScripts(path.join(dir, 'missing'))).toEqual([])
  })

  it('uses only regular ps1/exe files on Windows and keeps all name exclusions', () => {
    const dir = temporaryDirectory()
    for (const name of ['20-native.EXE', '10-script.PS1', '30-script.ps1', '40-native.exe', '.hidden.ps1', 'sample.ps1.sample', 'backup.exe~', 'batch.cmd', 'batch.bat', 'shell.sh', 'extensionless']) {
      fs.writeFileSync(path.join(dir, name), '')
    }
    fs.mkdirSync(path.join(dir, '05-directory.ps1'))
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      expect(hookScripts(dir).map(file => path.basename(file))).toEqual(['10-script.PS1', '20-native.EXE', '30-script.ps1', '40-native.exe'])
      expect(hookScripts(path.join(dir, 'missing'))).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })

  it('keeps the POSIX executable-bit contract regardless of filename extension', () => {
    const dir = temporaryDirectory()
    for (const name of ['10-first', '20-second.ps1', 'not-executable.exe']) fs.writeFileSync(path.join(dir, name), '')
    const realStat = fs.statSync
    vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike) => {
      const stat = realStat(file)
      stat.mode = String(file).endsWith('not-executable.exe') ? 0o100644 : 0o100755
      return stat
    }) as typeof fs.statSync)
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      expect(hookScripts(dir).map(file => path.basename(file))).toEqual(['10-first', '20-second.ps1'])
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })
})

describe('runHooks', () => {
  function unsignedPowerShellScriptsBlocked(): boolean {
    if (nativePlatform !== 'win32') return false
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key]
    const powershell = path.win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const policy = childProcess.execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'], { env, encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()
    if (!['Restricted', 'AllSigned', 'RemoteSigned', 'Unrestricted', 'Bypass'].includes(policy)) throw new Error(`Unknown effective Windows PowerShell execution policy: ${policy}`)
    return policy === 'Restricted' || policy === 'AllSigned'
  }

  function hookDirectory(): string {
    const home = temporaryDirectory()
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const dir = path.join(home, '.config', 'herald-os', 'hooks', 'wake.d')
    fs.mkdirSync(dir, { recursive: true })
    vi.mocked(log).mockClear()
    return dir
  }

  const event: HeraldEvent = { name: 'wake', at: 1_700_000_000_000, detail: { message: 'Grüße "quoted" $();&' } }

  it('passes literal argv and event environment without a shell on both platforms', () => {
    const dir = hookDirectory()
    const script = path.join(dir, '10-hook.ps1')
    const executable = path.join(dir, '20-hook.exe')
    for (const file of [script, executable]) fs.writeFileSync(file, '', { mode: 0o755 })
    const children: EventEmitter[] = []
    const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation((() => {
      const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: vi.fn() })
      children.push(child)
      return child
    }) as unknown as typeof childProcess.spawn)
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.stubEnv('PSModulePath', 'foreign-modules')
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      runHooks(event)
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(spawn.mock.calls[0][0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      expect(spawn.mock.calls[0][1]).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, 'wake'])
      expect(spawn.mock.calls[1][0]).toBe(executable)
      expect(spawn.mock.calls[1][1]).toEqual(['wake'])
      const psOptions = spawn.mock.calls[0][2]!
      const exeOptions = spawn.mock.calls[1][2]!
      expect(psOptions).toMatchObject({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      expect(psOptions.shell).toBeUndefined()
      expect(Object.keys(psOptions.env!).some(key => key.toLowerCase() === 'psmodulepath')).toBe(false)
      expect(exeOptions.env).toEqual({ ...process.env, HERALD_EVENT: 'wake', HERALD_EVENT_AT: '2023-11-14T22:13:20.000Z', HERALD_EVENT_JSON: JSON.stringify(event), HERALD_EVENT_MESSAGE: event.detail.message })
      expect(psOptions.env).toMatchObject({ HERALD_EVENT: 'wake', HERALD_EVENT_AT: '2023-11-14T22:13:20.000Z', HERALD_EVENT_JSON: JSON.stringify(event), HERALD_EVENT_MESSAGE: event.detail.message })
      expect(process.env.PSModulePath).toBe('foreign-modules')
      children.splice(0).forEach(child => child.emit('exit', 0))

      spawn.mockClear()
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const realStat = fs.statSync
      vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike) => Object.assign(realStat(file), { mode: 0o100755 })) as typeof fs.statSync)
      runHooks(event)
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(spawn.mock.calls[0][0]).toBe(script)
      expect(spawn.mock.calls[0][1]).toEqual(['wake'])
      expect(spawn.mock.calls[0][2]).toEqual({ env: { ...process.env, HERALD_EVENT: 'wake', HERALD_EVENT_AT: '2023-11-14T22:13:20.000Z', HERALD_EVENT_JSON: JSON.stringify(event), HERALD_EVENT_MESSAGE: event.detail.message }, stdio: ['ignore', 'pipe', 'pipe'] })
    } finally {
      children.forEach(child => child.emit('exit', 0))
      Object.defineProperty(process, 'platform', descriptor)
    }
  })

  it('fails closed without an absolute SystemRoot and still starts executable hooks', () => {
    const dir = hookDirectory()
    fs.writeFileSync(path.join(dir, '10-hook.ps1'), '')
    fs.writeFileSync(path.join(dir, '20-hook.exe'), '')
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: vi.fn() })
    const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValue(child as unknown as ReturnType<typeof childProcess.spawn>)
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    vi.useFakeTimers()
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      for (const root of [undefined, 'relative']) {
        vi.stubEnv('SystemRoot', root)
        spawn.mockClear()
        vi.mocked(log).mockClear()
        runHooks(event)
        expect(spawn).toHaveBeenCalledTimes(1)
        expect(spawn.mock.calls[0][0]).toBe(path.join(dir, '20-hook.exe'))
        expect(log).toHaveBeenCalledWith('hooks', expect.stringContaining('Cannot locate Windows PowerShell 5.1'))
        child.emit('error', new Error('test launch failure'))
        expect(vi.getTimerCount()).toBe(0)
      }
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })

  it('executes real platform scripts with literal event data and native module resolution', async () => {
    const blocked = unsignedPowerShellScriptsBlocked()
    const dir = hookDirectory()
    const result = path.join(dir, 'result.json')
    const sample = { ...event, detail: { ...event.detail, 'output-file': result } }
    vi.stubEnv('PSModulePath', path.join(dir, 'foreign PowerShell 7 modules'))
    const script = nativePlatform === 'win32'
      ? `$ErrorActionPreference = 'Stop'\n$acl = Get-Acl -LiteralPath $PSCommandPath\n$data = [ordered]@{ argument = $args[0]; event = $env:HERALD_EVENT; at = $env:HERALD_EVENT_AT; json = $env:HERALD_EVENT_JSON; message = $env:HERALD_EVENT_MESSAGE; nativeModule = ($null -ne $acl.Owner); modulePath = $env:PSModulePath }\n[IO.File]::WriteAllText($env:HERALD_EVENT_OUTPUT_FILE, ($data | ConvertTo-Json -Compress))\n`
      : '#!/bin/sh\nprintf "%s" "$HERALD_EVENT_JSON" > "$HERALD_EVENT_OUTPUT_FILE"\n'
    fs.writeFileSync(path.join(dir, nativePlatform === 'win32' ? '10-real.PS1' : '10-real'), script, { mode: 0o755 })
    if (nativePlatform === 'win32') {
      const lookup = temporaryDirectory()
      fs.writeFileSync(path.join(lookup, 'wake.exe'), 'lookup target; never executed')
      fs.copyFileSync(path.join(process.env.SystemRoot!, 'System32', 'where.exe'), path.join(dir, '20-real.exe'))
      vi.stubEnv('PATH', lookup)
      vi.stubEnv('PATHEXT', '.EXE')
    }
    runHooks(sample)
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith('hooks', blocked
        ? expect.stringMatching(/10-real\.PS1 exited 1:[\s\S]*FullyQualifiedErrorId\s*:\s*UnauthorizedAccess/)
        : expect.stringContaining(`${nativePlatform === 'win32' ? '10-real.PS1' : '10-real'} exited 0`))
      if (nativePlatform === 'win32') expect(log).toHaveBeenCalledWith('hooks', expect.stringContaining('20-real.exe exited 0'))
    }, { timeout: 15_000 })
    if (blocked) {
      expect(fs.existsSync(result)).toBe(false)
    } else {
      const recorded = JSON.parse(fs.readFileSync(result, 'utf8'))
      if (nativePlatform === 'win32') {
        const { modulePath, ...eventData } = recorded
        expect(modulePath).not.toContain('foreign PowerShell 7 modules')
        expect(eventData).toEqual({ argument: 'wake', event: 'wake', at: '2023-11-14T22:13:20.000Z', json: JSON.stringify(sample), message: event.detail.message, nativeModule: true })
      } else {
        expect(recorded).toEqual(sample)
      }
    }
    expect(process.env.PSModulePath).toBe(path.join(dir, 'foreign PowerShell 7 modules'))
  }, 20_000)

  it('reports real process failures and continues to the next hook', async () => {
    const blocked = unsignedPowerShellScriptsBlocked()
    const dir = hookDirectory()
    const suffix = nativePlatform === 'win32' ? '.ps1' : ''
    const header = nativePlatform === 'win32' ? '' : '#!/bin/sh\n'
    fs.writeFileSync(path.join(dir, `10-failure${suffix}`), `${header}exit 7\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(dir, `30-success${suffix}`), `${header}exit 0\n`, { mode: 0o755 })
    if (nativePlatform === 'win32') fs.writeFileSync(path.join(dir, '20-invalid.exe'), 'not a PE executable')
    runHooks(event)
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith('hooks', blocked
        ? expect.stringMatching(/10-failure\.ps1 exited 1:[\s\S]*FullyQualifiedErrorId\s*:\s*UnauthorizedAccess/)
        : expect.stringContaining(`10-failure${suffix} exited 7`))
      expect(log).toHaveBeenCalledWith('hooks', blocked
        ? expect.stringMatching(/30-success\.ps1 exited 1:[\s\S]*FullyQualifiedErrorId\s*:\s*UnauthorizedAccess/)
        : expect.stringContaining(`30-success${suffix} exited 0`))
      if (nativePlatform === 'win32') expect(log).toHaveBeenCalledWith('hooks', expect.stringContaining('20-invalid.exe:'))
    }, { timeout: 15_000 })
  }, 20_000)
})
