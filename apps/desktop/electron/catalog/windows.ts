import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { CatalogGroupView, InstalledApp } from '../../shared/ipc.ts'
import { type CatalogGroup, entryView } from './catalog.ts'
import { run } from '../platform/exec.ts'

// Get-StartApps covers registered apps which have no .lnk (including packaged Windows apps).
// This fixed metadata query never runs any of the discovered applications or their installers.
export const WINDOWS_START_APPS = "$ErrorActionPreference = 'Stop'; $env:PSModulePath = $PSHOME + '\\Modules'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-StartApps | Select-Object -First 4096 Name,AppID) | ConvertTo-Json -Compress"

export async function windowsStartApps(): Promise<InstalledApp[]> {
  const root = process.env.SystemRoot
  if (!root || !/^[A-Za-z]:[\\/]/.test(root)) throw new Error('Windows application inventory requires Windows PowerShell 5.1.')
  const result = await run(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_START_APPS], 8000, 2 * 1024 * 1024)
  if (result.code !== 0) throw new Error(`Windows application inventory failed (exit ${result.code}).`)
  const value: unknown = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim() || '[]')
  return (Array.isArray(value) ? value : value == null ? [] : [value]).slice(0, 4096).flatMap(item => {
    if (!item || typeof item !== 'object' || typeof item.Name !== 'string' || !item.Name.trim() || typeof item.AppID !== 'string' || !item.AppID) return []
    return [{ name: item.Name, path: item.AppID }]
  })
}

// Reuse catalog identities; these names are Windows launchers, never shell commands.
const WINDOWS_BINS: Record<string, string[]> = {
  'claude-code': ['claude'], codex: ['codex'], opencode: ['opencode'], 'gemini-cli': ['gemini'], 'copilot-cli': ['copilot'],
  ollama: ['ollama'], mise: ['mise'], php: ['php'], elixir: ['elixir'], dotnet: ['dotnet'], podman: ['podman'],
  neovim: ['nvim'], helix: ['hx', 'helix'],
  node: ['node'], bun: ['bun'], deno: ['deno'], python: ['python', 'python3'], go: ['go'],
  rust: ['rustc'], ruby: ['ruby'], rails: ['rails'], laravel: ['laravel'], java: ['java'],
  zig: ['zig'], lazydocker: ['lazydocker'], vscode: ['code'], zed: ['zed'], 'sublime-text': ['subl'], emacs: ['emacs']
}
const WINDOWS_APPS: Record<string, string[]> = {
  'lm-studio': ['LM Studio'], ollama: ['Ollama'], vscode: ['Visual Studio Code'], zed: ['Zed'],
  'sublime-text': ['Sublime Text'], steam: ['Steam'], retroarch: ['RetroArch'], heroic: ['Heroic Games Launcher'],
  'prism-launcher': ['Prism Launcher'], moonlight: ['Moonlight'], 'geforce-now': ['GeForce NOW'],
  obs: ['OBS Studio', 'OBS Studio (64bit)'], kdenlive: ['Kdenlive'], mpv: ['mpv'], pinta: ['Pinta'],
  xournalpp: ['Xournal++'], '1password': ['1Password'], bitwarden: ['Bitwarden'], dropbox: ['Dropbox'],
  tailscale: ['Tailscale'], alacritty: ['Alacritty'], zoom: ['Zoom', 'Zoom Workplace'], discord: ['Discord']
}

// The shared Linux catalog also describes installation methods and versions. Windows only
// inventories existing launchers, so it must not claim those methods or versions were verified.
const WINDOWS_DESCRIPTIONS: Record<string, string> = {
  mise: 'Manage language versions.', node: 'The Node.js JavaScript runtime.',
  python: 'The Python programming language.', rust: 'The Rust programming language.',
  ruby: 'The Ruby programming language.', rails: 'The Ruby on Rails framework.',
  php: 'The PHP programming language.', laravel: 'The Laravel installer.',
  java: 'A Java runtime.', elixir: 'The Elixir programming language.', dotnet: 'The .NET command-line tools.',
  podman: 'Manage containers with Podman.', steam: "Valve's game store and launcher.",
  'geforce-now': "NVIDIA's cloud gaming service.", zoom: 'Video meetings with Zoom.'
}

