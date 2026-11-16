import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $env } from '../../store/backend.ts'
import { $refreshTick, $selectedPath, basename, buildCrumbs, expandHome, isAbsoluteFilePath, joinPath, loadDirCount, loadThumbnail, parentOf, renameItem, type FileItem } from './files-store.ts'

const edges = vi.hoisted(() => ({ rename: vi.fn(), notify: vi.fn(), readDir: vi.fn(), thumbnail: vi.fn() }))
vi.mock('../../lib/use-async.ts', () => ({ useLocalData: vi.fn() }))
vi.mock('../../store/chat.ts', () => ({ sendPrompt: vi.fn() }))
vi.mock('../../store/notifications.ts', () => ({ notify: edges.notify }))
vi.mock('../../store/web-windows.ts', () => ({ openFileWindow: vi.fn() }))
vi.mock('../../store/windows.ts', () => ({ showPage: vi.fn() }))
vi.mock('../canvas/open.ts', () => ({ openInCanvas: vi.fn() }))

const onPlatform = (platform: NodeJS.Platform) => $env.set({ platform, hermesHome: '/h/.hermes', homeDir: '/h', version: '0.0.0', isDev: false, shellMode: 'panels' })
const itemAt = (path: string, name = 'Grüße 日本語 R1.txt'): FileItem => ({ path, name, kind: 'file', size: 0, modifiedAt: 0, extension: 'txt', hidden: false })
const original = String.raw`C:\private\Herald R1 Fixture\Grüße 日本語 R1.txt`
const renamed = String.raw`C:\private\Herald R1 Fixture\Grüße 日本語 R1 renamed.txt`

beforeEach(() => {
  vi.clearAllMocks()
  edges.rename.mockResolvedValue(undefined)
  edges.readDir.mockResolvedValue([])
  edges.thumbnail.mockResolvedValue('private-preview')
  vi.stubGlobal('window', { heraldOS: { fs: { rename: edges.rename, readDir: edges.readDir, thumbnail: edges.thumbnail } } })
  onPlatform('win32')
  $selectedPath.set(original)
  $refreshTick.set(7)
})
afterEach(() => {
  $env.set(null)
  vi.unstubAllGlobals()
})

