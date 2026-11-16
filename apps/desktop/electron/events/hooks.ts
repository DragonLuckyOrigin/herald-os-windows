import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type HeraldEvent, hookEnv } from '../../shared/events.ts'
import { log } from '../log.ts'

/** A hook that runs longer than this is stopped: hooks are for quick chores, not services. */
const HOOK_TIMEOUT_MS = 120_000

export function hooksDir(): string {
  return path.join(os.homedir(), '.config', 'herald-os', 'hooks')
}

/** The scripts that run for an event: executable files in `<event>.d`, in name order (`.sample` files and dotfiles skipped). */
export function hookScripts(dir: string): string[] {
  let names: string[]

  try {
    names = fs.readdirSync(dir).sort()
  } catch {
    return []
  }

  return names
    .filter(name => !name.startsWith('.') && !name.endsWith('.sample') && !name.endsWith('~'))
    .map(name => path.join(dir, name))
    .filter(file => {
      try {
        const stat = fs.statSync(file)

        return stat.isFile() && (process.platform === 'win32'
          ? ['.ps1', '.exe'].includes(path.extname(file).toLowerCase())
          : (stat.mode & 0o111) !== 0)
      } catch {
        return false
      }
    })
}

/** Run the person's hook scripts for an event, each with the event in its environment. Never waits on them. */
export function runHooks(event: HeraldEvent): void {
  for (const script of hookScripts(path.join(hooksDir(), `${event.name}.d`))) {
    const windows = process.platform === 'win32'
    let command = windows ? path.resolve(script) : script
    let args = [event.name] as string[]
    const env = { ...process.env, ...hookEnv(event) }
    if (windows && path.extname(script).toLowerCase() === '.ps1') {
      const windowsRoot = process.env.SystemRoot
      if (!windowsRoot || !/^[A-Za-z]:[\\/]/.test(windowsRoot)) {
        log('hooks', `${script}: Cannot locate Windows PowerShell 5.1`)
        continue
      }
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', command, event.name]
      command = path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      // A PowerShell 7 parent can otherwise supply incompatible system modules to Windows PowerShell.
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'psmodulepath') delete env[key]
      }
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], ...(windows ? { windowsHide: true } : {}) })
    } catch (error) {
      if (!windows) throw error
      log('hooks', `${script}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    let output = ''
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-2000)
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), HOOK_TIMEOUT_MS)
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', error => {
      if (windows) clearTimeout(timer)
      log('hooks', `${script}: ${error.message}`)
    })
    child.on('exit', code => {
      clearTimeout(timer)
      log('hooks', `${event.name}: ${path.basename(script)} exited ${code ?? 'by signal'}${output.trim() ? `: ${output.trim().slice(-400)}` : ''}`)
    })
  }
}
