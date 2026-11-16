import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeApp } from '../../../shared/office/files.ts'
import type { OfficeDocSummary } from '../../../shared/ipc.ts'
import type { OfficeSession } from './session.ts'
import type { OfficeDocument } from './types.ts'

// Keep locate(), inOwnWindow() and findEntry() real; replace only stores and IPC boundaries.
const caller = vi.hoisted(() => ({
  home: vi.fn(), presence: vi.fn(), exists: vi.fn(), run: vi.fn(),
  sessions: new Map<string, { active: () => string | null; summaries: () => OfficeDocSummary[]; wake: (key: string) => void }>()
}))
vi.mock('../../store/backend.ts', async () => {
  const { atom } = await import('nanostores')
  const $env = atom({ homeDir: '' })
  $env.get = () => ({ homeDir: caller.home() })
  return { $env, $prefs: atom({ language: 'en' }) }
})
vi.mock('../../store/shell.ts', () => ({ isPanels: true, isMainSurface: true }))
vi.mock('../../store/windows.ts', () => ({ openApp: vi.fn() }))
vi.mock('./session.ts', () => ({ loadedSessions: caller.sessions }))

describe('local Windows paths', () => {
  it('matches Windows separators and drive letters without folding path components', () => {
    const entries = officeEntries([{ app: 'docs', at: 1, active: 'win', documents: [doc('win', 'Report.docx', String.raw`C:\Users\Sam\Report.docx`)] }])
    expect(findEntry(entries, 'docs', 'c:/Users/Sam/Report.docx', 'c:/Users/Sam/Report.docx')?.key).toBe('win')
    expect(() => findEntry(entries, 'docs', 'c:/users/sam/REPORT.docx', 'c:/users/sam/REPORT.docx')).toThrow(/case/i)
    expect(tildePath('c:/USERS/sam/Report.docx', 'C:\\Users\\Sam')).toBe('~/Report.docx')
    expect(tildePath('C:\\Users\\Samwise\\Report.docx', 'C:\\Users\\Sam')).toBe('C:\\Users\\Samwise\\Report.docx')
    expect(tildePath('C:\\Users\\Sam', 'c:/users/SAM')).toBe('~')
    expect(isPathLike('C:relative') && isPathLike('C:\\a.docx') && isPathLike('\\rooted')).toBe(true)
    expect(findEntry(officeEntries(presence), 'docs', '/USERS/sam/Documents/Report.docx', '/USERS/sam/Documents/Report.docx')).toBeNull()
  })
  const home = String.raw`C:\Users\Grüße Test`
  it('keeps native absolute paths, Unicode and drive roots', () => {
    expect(resolvePath(home + String.raw`\Documents\Bericht.docx`, home)).toBe(home + String.raw`\Documents\Bericht.docx`)
    expect(resolvePath('C:/Users/Grüße Test//Documents/./Bericht.docx/', home)).toBe(home + String.raw`\Documents\Bericht.docx`)
    expect(resolvePath('C:/', home)).toBe('C:\\')
    expect(resolvePath('~/Documents/a.docx', home)).toBe(home + String.raw`\Documents\a.docx`)
    expect(resolvePath(String.raw`~\Documents\a.docx`, home)).toBe(home + String.raw`\Documents\a.docx`)
    expect(resolvePath('~', home)).toBe(home)
  })
  it.each([
    'C:relative.docx', String.raw`\rooted.docx`, String.raw`\\server\share\a.docx`,
    '//server/share/a.docx', String.raw`\\?\C:\a.docx`, String.raw`\\.\C:\a.docx`,
    String.raw`\??\C:\a.docx`, 'C:/a.docx:stream', 'C:/NUL.docx', 'C:/folder./a.docx',
    'C:/a\u0000.docx', 'C:/a?.docx', '/rooted.docx'
  ])('rejects unsupported Windows path %s', (input) => {
    expect(() => resolvePath(input, home)).toThrow()
  })
  it('preserves POSIX names and does not expand a Windows tilde without a Windows home', () => {
    expect(resolvePath(String.raw`/tmp/a\b`, '/home/user')).toBe(String.raw`/tmp/a\b`)
    expect(resolvePath('/', '/home/user')).toBe('/')
    expect(() => resolvePath(String.raw`~\a.docx`, '/home/user')).toThrow()
    expect(() => resolvePath('~/a.docx', '')).toThrow(/home folder/)
  })
})