describe('Windows Files path helpers', () => {
  it('preserves drive roots when expanding a space folder', () => {
    expect(expandHome('C:/', String.raw`C:\Users\tester`)).toBe('C:\\')
    expect(expandHome('C:\\', null)).toBe('C:\\')
    expect(expandHome('~/Documents', String.raw`C:\Users\tester`)).toBe(String.raw`C:\Users\tester/Documents`)
    expect(expandHome('C:', null)).toBe('C:')
  })

  it('builds usable native breadcrumbs within the selected space', () => {
    expect(buildCrumbs({ kind: 'dir', path: 'c:/work/Grüße 日本語/sub' }, 'C:\\work', 'Project', 'C:\\Users\\tester')).toEqual([
      { label: 'Project', location: { kind: 'dir', path: 'C:\\work' } },
      { label: 'Grüße 日本語', location: { kind: 'dir', path: 'C:\\work\\Grüße 日本語' } },
      { label: 'sub', location: { kind: 'dir', path: 'C:\\work\\Grüße 日本語\\sub' } }
    ])
  })

  it('uses the actual drive outside home and does not mistake a sibling prefix for the root', () => {
    expect(buildCrumbs({ kind: 'dir', path: 'D:\\workshop\\file' }, 'D:\\work', 'Project', 'C:\\Users\\tester')).toEqual([
      { label: 'D:', location: { kind: 'dir', path: 'D:\\' } },
      { label: 'workshop', location: { kind: 'dir', path: 'D:\\workshop' } },
      { label: 'file', location: { kind: 'dir', path: 'D:\\workshop\\file' } }
    ])
    expect(buildCrumbs({ kind: 'dir', path: 'C:relative' }, 'C:\\work', 'Project', null)).toEqual([])
  })

  it('recognizes supported absolute paths received from an Explorer drop', () => {
    expect(isAbsoluteFilePath('C:\\Grüße 日本語\\file.txt')).toBe(true)
    expect(isAbsoluteFilePath('D:/file.txt')).toBe(true)
    for (const input of ['C:relative', '/file.txt', 'file:///C:/file.txt', '\\\\server\\share\\file', '\\\\?\\C:\\file', undefined]) {
      expect(isAbsoluteFilePath(input)).toBe(false)
    }
  })

  it('preserves POSIX breadcrumbs and labels Linux roots correctly', () => {
    onPlatform('linux')
    expect(buildCrumbs({ kind: 'dir', path: '/etc/fonts' }, '/home/tester', 'Home', '/home/tester')).toEqual([
      { label: 'File System', location: { kind: 'dir', path: '/' } },
      { label: 'etc', location: { kind: 'dir', path: '/etc' } },
      { label: 'fonts', location: { kind: 'dir', path: '/etc/fonts' } }
    ])
    expect(expandHome('/', '/home/tester')).toBe('/')
    expect(isAbsoluteFilePath('/tmp/file.txt')).toBe(true)
    onPlatform('darwin')
    expect(buildCrumbs({ kind: 'dir', path: '/' }, '/Users/tester', 'Home', '/Users/tester')[0]?.label).toBe('Macintosh HD')
  })

  it.each([
    [String.raw`C:\folder\file.txt`, String.raw`C:\folder`],
    ['C:/folder/file.txt', String.raw`C:\folder`],
    [String.raw`C:\folder/sub\file.txt`, String.raw`C:\folder\sub`],
    [String.raw`C:\file.txt`, 'C:\\'],
    ['C:/file.txt', 'C:\\'],
    ['C:\\folder\\', 'C:\\']
  ])('finds the parent of %s', (path, parent) => expect(parentOf(path)).toBe(parent))

  it.each(['C:\\', 'C:/', 'C:', 'C:file.txt', String.raw`\file.txt`, '/file.txt', String.raw`\\server\share\file.txt`, String.raw`\\?\C:\file.txt`, String.raw`\\.\pipe\file.txt`, String.raw`\??\C:\file.txt`])('does not invent a parent for %s', path => {
    expect(parentOf(path)).toBeNull()
  })

  it.each(['C:\\', 'C:/', 'C:\\\\'])('joins a drive root with one separator: %s', root => {
    expect(joinPath(root, 'Grüße 日本語.txt')).toBe(String.raw`C:\Grüße 日本語.txt`)
  })

  it('accepts mixed separators without turning drive-relative input into an absolute path', () => {
    expect(joinPath(String.raw`C:\folder/sub/`, 'file.txt')).toBe(String.raw`C:\folder\sub\file.txt`)
    expect(joinPath('C:', 'file.txt')).toBe('C:file.txt')
    expect(joinPath('C:folder', 'file.txt')).toBe(String.raw`C:folder\file.txt`)
    expect(basename(String.raw`C:\folder/sub\Grüße 日本語.txt`)).toBe('Grüße 日本語.txt')
  })
})

