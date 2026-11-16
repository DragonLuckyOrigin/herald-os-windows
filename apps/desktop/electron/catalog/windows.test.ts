import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogGroup } from './catalog.ts'
import { windowsCatalog } from './windows.ts'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const groups: CatalogGroup[] = [{ id: 'ai', label: 'AI', entries: [
  { id: 'codex', label: 'Codex', bin: ['codex'], terminal: true, install: [{ kind: 'npm', ref: '@openai/codex' }] },
  { id: 'claude-code', label: 'Claude Code', bin: ['claude'], terminal: true, install: [{ kind: 'npm', ref: '@anthropic-ai/claude-code' }] },
  { id: 'lm-studio', label: 'LM Studio', detect: ['/Applications/LM Studio.app'], install: [{ kind: 'brew-cask', ref: 'lm-studio' }] }
] }, { id: 'developer', label: 'Developer', entries: [
  { id: 'node', label: 'Node.js', install: [{ kind: 'mise', ref: 'node' }] },
  { id: 'python', label: 'Python', install: [{ kind: 'mise', ref: 'python' }] }
] }]

describe('Windows software inventory', () => {
  it('shares async PATH reads and detects the Windows name even when the catalog specifies another name', async () => {
    const read = vi.spyOn(fs.promises, 'readdir').mockResolvedValue(['python.exe'] as never)
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => true, size: 4 } as never)
    const source: CatalogGroup[] = [{ id: 'developer', label: 'Developer', entries: [{ id: 'python', label: 'Python', bin: ['python3'], install: [] }, { id: 'node', label: 'Node', install: [] }] }]
    const entries = (await windowsCatalog(source, [], 'C:\\Tools;C:\\Tools', '.EXE')).flatMap(group => group.entries)
    expect(entries.find(entry => entry.id === 'python')?.installed).toBe(true)
    expect(entries.find(entry => entry.id === 'node')?.installed).toBe(false)
    expect(read).toHaveBeenCalledOnce()
  })

  it.runIf(process.platform === 'win32')('detects real executables and npm launchers in semicolon-delimited Windows PATH without running them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-catalog-'))
    roots.push(root)
    const bin = path.join(root, 'Tools with spaces')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo detection must never execute this')
    fs.writeFileSync(path.join(bin, 'node.exe'), 'fixture')
    fs.mkdirSync(path.join(bin, 'claude.exe'))
    fs.writeFileSync(path.join(bin, 'python.exe'), '') // An alias/placeholder is not a verified runtime.
    const view = await windowsCatalog(groups, [{ name: 'LM Studio', path: 'C:\\Start\\LM Studio.lnk' }], `C:\\missing;"${bin}"`, '.EXE;.CMD;.BAT;.COM')
    const entries = view.flatMap(group => group.entries)
    expect(entries.find(entry => entry.id === 'codex')).toMatchObject({ installed: true, terminal: true, available: false, removable: false })
    expect(entries.find(entry => entry.id === 'node')).toMatchObject({ installed: true })
    expect(entries.find(entry => entry.id === 'claude-code')).toMatchObject({ installed: false })
    expect(entries.find(entry => entry.id === 'python')).toMatchObject({ installed: false })
    expect(entries.find(entry => entry.id === 'lm-studio')).toMatchObject({ installed: true })
    expect(entries.every(entry => !entry.available && !entry.removable && entry.method === null)).toBe(true)
  })

  it('does not claim a desktop shortcut or partial name is an installed coding CLI', async () => {
    const view = await windowsCatalog(groups, [{ name: 'Codex', path: 'C:\\Codex.lnk' }, { name: 'Uninstall LM Studio', path: 'C:\\remove.lnk' }], '', '.EXE')
    expect(view.flatMap(group => group.entries).filter(entry => ['codex', 'lm-studio'].includes(entry.id)).every(entry => !entry.installed)).toBe(true)
    expect(view.find(group => group.id === 'windows-apps')?.entries).toContainEqual(expect.objectContaining({ label: 'Codex', installed: true, available: false }))
  })

  it('ignores untrusted binary names', async () => {
    const read = vi.spyOn(fs.promises, 'readdir').mockResolvedValue(['../node.exe', 'node & whoami.exe'] as never)
    const stat = vi.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => true, size: 4 } as never)
    const malicious: CatalogGroup[] = [{ id: 'ai', label: 'AI', entries: [{ id: 'lm-studio', label: 'LM Studio', bin: ['../node', 'node & whoami'], install: [] }] }]
    expect((await windowsCatalog(malicious, [], 'C:\\Tools', '.EXE')).flatMap(group => group.entries).every(entry => !entry.installed)).toBe(true)
    expect(read).toHaveBeenCalledOnce()
    expect(stat).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'win32')('rejects a relative PATH directory even when a valid launcher exists there', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-catalog-'))
    roots.push(root)
    fs.writeFileSync(path.join(root, 'node.exe'), 'fixture')
    const relative = path.relative(process.cwd(), root)
    expect(path.isAbsolute(relative)).toBe(false)
    expect(fs.existsSync(path.join(relative, 'node.exe'))).toBe(true)
    expect((await windowsCatalog(groups, [], relative)).flatMap(group => group.entries).find(entry => entry.id === 'node')?.installed).toBe(false)
  })

  it('keeps stable app identities across inventory order and removes duplicate names', async () => {
    const apps = [{ name: 'Editor', path: 'C:\\User\\Editor.lnk' }, { name: 'EDITOR', path: 'C:\\All\\Editor.lnk' }, { name: 'Browser', path: 'C:\\Browser.lnk' }]
    const first = (await windowsCatalog([], apps, ''))[0].entries
    const reordered = (await windowsCatalog([], [...apps].reverse(), ''))[0].entries
    expect(first).toHaveLength(2)
    expect(first.map(entry => entry.id).sort()).toEqual(reordered.map(entry => entry.id).sort())
  })

  it('does not infer Windows support from a Linux binary name', async () => {
    const unsupported: CatalogGroup[] = [{ id: 'tools', label: 'Tools', entries: [{ id: 'linux-only', label: 'Linux only', bin: ['some-tool'], install: [] }] }]
    expect(await windowsCatalog(unsupported, [], '')).toEqual([])
  })
})
