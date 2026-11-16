import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import type { BackendRuntime } from '../../shared/ipc.ts'
import { osEnv } from '../env.ts'
import { hermesHome } from '../paths.ts'

const isExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK)

    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** App execution aliases are reparse points whose protected package target may reject Node stat. */
function isAppExecutionAlias(file: string): boolean {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !/^[A-Za-z]:[\\/]/.test(file)) return false
  try {
    // Windows X_OK checks visibility, not publisher identity or a future launch's success.
    fs.accessSync(file, fs.constants.X_OK)
    const root = process.env.SystemRoot
    if (!root || !/^[A-Za-z]:[\\/]/.test(root)) return false
    const ffi = createRequire(import.meta.url)('koffi') as typeof import('koffi')
    const kernel = ffi.load(path.win32.join(root, 'System32', 'kernel32.dll'))
    const open = kernel.func('void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)')
    const info = kernel.func('int __stdcall GetFileInformationByHandleEx(void *handle, int kind, void *data, uint32_t size)')
    const close = kernel.func('int __stdcall CloseHandle(void *handle)')
    // Read attributes from the reparse point itself; never open or execute its resolved target.
    const handle = open(file, 0x80, 7, null, 3, 0x00200000, null) as bigint | null
    if (!handle || handle === 0xffffffffffffffffn) return false
    try {
      const data = Buffer.alloc(8)
      if (!info(handle, 9, data, data.length)) return false // FileAttributeTagInfo
      const attributes = data.readUInt32LE(0)
      return Boolean(attributes & 0x400) && !(attributes & 0x10) && data.readUInt32LE(4) === 0x8000001b
    } finally {
      if (!close(handle)) throw new Error('Could not close alias metadata handle')
    }
  } catch {
    return false
  }
}

/**
 * A source checkout is usable only with the `serve` subcommand and an install of it, in either layout
 * Hermes Agent's installers leave:
 *   - `.hermes/bin/hermes`, the launcher today's installers publish (it runs the Python and the
 *     dependencies Hermes keeps in $HERMES_HOME/tools and $HERMES_HOME/installs);
 *   - `venv/bin/python`, the virtualenv earlier installers made inside the checkout.
 * The launcher wins: an update to the new layout leaves the old venv behind, unused. `herald-os`
 * (linux/bin/herald-os, `hermes_install`) looks for Hermes the same way.
 */
export function checkoutRuntime(root: string, kind: BackendRuntime['kind'], label: string): BackendRuntime | null {
  if (!fs.existsSync(path.join(root, 'hermes_cli', 'subcommands', 'dashboard.py'))) {
    return null
  }

  const launcher = path.join(root, '.hermes', 'bin', process.platform === 'win32' ? 'hermes.exe' : 'hermes')

  if (isExecutable(launcher)) {
    return { kind, label, root, command: [launcher] }
  }

  const python = path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

  return isExecutable(python) ? { kind, label, root, command: [python, '-m', 'hermes_cli.main'] } : null
}

export function pathRuntime(extraDirs: string[]): BackendRuntime | null {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...extraDirs].filter(Boolean)
  const names = process.platform === 'win32' ? ['hermes.exe', 'hermes-canary.exe'] : ['hermes']

  // An installed stable launcher wins even when the Windows alias is in an earlier directory.
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name)

      if (isExecutable(candidate) || isAppExecutionAlias(candidate)) {
        return { kind: 'path', label: `hermes on PATH (${candidate})`, command: [candidate] }
      }
    }
  }

  return null
}

/**
 * On the Herald OS image, firstboot.sh's note that Hermes Agent is not installed yet because the first
 * start had no network: one word for what herald-os-hermes.service is doing about it (offline,
 * installing, retrying). While it is there the shell waits, rather than start a Hermes that is still
 * being installed and set up.
 */
export const HERMES_PENDING = '/var/lib/herald-os/hermes-pending'

export function pendingInstall(file = HERMES_PENDING): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim() || 'pending'
  } catch {
    return null
  }
}

/**
 * Ordered ladder. Each rung is validated before it is trusted; a failed read falls to the next.
 *   1. HERALD_OS_HERMES_ROOT (explicit developer override)
 *   2. $HERMES_HOME/hermes-agent managed install, in either layout (what the official installer and
 *      `hermes update` maintain)
 *   3. `hermes` shim on PATH (+ the usual user bin dirs a GUI app does not inherit)
 */
export function resolveBackendRuntime(): BackendRuntime | null {
  const envRoot = osEnv('HERMES_ROOT')?.trim()

  if (envRoot) {
    const runtime = checkoutRuntime(envRoot, 'env', `HERALD_OS_HERMES_ROOT (${envRoot})`)

    if (runtime) {
      return runtime
    }
  }

  const managed = checkoutRuntime(path.join(hermesHome(), 'hermes-agent'), 'managed', 'managed Hermes install')

  if (managed) {
    return managed
  }

  return pathRuntime([path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'])
}