describe('renameItem uses the existing IPC and updates state only on success', () => {
  it('renames the native Unicode file to a sibling and refreshes after IPC completes', async () => {
    let finish!: () => void
    edges.rename.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const result = renameItem(itemAt(original), 'Grüße 日本語 R1 renamed.txt')
    expect(edges.rename).toHaveBeenCalledExactlyOnceWith(original, renamed)
    expect($selectedPath.get()).toBe(original)
    expect($refreshTick.get()).toBe(7)
    finish()
    expect(await result).toBe(true)
    expect($selectedPath.get()).toBe(renamed)
    expect($refreshTick.get()).toBe(8)
    expect(edges.notify).not.toHaveBeenCalled()
  })

  it.each(['C:/old.txt', String.raw`C:\folder/mixed\old.txt`])('keeps the original source and composes a native sibling for %s', async path => {
    const destination = path === 'C:/old.txt' ? String.raw`C:\new.txt` : String.raw`C:\folder\mixed\new.txt`
    expect(await renameItem(itemAt(path, 'old.txt'), 'new.txt')).toBe(true)
    expect(edges.rename).toHaveBeenCalledExactlyOnceWith(path, destination)
    expect($selectedPath.get()).toBe(destination)
  })

  it('invalidates the old preview and its actual parent count after success', async () => {
    const parent = String.raw`C:\private\cache-proof`
    const file = String.raw`C:\private\cache-proof\old.txt`
    await loadDirCount(parent)
    await loadThumbnail(file, 64)
    expect(await renameItem(itemAt(file, 'old.txt'), 'new.txt')).toBe(true)
    await loadDirCount(parent)
    await loadThumbnail(file, 64)
    expect(edges.readDir).toHaveBeenCalledTimes(2)
    expect(edges.thumbnail).toHaveBeenCalledTimes(2)
  })

  it('retains selection, refresh and cached data when Main rejects a rename', async () => {
    edges.rename.mockRejectedValueOnce(new Error('destination already exists'))
    const file = String.raw`C:\private\failed-rename\old.txt`
    await loadThumbnail(file, 64)
    expect(await renameItem(itemAt(file, 'old.txt'), 'new.txt')).toBe(false)
    expect($selectedPath.get()).toBe(original)
    expect($refreshTick.get()).toBe(7)
    await loadThumbnail(file, 64)
    expect(edges.thumbnail).toHaveBeenCalledTimes(1)
    expect(edges.notify).toHaveBeenCalledExactlyOnceWith({ title: 'Could not rename "old.txt"', body: 'destination already exists', level: 'error' })
  })

  it.each(['C:', 'C:old.txt', String.raw`\old.txt`, String.raw`\\server\share\old.txt`, String.raw`\\?\C:\old.txt`])('does not send an ambiguous source to rename IPC: %s', async path => {
    expect(await renameItem(itemAt(path, 'old.txt'), 'new.txt')).toBe(false)
    expect(edges.rename).not.toHaveBeenCalled()
    expect($refreshTick.get()).toBe(7)
  })

  it.each(['', '  ', 'Grüße 日本語 R1.txt', '.', '..', 'a/b', String.raw`a\b`, 'a\0b'])('does not send an invalid Windows leaf name to IPC: %s', async name => {
    expect(await renameItem(itemAt(original), name)).toBe(false)
    expect(edges.rename).not.toHaveBeenCalled()
    expect($selectedPath.get()).toBe(original)
    expect($refreshTick.get()).toBe(7)
  })
})

describe.each(['linux', 'darwin'] as const)('POSIX Files behavior on %s', platform => {
  beforeEach(() => onPlatform(platform))

  it('preserves root behavior and literal backslashes in filenames', async () => {
    const oldPath = String.raw`/private/Grüße\日本語.txt`
    const newName = String.raw`renamed\日本語.txt`
    expect(parentOf('/')).toBeNull()
    expect(parentOf('/file.txt')).toBe('/')
    expect(parentOf(oldPath)).toBe('/private')
    expect(basename(oldPath)).toBe(String.raw`Grüße\日本語.txt`)
    expect(joinPath('/', newName)).toBe(`/${newName}`)
    expect(await renameItem(itemAt(oldPath, String.raw`Grüße\日本語.txt`), newName)).toBe(true)
    expect(edges.rename).toHaveBeenCalledExactlyOnceWith(oldPath, `/private/${newName}`)
  })

  it.each(['', ' ', 'old.txt', '.', '..', 'a/b', 'a\0b'])('rejects non-leaf/no-op names without IPC: %s', async name => {
    expect(await renameItem(itemAt('/private/old.txt', 'old.txt'), name)).toBe(false)
    expect(edges.rename).not.toHaveBeenCalled()
  })
})

it('keeps the existing POSIX fallback before the environment arrives', () => {
  $env.set(null)
  expect(parentOf(String.raw`/private/a\b.txt`)).toBe('/private')
  expect(basename(String.raw`/private/a\b.txt`)).toBe(String.raw`a\b.txt`)
  expect(joinPath('/private', String.raw`a\b.txt`)).toBe(String.raw`/private/a\b.txt`)
})