function pathInventory(searchPath: string, pathExt: string): (names: string[]) => Promise<boolean> {
  const extensions = pathExt.split(';').filter(ext => /^\.(exe|com|cmd|bat)$/i.test(ext))
  const directories = searchPath.split(';').map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(dir => /^[A-Za-z]:[\\/]/.test(dir))
  // Share one async directory read per PATH component across all catalog entries. A slow drive
  // must not freeze Electron's main thread; no launcher is executed to identify software.
  const listings = new Map<string, Promise<Set<string>>>()
  const files = new Map<string, Promise<boolean>>()
  return async names => {
    for (const dir of directories) {
      const key = path.win32.normalize(dir).toLowerCase()
      if (!listings.has(key)) listings.set(key, fs.readdir(dir).then(items => new Set(items.map(item => item.toLowerCase()))).catch(() => new Set()))
      const listing = await listings.get(key)!
      for (const name of names.filter(bin => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(bin))) {
        for (const extension of extensions) {
          const filename = name + extension
          if (!listing.has(filename.toLowerCase())) continue
          const candidate = path.join(dir, filename)
          const fileKey = candidate.toLowerCase()
          // Empty App Execution Aliases cannot establish that a runtime is actually installed.
          if (!files.has(fileKey)) files.set(fileKey, fs.stat(candidate).then(stat => stat.isFile() && stat.size > 0).catch(() => false))
          if (await files.get(fileKey)) return true
        }
      }
    }
    return false
  }
}

/** Read-only Windows inventory. Detection never executes a tool or offers a macOS installer. */
export async function windowsCatalog(groups: CatalogGroup[], apps: InstalledApp[], searchPath: string, pathExt = '.COM;.EXE;.BAT;.CMD'): Promise<CatalogGroupView[]> {
  const onPath = pathInventory(searchPath, pathExt)
  const names = new Set(apps.map(app => app.name.toLowerCase()))
  const matchedApps = new Set<string>()
  const result = (await Promise.all(groups.map(async group => ({
    id: group.id, label: group.label,
    description: group.id === 'developer' ? 'Programming languages and container tools.' : group.id === 'terminals' ? 'Terminal applications.' : group.description ?? '',
    entries: await Promise.all(group.entries.filter(entry => Object.hasOwn(WINDOWS_BINS, entry.id) || Object.hasOwn(WINDOWS_APPS, entry.id)).map(async entry => {
      const cli = await onPath([...new Set([...(entry.bin ?? []), ...(WINDOWS_BINS[entry.id] ?? [])])])
      const aliases = WINDOWS_APPS[entry.id] ?? []
      const installedApps = aliases.filter(name => names.has(name.toLowerCase()))
      for (const name of installedApps) matchedApps.add(name.toLowerCase())
      return entryView(group, { ...entry, description: Object.hasOwn(WINDOWS_DESCRIPTIONS, entry.id) ? WINDOWS_DESCRIPTIONS[entry.id] : entry.description, terminal: Boolean(entry.terminal && cli) }, {
        installed: cli || installedApps.length > 0, removable: false, method: null,
        reason: 'not detected in Windows PATH or the Start menu'
      })
    }))
  })))).filter(group => group.entries.length > 0)
  const remaining = [...new Map(apps.filter(app => !matchedApps.has(app.name.toLowerCase())).map(app => [app.name.toLowerCase(), app])).values()].sort((a, b) => a.name.localeCompare(b.name))
  if (remaining.length) {
    result.push({ id: 'windows-apps', label: 'Windows apps', description: 'Applications in the Windows Start menu.', entries: remaining.map(app => ({
      id: `windows-app-${createHash('sha256').update(app.name.toLowerCase()).digest('hex').slice(0, 24)}`, label: app.name, description: 'Windows Start menu application.', group: 'windows-apps',
      installed: true, removable: false, available: false, method: null
    })) })
  }
  return result
}
