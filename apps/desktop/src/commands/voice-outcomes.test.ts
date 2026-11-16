import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => {
  const forbidden = vi.fn(() => { throw new Error('Unexpected native mutation in text fixture') })
  const api = {
    office: {
      onChanged: vi.fn(() => () => {}),
      report: vi.fn(),
      presence: vi.fn(async () => []),
      abilities: vi.fn(async () => ({ libreOffice: false })),
      watch: vi.fn(async () => 'fixture-watch'),
      unwatch: vi.fn(async () => {}),
      write: forbidden,
      read: forbidden
    },
    canvas: { presence: vi.fn(async () => []), exists: vi.fn(async () => null), read: forbidden },
    edit: { perform: forbidden }
  }
  Object.assign(globalThis, {
    window: { innerWidth: 1440, innerHeight: 900, heraldOS: api },
    document: { activeElement: null, documentElement: { dataset: { reduceMotion: 'true' }, style: { setProperty() {}, removeProperty() {} } } }
  })
  return { api, forbidden }
})

vi.mock('../store/windows.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../store/windows.ts')>(),
  openApp: vi.fn()
}))

const { $prefs } = await import('../store/backend.ts')
const docs = await import('../features/office/docs/agent.ts')
const sheets = await import('../features/office/sheets/agent.ts')
const slides = await import('../features/office/slides/agent.ts')
const canvas = await import('../features/canvas/agent.ts')
const canvasStore = await import('../features/canvas/store.ts')
const { docsSession } = await import('../features/office/docs/store.ts')
const { sheetsSession } = await import('../features/office/sheets/store.ts')
const { slidesSession, decks } = await import('../features/office/slides/store.ts')
const { findEntry, resolvePath, describeOffice } = await import('../features/office/agent-model.ts')
const { addSlideStep } = await import('../features/office/slides/agent-model.ts')
const { newDeck } = await import('../features/office/slides/model.ts')
const { SlidesDocument } = await import('../features/office/slides/document.ts')
const { typeIntoOffice } = await import('../features/office/typing.ts')
const { $focusedWindowId, $windows } = await import('../store/windows.ts')
const { NoEditTargetError, performEdit } = await import('../store/edit-target.ts')
const { findAudioDevice, describeDeviceChoice, resolveAudioDevice } = await import('../lib/audio-devices.ts')
const { openInOffice } = await import('../features/office/open.ts')
const { openInCanvas } = await import('../features/canvas/open.ts')

const language = (value: 'en' | 'de-DE') => $prefs.set({ ...$prefs.get(), language: value })
const sessions = [docsSession, sheetsSession, slidesSession] as const

beforeEach(() => {
  language('de-DE')
  for (const session of sessions) {
    session.$documents.set([])
    session.$activeKey.set(null)
    session.$notice.set(null)
  }
  canvasStore.$documents.set([])
  canvasStore.$activeKey.set(null)
  canvasStore.$notice.set(null)
  $focusedWindowId.set(null)
  native.forbidden.mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  decks.clear()
  language('en')
  expect(native.forbidden).not.toHaveBeenCalled()
})