describe('Office caller path identity', () => {
  type Model = { text: string }
  const upper = String.raw`C:\Work\A.docx`
  const lower = String.raw`C:\Work\a.docx`
  const document = (key: string, path: string | null, name = key): OfficeDocument<Model> => ({
    key, name, path, format: '.docx', digest: null, modified: true, notes: [], layout: undefined,
    accepted: null, autosave: false, initial: { text: `unsaved ${key}` }, editor: null, revision: 0
  })
  const local = (documents: OfficeDocument<Model>[], app: OfficeApp = 'docs'): OfficeSession<Model> => {
    caller.sessions.set(app, { active: () => documents[0]?.key ?? null, summaries: () => documents, wake: vi.fn() })
    return { find: (key: string) => documents.find(doc => doc.key === key) ?? null } as OfficeSession<Model>
  }
  beforeEach(() => {
    caller.sessions.clear()
    caller.home.mockReset().mockReturnValue(String.raw`C:\Work`)
    caller.presence.mockReset().mockResolvedValue([])
    caller.exists.mockReset().mockResolvedValue('file')
    caller.run.mockReset().mockResolvedValue({ ok: true, summary: 'remote command' })
    vi.stubGlobal('window', { heraldOS: { office: { presence: caller.presence, run: caller.run }, canvas: { exists: caller.exists } } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each<OfficeApp>(['docs', 'sheets', 'slides'])('prefers the exact %s document even when its case sibling is first', async app => {
    const a = document('lower', lower)
    const A = document('upper', upper)
    const session = local([a, A], app)
    const { locate } = await import('./agent.ts')
    const found = await locate(app, session, upper)
    expect(found).toEqual({ kind: 'live', doc: A })
    if (found.kind !== 'live') throw new Error('Expected the live document')
    found.doc.initial.text += ' command'
    expect(A.initial.text).toBe('unsaved upper command')
    expect(a.initial.text).toBe('unsaved lower')
    expect(A.autosave).toBe(false)
    expect(caller.exists).not.toHaveBeenCalled()
  })

  it.each([
    [upper, lower],
    [String.raw`C:\work\A.docx`, upper],
    [String.raw`C:\Work\GRÜßE 日本語.docx`, String.raw`C:\Work\Grüße 日本語.docx`]
  ])('rejects the case-only target %s before any disk fallback or edit', async (named, opened) => {
    const live = document('live', opened)
    const session = local([live])
    const edit = vi.fn()
    const { locate } = await import('./agent.ts')
    await expect(locate('docs', session, named).then(edit)).rejects.toThrow(/case/i)
    expect(edit).not.toHaveBeenCalled()
    expect(caller.exists).not.toHaveBeenCalled()
    expect(caller.run).not.toHaveBeenCalled()
    expect(live.initial.text).toBe('unsaved live')
    expect(live.autosave).toBe(false)
  })

  it.each(['c:/Work/./A.docx', String.raw`c:\Work\A.docx`, '~/A.docx', String.raw`~\A.docx`])('keeps the live document for %s', async named => {
    const live = document('live', upper)
    const session = local([live])
    const { locate } = await import('./agent.ts')
    expect(await locate('docs', session, named)).toEqual({ kind: 'live', doc: live })
    expect(caller.exists).not.toHaveBeenCalled()
  })

  it('does not reinterpret an explicit file path as an open tab name', async () => {
    const named = String.raw`C:\Work\Closed.docx`
    const misleading = document('other', String.raw`C:\Work\Other.docx`, named)
    const session = local([misleading])
    const { locate } = await import('./agent.ts')
    expect(await locate('docs', session, named)).toEqual({ kind: 'file', path: named })
    expect(caller.exists).toHaveBeenCalledExactlyOnceWith(named)
    expect(misleading.initial.text).toBe('unsaved other')
  })

  it('retains ordinary tab-name and current-document targeting', async () => {
    const live = document('live', upper, 'Report.docx')
    const session = local([live])
    const { locate } = await import('./agent.ts')
    expect(await locate('docs', session, 'report')).toEqual({ kind: 'live', doc: live })
    expect(await locate('docs', session, undefined)).toEqual({ kind: 'live', doc: live })
    expect(caller.exists).not.toHaveBeenCalled()
  })

  it('keeps POSIX case-sensitive paths and literal backslashes distinct', async () => {
    caller.home.mockReturnValue('/home/test')
    const live = document('live', String.raw`/home/test/A\B.docx`)
    const session = local([live])
    const { locate } = await import('./agent.ts')
    expect(await locate('docs', session, String.raw`/home/test/A\B.docx`)).toEqual({ kind: 'live', doc: live })
    for (const named of [String.raw`/home/test/a\B.docx`, '/home/test/A/B.docx']) {
      expect(await locate('docs', session, named)).toEqual({ kind: 'file', path: named })
    }
    expect(caller.exists).toHaveBeenCalledTimes(2)
    expect(live.initial.text).toBe('unsaved live')
  })

  it('relays to the exact remote document rather than its earlier case sibling', async () => {
    caller.presence.mockResolvedValue([{ app: 'docs', at: 1, active: 'lower', documents: [doc('lower', 'a.docx', lower), doc('upper', 'A.docx', upper)] }])
    const here = vi.fn()
    const args = { document: upper, content: 'approved for A' }
    const { inOwnWindow } = await import('./agent.ts')
    await inOwnWindow('docs', 'docs.write', args, 'document', { source: 'agent' }, here)
    expect(caller.run).toHaveBeenCalledExactlyOnceWith({ app: 'docs', key: 'upper' }, 'docs.write', args, 'agent')
    expect(here).not.toHaveBeenCalled()
  })

  it('rejects a case-only remote reference before relay or local execution', async () => {
    caller.presence.mockResolvedValue([{ app: 'docs', at: 1, active: 'lower', documents: [doc('lower', 'a.docx', lower)] }])
    const here = vi.fn()
    const { inOwnWindow } = await import('./agent.ts')
    await expect(inOwnWindow('docs', 'docs.write', { document: upper }, 'document', { source: 'agent' }, here)).rejects.toThrow(/case/i)
    expect(caller.run).not.toHaveBeenCalled()
    expect(here).not.toHaveBeenCalled()
    expect(caller.exists).not.toHaveBeenCalled()
  })

  it('does not relay an explicit path to a remote tab merely bearing that name', async () => {
    caller.presence.mockResolvedValue([{ app: 'docs', at: 1, active: 'other', documents: [doc('other', upper, String.raw`C:\Work\Other.docx`)] }])
    const here = vi.fn().mockResolvedValue({ summary: 'local file branch' })
    const { inOwnWindow } = await import('./agent.ts')
    expect(await inOwnWindow('docs', 'docs.write', { document: upper }, 'document', { source: 'agent' }, here)).toMatchObject({ ok: true, summary: 'local file branch' })
    expect(here).toHaveBeenCalledTimes(1)
    expect(caller.run).not.toHaveBeenCalled()
  })
})
import type { OfficePresence } from '../../../shared/ipc.ts'
import { describeOffice, documentFileName, findEntry, freePath, isPathLike, officeEntries, parseJsonArg, resolvePath, stepCount, summaryOf, tildePath } from './agent-model.ts'

const doc = (key: string, name: string, path: string | null, extra: Partial<OfficePresence['documents'][number]> = {}) => ({ key, name, path, format: '.docx', modified: false, ...extra })

const presence: OfficePresence[] = [
  { app: 'sheets', at: 200, active: 'sheets-1', documents: [{ ...doc('sheets-1', 'Budget.xlsx', '/Users/sam/Budget.xlsx'), format: '.xlsx', detail: 'Sheet1!B2', selection: 'Sheet1!B2:D9' }] },
  { app: 'docs', at: 100, active: 'docs-2', documents: [doc('docs-1', 'Notes.md', '/Users/sam/Notes.md'), doc('docs-2', 'Report.docx', '/Users/sam/Documents/Report.docx', { modified: true })] }
]

describe('the open Office documents', () => {
  it('lists every window’s documents, the window used last first, and marks the one in front', () => {
    const entries = officeEntries(presence)

    expect(entries.map((entry) => entry.name)).toEqual(['Budget.xlsx', 'Notes.md', 'Report.docx'])
    expect(entries.filter((entry) => entry.front).map((entry) => entry.name)).toEqual(['Budget.xlsx'])
    expect(entries.find((entry) => entry.name === 'Report.docx')).toMatchObject({ app: 'docs', active: true, modified: true })
  })

  it('reads this window’s own documents live, in its window’s place', () => {
    const local = [{ app: 'docs' as const, active: 'docs-1', documents: [doc('docs-1', 'Notes.md', '/Users/sam/Notes.md', { selection: 'the quick brown fox' }), doc('docs-2', 'Report.docx', '/Users/sam/Documents/Report.docx')] }]
    const entries = officeEntries(presence, local)

    expect(entries.map((entry) => entry.name)).toEqual(['Budget.xlsx', 'Notes.md', 'Report.docx'])
    expect(entries.find((entry) => entry.name === 'Notes.md')).toMatchObject({ active: true, selection: 'the quick brown fox' })
  })

  it('puts a window that has not reported yet in front', () => {
    const local = [{ app: 'docs' as const, active: 'docs-9', documents: [doc('docs-9', 'Untitled', null)] }]

    expect(officeEntries(presence, local)[0]).toMatchObject({ name: 'Untitled', front: true })
  })

  it('finds a document by its path or its name, with or without the extension', () => {
    const entries = officeEntries(presence)

    expect(findEntry(entries, 'docs', '~/Documents/Report.docx', '/Users/sam/Documents/Report.docx')?.key).toBe('docs-2')
    expect(findEntry(entries, 'docs', 'report')?.key).toBe('docs-2')
    expect(findEntry(entries, 'docs', 'notes.md')?.key).toBe('docs-1')
    expect(findEntry(entries, 'sheets', 'report')).toBeNull()
    expect(isPathLike('~/a.docx') && isPathLike('/tmp/a.docx') && !isPathLike('Untitled 2')).toBe(true)
  })

  it('tells Hermes what is in front, what is selected, and what else is open', () => {
    expect(describeOffice(officeEntries(presence), '/Users/sam')).toBe('Office: in front is Budget.xlsx in Herald Sheets (~/Budget.xlsx), selection Sheet1!B2:D9; also open: Notes.md (Herald Docs), Report.docx (Herald Docs).')
    expect(describeOffice([])).toBeNull()

    const docsFirst = officeEntries([{ ...presence[1], at: 300, documents: [doc('docs-2', 'Report.docx', null, { selection: 'Q3 revenue grew' })] }])

    expect(describeOffice(docsFirst)).toBe('Office: in front is Report.docx in Herald Docs (not saved yet), selected text “Q3 revenue grew”.')
  })

  it('names new files without taking one that exists', async () => {
    expect(documentFileName('Trip: budget', '.xlsx')).toBe('Trip- budget.xlsx')
    expect(documentFileName('Letter.docx', '.docx')).toBe('Letter.docx')
    const taken = new Set(['/d/Report.pdf', '/d/Report 2.pdf'])

    expect(await freePath('/d', 'Report.pdf', async (file) => taken.has(file))).toBe('/d/Report 3.pdf')
    expect(tildePath('/Users/sam/Documents/a.pdf', '/Users/sam')).toBe('~/Documents/a.pdf')
  })

  it('reads the paths people type as full paths', () => {
    expect(resolvePath(' ~/Documents/a.docx ', '/Users/sam')).toBe('/Users/sam/Documents/a.docx')
    expect(resolvePath('~', '/Users/sam')).toBe('/Users/sam')
    expect(resolvePath('/tmp//notes/./b.xlsx', '/Users/sam')).toBe('/tmp/notes/b.xlsx')
    expect(resolvePath('/tmp/folder/', '/Users/sam')).toBe('/tmp/folder')
    expect(resolvePath('/', '/Users/sam')).toBe('/')
    expect(() => resolvePath('Documents/a.docx', '/Users/sam')).toThrow(/full path/)
    expect(() => resolvePath('~/a.docx', '')).toThrow(/home folder/)
  })

  it('reads steps and JSON arguments', () => {
    expect(stepCount(undefined)).toBe(1)
    expect(stepCount('3')).toBe(3)
    expect(() => stepCount(0)).toThrow(/steps/)
    expect(parseJsonArg('[["a", 1]]', 'values')).toEqual([['a', 1]])
    expect(parseJsonArg('plain', 'values')).toBe('plain')
    expect(() => parseJsonArg('{bad', 'format')).toThrow(/format is not valid JSON/)
    expect(summaryOf({ key: 'k', path: null, name: 'A', format: '.md', modified: false }, undefined, 'x')).toEqual({ key: 'k', path: null, name: 'A', format: '.md', modified: false, selection: 'x' })
  })
})
