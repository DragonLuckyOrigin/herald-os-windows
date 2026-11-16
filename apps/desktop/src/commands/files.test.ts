import { beforeEach, describe, expect, it, vi } from 'vitest'
import { $env } from '../store/backend.ts'
import { $location, $selectedPath } from '../features/files/files-store.ts'
import { filesCommands, resolvePlace } from './files.ts'

const edges = vi.hoisted(() => ({ find: vi.fn(), readDir: vi.fn(), open: vi.fn(), home: vi.fn() }))
vi.mock('../lib/use-async.ts', () => ({ useLocalData: vi.fn() }))
vi.mock('../store/chat.ts', () => ({ sendPrompt: vi.fn() }))
vi.mock('../store/notifications.ts', () => ({ notify: vi.fn() }))
vi.mock('../store/web-windows.ts', () => ({ openFileWindow: edges.open }))
vi.mock('../store/windows.ts', () => ({ showPage: vi.fn() }))
vi.mock('../features/canvas/open.ts', () => ({ openInCanvas: vi.fn() }))
vi.mock('../features/files/files-store.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../features/files/files-store.ts')>(),
  ensureHome: edges.home
}))

function onPlatform(platform: NodeJS.Platform) {
  $env.set({ platform, hermesHome: '/h/.hermes', homeDir: '/h', version: '0.0.0', isDev: false, shellMode: 'panels' })
  edges.home.mockResolvedValue(platform === 'win32' ? String.raw`C:\Users\tester` : '/home/tester')
}

function run(id: string, args: Record<string, unknown>) {
  const command = filesCommands.find(entry => entry.id === id)
  if (!command) throw new Error(`Missing command ${id}`)
  return command.run(args, { source: 'ui' })
}

beforeEach(() => {
  vi.clearAllMocks()
  edges.find.mockResolvedValue([])
  edges.readDir.mockResolvedValue([])
  edges.open.mockResolvedValue('viewer-test')
  vi.stubGlobal('window', { heraldOS: { fs: { find: edges.find, readDir: edges.readDir } } })
  onPlatform('win32')
  $location.set({ kind: 'favorites' })
  $selectedPath.set(null)
})

describe('Windows command paths', () => {
  it.each([String.raw`C:\Audit Folder\Grüße 日本語`, 'C:/Audit Folder/Grüße 日本語', String.raw`c:\Audit/mixed`, 'C:\\', 'C:/'])('opens an explicit directory: %s', async path => {
    expect(await resolvePlace(`  ${path}  `)).toMatchObject({ path })
    expect(await run('files.open', { place: path })).toMatchObject({ ok: true, data: { path } })
    expect($location.get()).toEqual({ kind: 'dir', path })
    expect(edges.find).not.toHaveBeenCalled()
  })

  it.each([String.raw`C:\Audit Folder\Grüße 日本語.txt`, 'C:/Audit Folder/Grüße 日本語.txt'])('opens an explicit viewable file without a name search: %s', async path => {
    expect(await run('file.open', { name: ` ${path} ` })).toMatchObject({ ok: true, data: { path } })
    expect(edges.open).toHaveBeenCalledExactlyOnceWith(path)
    expect(edges.find).not.toHaveBeenCalled()
  })

  it.each(['C:relative.txt', 'C:', String.raw`\rooted.txt`, '/rooted.txt', String.raw`\\server\share\file.txt`, '//server/share/file.txt', String.raw`\\?\C:\file.txt`, String.raw`\\.\pipe\file.txt`, String.raw`\??\C:\file.txt`])('rejects unsupported path syntax without a search or viewer: %s', async path => {
    expect(await resolvePlace(path)).toBeNull()
    expect(await run('file.open', { name: path })).toMatchObject({ ok: false })
    expect(edges.find).not.toHaveBeenCalled()
    expect(edges.open).not.toHaveBeenCalled()
    expect($location.get()).toEqual({ kind: 'favorites' })
  })

  it('preserves home expansion and named places', async () => {
    expect(await resolvePlace('~/Audit Folder')).toMatchObject({ path: String.raw`C:\Users\tester/Audit Folder` })
    expect(await resolvePlace('my documents folder')).toMatchObject({ path: String.raw`C:\Users\tester/Documents` })
    expect(await run('file.open', { name: '~/note.txt' })).toMatchObject({ ok: true })
    expect(edges.open).toHaveBeenCalledWith(String.raw`C:\Users\tester/note.txt`)
    expect(await resolvePlace('recent')).toEqual({ kind: 'recent' })
    expect(await resolvePlace('favorites')).toEqual({ kind: 'favorites' })
  })

  it.each([
    [String.raw`C:\Audit Folder\book.xlsx`, String.raw`C:\Audit Folder`],
    ['C:/Audit Folder/book.xlsx', String.raw`C:\Audit Folder`],
    [String.raw`C:\book.xlsx`, 'C:\\']
  ])('selects a non-viewable file in its actual parent: %s', async (path, parent) => {
    expect(await run('file.open', { name: path })).toMatchObject({ ok: true })
    expect($location.get()).toEqual({ kind: 'dir', path: parent })
    // readDir returns native separators; selection must match the actual entry path.
    expect($selectedPath.get()).toBe(path.replaceAll('/', '\\'))
    expect(edges.open).not.toHaveBeenCalled()
  })

  it.each([String.raw`C:\Audit Folder\book.xlsx`, 'C:/Audit Folder/book.xlsx'])('uses the same parent in files.show: %s', async path => {
    edges.readDir.mockRejectedValueOnce(new Error('not a directory'))
    expect(await run('files.show', { path })).toMatchObject({ ok: true })
    expect($location.get()).toEqual({ kind: 'dir', path: String.raw`C:\Audit Folder` })
    expect($selectedPath.get()).toBe(path.replaceAll('/', '\\'))
  })

  it.each(['C:\\', 'C:relative.xlsx', String.raw`\\server\share\book.xlsx`])('does not invent a parent after readDir rejects %s', async path => {
    edges.readDir.mockRejectedValueOnce(new Error('unavailable'))
    expect(await run('files.show', { path })).toMatchObject({ ok: false })
    expect($location.get()).toEqual({ kind: 'favorites' })
    expect($selectedPath.get()).toBeNull()
  })

  it('retains filename search and rejects an invalid search-result parent', async () => {
    edges.find.mockResolvedValueOnce([{ kind: 'file', path: 'relative.xlsx' }])
    expect(await run('file.open', { name: 'book.xlsx' })).toMatchObject({ ok: false })
    expect(edges.find).toHaveBeenCalledExactlyOnceWith('book.xlsx', 8)
    expect($location.get()).toEqual({ kind: 'favorites' })
    expect($selectedPath.get()).toBeNull()
  })
})

describe.each(['linux', 'darwin'] as const)('existing paths on %s', platform => {
  beforeEach(() => onPlatform(platform))

  it('preserves absolute directories, home expansion and file parent selection', async () => {
    expect(await resolvePlace('/tmp/Grüße')).toMatchObject({ path: '/tmp/Grüße' })
    expect(await resolvePlace('~/Documents')).toMatchObject({ path: '/home/tester/Documents' })
    expect(await run('file.open', { name: '/tmp/book.xlsx' })).toMatchObject({ ok: true })
    expect($location.get()).toEqual({ kind: 'dir', path: '/tmp' })
    expect($selectedPath.get()).toBe('/tmp/book.xlsx')
  })

  it('does not reinterpret a Windows drive path as a local absolute directory', async () => {
    expect(await resolvePlace(String.raw`C:\Audit`)).toBeNull()
  })
})