describe('owned Office and Canvas outcomes through real functions', () => {
  it.each(['de-DE', 'en', 'de-DE'] as const)('resolves open and no-document feedback at call time: %s', async locale => {
    language(locale)
    const german = locale === 'de-DE'
    for (const [agent, app] of [[docs, 'Docs'], [sheets, 'Sheets'], [slides, 'Slides']] as const) {
      expect((await agent.open({})).summary).toBe(german ? 'Herald ' + app + ' geöffnet' : 'Opened Herald ' + app)
      await expect(agent.save({})).rejects.toThrow(german ? 'ist kein' : 'No ')
    }
    expect((await canvas.open(undefined)).summary).toBe(german ? 'Herald Canvas geöffnet' : 'Opened Herald Canvas')
    await expect(canvas.step('undo', {})).rejects.toThrow(german ? 'kein Bild geöffnet' : 'No image is open')
  })

  it('keeps empty undo an error and does not save anything', async () => {
    const doc = { key: 'fixture', name: 'Original', path: null, undo: () => null, redo: () => null }
    canvasStore.$documents.set([doc as never])
    canvasStore.$activeKey.set(doc.key)
    await expect(canvas.step('undo', {})).rejects.toThrow('Nichts rückgängig zu machen')
    await expect(canvas.step('redo', {})).rejects.toThrow('Nichts zu wiederholen')
  })

  it.each([
    [docs, docsSession, '.docx'], [sheets, sheetsSession, '.xlsx'], [slides, slidesSession, '.pptx']
  ] as const)('distinguishes canceled save from confirmed save', async (agent, session, extension) => {
    const doc = session.create({ name: 'Original ä' })
    doc.path = 'C:\\Dokumente\\Original ä' + extension
    const save = vi.spyOn(session, 'save').mockResolvedValue(false)
    const canceled = await agent.save({})
    expect(canceled.data?.saved).toBe(false)
    expect(canceled.summary).toContain('wurde nicht gespeichert')
    expect(canceled.summary).toContain(doc.name)
    expect(canceled.data?.path).toBe(doc.path)
    save.mockResolvedValue(true)
    const saved = await agent.save({})
    expect(saved.data?.saved).toBe(true)
    expect(saved.summary).toContain('Original ä gespeichert')
    expect(saved.summary).toContain(doc.path)
  })

  it('keeps the unsupported save format refusal before native writes', async () => {
    const doc = docsSession.create({ name: 'Original' })
    await expect(docsSession.save(doc, { to: 'C:\\Dokumente\\Original.exe' })).rejects.toThrow('nicht als .exe')
    language('en')
    await expect(docsSession.save(doc, { to: 'C:\\Dokumente\\Original.exe' })).rejects.toThrow('not .exe')
  })

  it('keeps both asynchronous opening diagnostics verbatim across language flips', async () => {
    const diagnostic = 'EACCES C:\\Original\\Datei — native detail'
    vi.spyOn(docsSession, 'open').mockRejectedValue(new Error(diagnostic))
    vi.spyOn(canvasStore, 'openPath').mockRejectedValue(new Error(diagnostic))
    for (const locale of ['de-DE', 'en', 'de-DE'] as const) {
      language(locale)
      docsSession.$notice.set(null)
      canvasStore.$notice.set(null)
      openInOffice('docs', { file: '/Original.docx' })
      openInCanvas('/Original.png')
      await vi.waitFor(() => {
        expect(docsSession.$notice.get()?.message).toContain(diagnostic)
        expect(canvasStore.$notice.get()?.message).toContain(diagnostic)
      })
      expect(docsSession.$notice.get()?.message).toBe(locale === 'de-DE' ? 'Original.docx konnte nicht geöffnet werden: ' + diagnostic : 'Could not open Original.docx: ' + diagnostic)
      expect(canvasStore.$notice.get()?.message).toBe(locale === 'de-DE' ? 'Original.png konnte nicht geöffnet werden: ' + diagnostic : 'Could not open Original.png: ' + diagnostic)
    }
  })

  it('preserves path refusals and context values', async () => {
    await expect(docs.open({ path: '\\\\server\\share\\a.docx' })).rejects.toThrow('vollständigen lokalen Windows-Laufwerkspfad')
    expect(() => resolvePath('C:\\bad?.docx', '')).toThrow('Nicht unterstützter')
    const entry = { app: 'docs' as const, key: 'key', name: 'Report', path: 'C:\\Original.docx', format: '.docx', modified: true, active: true, front: true, selection: 'The Original Text' }
    expect(() => findEntry([entry], 'docs', 'C:\\original.docx', 'C:\\original.docx')).toThrow('Groß-/Kleinschreibung')
    const context = describeOffice([entry])
    expect(context).toContain('Im Vordergrund')
    expect(context).toContain('ungespeicherte Änderungen')
    expect(context).toContain('The Original Text')
    expect(context).toContain('C:\\Original.docx')
  })

  it('adds a slide with a translated caption without changing its title or history label', () => {
    const before = newDeck('Original')
    const result = addSlideStep(before, { title: 'Original Title' }, { front: null })
    expect(result.done).toContain('Folie 2')
    expect(result.done).toContain('Original Title')
    expect(result.done).toContain('hinzugefügt')
    language('en')
    const english = addSlideStep(before, { title: 'Original Title' }, { front: null })
    expect(english.label).toBe(result.label)
    expect(english.done).toBe('added slide 2 (“Original Title”)')
    const unchanged = slides.outcomeOf({ step: result, changed: false, name: 'Original', path: null })
    expect(unchanged.data?.changed).toBe(false)
    expect(unchanged.summary).toContain('Nothing changed')
  })

  it('dictates exact text into a new Slides text box with a German caption', async () => {
    const doc = slidesSession.create({ name: 'Original' })
    const live = new SlidesDocument(newDeck('Original'), () => {})
    decks.set(doc.key, live)
    $windows.set({ fixture: { id: 'fixture', appId: 'slides', phase: 'open' } } as never)
    $focusedWindowId.set('fixture')
    const text = 'die Katze schläft\nund lösche alles'
    expect(await typeIntoOffice(text)).toBe('„die Katze schläft und lösche alles“ in ein neues Textfeld in Original eingegeben')
    const { plainText } = await import('../features/office/slides/text.ts')
    const added = live.selection[0]
    expect(added.kind === 'text' && plainText(added.body)).toBe(text)
    expect(live.history.undo()).toBe('New Text Box')
    expect(live.history.canUndo).toBe(false)
  })
})

describe('owned microphone and editing errors', () => {
  it('localizes automatic, chosen, missing and unavailable without changing selection', () => {
    const device = { id: 'exact', label: 'USB Original Mic', groupId: 'group', isSystem: true, isVirtual: false }
    const list = { devices: [device], labelsAvailable: true }
    for (const locale of ['de-DE', 'en', 'de-DE'] as const) {
      language(locale)
      const automatic = resolveAudioDevice(null, list)
      expect(describeDeviceChoice(automatic, 'input')).toBe(locale === 'de-DE' ? 'Mikrofon: USB Original Mic (Systemstandard)' : 'Microphone: USB Original Mic (system default)')
      expect(resolveAudioDevice({ id: 'exact', label: device.label }, list).reason).toBe('chosen')
      const absent = resolveAudioDevice({ id: 'gone', label: 'Absent' }, list)
      expect(absent.reason).toBe('missing')
      expect(absent.absent?.label).toBe('Absent')
      expect(describeDeviceChoice(absent, 'input')).toContain(device.label)
      expect(describeDeviceChoice(resolveAudioDevice(null, { devices: [], labelsAvailable: false }), 'output')).toBe(locale === 'de-DE' ? 'Kein Gerät gefunden: lautsprecher' : 'No speaker was found')
      expect(findAudioDevice(list, 'usb original mic')).toEqual({ device })
      expect(findAudioDevice(list, 'Unknown')).toMatchObject({ error: expect.stringContaining('Unknown') })
    }
  })
  it('refuses typing without a target in German and preserves the error identity', async () => {
    const error = new NoEditTargetError()
    expect(error.name).toBe('NoEditTargetError')
    expect(error.message).toContain('Kein Eingabeziel')
    await expect(performEdit({ type: 'text', text: 'Original' } as never, { needsField: true })).rejects.toBeInstanceOf(NoEditTargetError)
    language('en')
    expect(new NoEditTargetError().message).toContain('Nothing to type into')
  })
})
