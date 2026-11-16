import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

vi.hoisted(() => Object.assign(globalThis, { window: { heraldOS: { office: { onChanged() { return () => {} } } } }, document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } } }))
// Chart selection mounts Univer's native drawing UI; it is outside these display-helper assertions.
vi.mock('../features/office/sheets/charts/select.ts', () => ({ selectChart: vi.fn() }))
const { $prefs } = await import('../store/backend.ts')
const { BootScreen } = await import('./BootScreen.tsx')
const { pinnedFor } = await import('./Dock.tsx')
const { summarizeTools } = await import('../features/hermes/ToolSummaryRow.tsx')

it('renders the original Hermes header and navigation while preserving the hermes page identity', async () => {
  const { $env } = await import('../store/backend.ts')
  const { Sidebar } = await import('./Sidebar.tsx')
  const { PAGES } = await import('./apps.ts')
  const before = $env.get()
  try {
    $env.set({ ...before!, platform: 'win32' })
    $prefs.set({ ...$prefs.get(), language: 'de-DE' })
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('hermes-avatar.jpg')
    expect(html).toContain('>Hermes</div>')
    expect(html).toContain('Du kannst mehr. Jederzeit.')
    expect(html).not.toContain('dragon-mark.png')
    expect(html).not.toContain('DRAGON OS')
    expect(html).toContain('Übersicht')
    expect(html).toContain('Dateien')
    expect(html).toContain('Einstellungen')
    expect(html).toContain('>Hermes</span>')
    expect(html).not.toContain('>Chat</span>')
    expect(PAGES.filter(page => page.id === 'hermes')).toHaveLength(1)
    expect(html).not.toContain('>Overview<')
    expect(PAGES.find(p => p.id === 'files')?.name).toBe('Files')
    expect(PAGES.find(p => p.id === 'files')?.tagline).toBe('Dateien auf diesem Gerät.')
  } finally { $env.set(before) }
})

it('keeps the Files dock action identity stable in every language and platform', () => {
  for (const language of ['de-DE', 'en', 'zh-CN'] as const) {
    $prefs.set({ ...$prefs.get(), language })
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(pinnedFor(platform).filter(pin => pin.label === 'Files')).toHaveLength(1)
    }
  }
})

it('renders German startup and recovery controls without changing raw diagnostics', () => {
  $prefs.set({ ...$prefs.get(), language: 'de-DE' })
  const html = renderToStaticMarkup(createElement(BootScreen, { state: { phase: 'failed', attempt: 0, logTail: [], error: 'ECONNREFUSED diagnostic' } }))
  expect(html).toContain('Verbindung zu Hermes fehlgeschlagen')
  expect(html).toContain('Erneut versuchen')
  expect(html).toContain('Protokoll anzeigen')
  expect(html).toContain('Beenden')
  expect(html).toContain('ECONNREFUSED diagnostic')
})

it('retains English and Chinese fallback recovery controls', () => {
  for (const language of ['en', 'zh-CN'] as const) {
    $prefs.set({ ...$prefs.get(), language })
    const html = renderToStaticMarkup(createElement(BootScreen, { state: { phase: 'failed', attempt: 0, logTail: [] } }))
    expect(html).toContain('Try again')
    expect(html).toContain('Hermes could not start')
  }
})

it('renders actual tool summaries with plural counts and keeps English/Chinese fallback', () => {
  const tools = [{ id: 'a', name: 'read_file' }, { id: 'b', name: 'read_file' }, { id: 'c', name: 'write_file' }] as Parameters<typeof summarizeTools>[0]
  $prefs.set({ ...$prefs.get(), language: 'de-DE' })
  expect(summarizeTools(tools)).toBe('2 Dateien gelesen · 1 Datei geschrieben')
  for (const language of ['en', 'zh-CN'] as const) {
    $prefs.set({ ...$prefs.get(), language })
    expect(summarizeTools(tools)).toBe('Read 2 files · Wrote 1 file')
  }
  expect(tools.map(tool => tool.name)).toEqual(['read_file', 'read_file', 'write_file'])
})

it('renders the real session delete button in DE/EN/ZH without changing session data', async () => {
  const { SessionList } = await import('../features/chat/SessionList.tsx')
  const { $sessions } = await import('../store/sessions.ts')
  const before = $sessions.get()
  const row = { id: 'isolated-ui-session', title: 'Original user title', preview: '', started_at: 0, message_count: 0 }
  try {
    $sessions.set([row])
    for (const [language, label] of [['de-DE', 'Sitzung löschen'], ['en', 'Delete session'], ['zh-CN', 'Delete session']] as const) {
      $prefs.set({ ...$prefs.get(), language })
      const html = renderToStaticMarkup(createElement(SessionList))
      const button = html.match(new RegExp('<button[^>]*aria-label="' + label + '"[^>]*>'))?.[0]
      expect(button).toBeDefined()
      expect(button).toContain('reveal')
      expect(button).not.toMatch(/disabled|tabindex="-1"|aria-hidden/)
      expect(html).toContain('Original user title')
      expect($sessions.get()[0]).toEqual(row)
    }
  } finally { $sessions.set(before) }
})

it('renders memory file choices after a language change while preserving file IDs', async () => {
  const { AddMemoryForm } = await import('../features/memory/AddMemoryForm.tsx')
  const props = { onSave: vi.fn(), onCancel: vi.fn() }
  $prefs.set({ ...$prefs.get(), language: 'de-DE' })
  const german = renderToStaticMarkup(createElement(AddMemoryForm, props))
  expect(german).toContain('Hermes-Gedächtnis')
  expect(german).toContain('Über dich')
  expect(german).toContain('MEMORY.md')
  $prefs.set({ ...$prefs.get(), language: 'en' })
  const english = renderToStaticMarkup(createElement(AddMemoryForm, props))
  expect(english).toContain('Hermes memory')
  expect(english).toContain('About you')
})

it('localizes live Office display helpers without changing chart recommendations or model labels', async () => {
  const { counted } = await import('../features/office/sheets/tools/ui.tsx')
  const { shapeLabel, shapeGroupLabel, alignLabel, slotLabel } = await import('../features/office/slides/editor/pickers.tsx')
  const { chartReason, chartName } = await import('../features/office/sheets/charts/InsertDialog.tsx')
  const { SHAPE_NAMES } = await import('../features/office/slides/shapes.ts')
  const { KIND_REASONS } = await import('../features/office/sheets/charts/recommend.ts')
  $prefs.set({ ...$prefs.get(), language: 'de-DE' })
  expect(counted(1, 'cell')).toBe('1 Zelle')
  expect(counted(2, 'cell')).toBe('2 Zellen')
  expect(counted(1200, 'row label')).toBe('1.200 Zeilenbeschriftungen')
  expect(shapeLabel('triangle')).toBe('Dreieck')
  expect(alignLabel('center')).toBe('Horizontal zentrieren')
  expect(slotLabel('accent1')).toBe('Akzent 1')
  expect(chartReason(KIND_REASONS.column)).toBe('Vergleicht Werte verschiedener Kategorien')
  for (const reason of Object.values(KIND_REASONS)) expect(chartReason(reason)).not.toBe(reason)
  expect(chartName({ kind: 'column', stacking: 'stacked' })).toBe('Gestapelt: Säulen')
  expect(chartName({ kind: 'column', stacking: 'percent' })).toBe('100 %: Säulen')
  expect(shapeGroupLabel('Basic shapes')).toBe('Grundformen')
  expect(chartReason('External diagnostic unchanged')).toBe('External diagnostic unchanged')
  expect(SHAPE_NAMES.triangle).toBe('Triangle')
  expect(KIND_REASONS.column).toBe('Compares values across categories')
  for (const language of ['en', 'zh-CN'] as const) {
    $prefs.set({ ...$prefs.get(), language })
    expect(counted(2, 'cell')).toBe('2 cells')
    expect(shapeLabel('triangle')).toBe('Triangle')
    for (const reason of Object.values(KIND_REASONS)) expect(chartReason(reason)).toBe(reason)
    expect(chartName({ kind: 'column', stacking: 'stacked' })).toBe('Stacked column')
    expect(chartName({ kind: 'column', stacking: 'percent' })).toBe('100% column')
    expect(shapeGroupLabel('Basic shapes')).toBe('Basic shapes')
  }
}, 30000)

it('localizes the real microphone name and tooltip in both states without starting capture', async () => {
  const { MicButton } = await import('../features/voice/MicButton.tsx')
  const { $voice } = await import('../store/voice.ts')
  const before = $voice.get()
  try {
    for (const [language, idle, active] of [
      ['de-DE', 'Mit Hermes sprechen', 'Sprachgespräch beenden'],
      ['en', 'Talk to Hermes', 'End voice conversation'],
      ['zh-CN', 'Talk to Hermes', 'End voice conversation']
    ] as const) {
      $prefs.set({ ...$prefs.get(), language })
      for (const state of ['off', 'listening'] as const) {
        $voice.set({ ...before, state })
        const html = renderToStaticMarkup(createElement(MicButton, { disabled: true }))
        const label = state === 'off' ? idle : active
        expect(html).toContain('aria-label="' + label + '"')
        expect(html).toContain('title="' + label + '"')
        expect(html).toContain('aria-pressed="' + (state !== 'off') + '"')
        expect(html).toContain('disabled=""')
        expect($voice.get()).toEqual({ ...before, state })
      }
    }
  } finally { $voice.set(before) }
})

it('localizes painting rejection notices while preserving machine reasons, user names and document state', async () => {
  const { CanvasDocument, blankLayer, folderLayer, adjustmentLayer } = await import('../features/canvas/engine/document.ts')
  const { cannotPaint, paintTarget } = await import('../features/canvas/tools/target.ts')
  const { $notice } = await import('../features/canvas/store.ts')
  const name = 'User {name} Original.png'
  const folder = folderLayer(name, 8, 8)
  const adjustment = { ...adjustmentLayer('Levels', 8, 8), name }
  const hidden = { ...blankLayer(name, 8, 8), isVisible: false }
  const cases = [
    { layer: null, en: 'Pick a layer to paint on', de: 'Wähle eine Ebene zum Malen' },
    { layer: folder, en: name + ' is a folder: pick a layer inside it, or add a mask to paint on', de: name + ' ist ein Ordner: Wähle eine Ebene darin oder füge eine Maske zum Malen hinzu' },
    { layer: adjustment, en: name + ' is an adjustment layer: add a mask to paint on it', de: name + ' ist eine Einstellungsebene: Füge eine Maske zum Malen hinzu' },
    { layer: hidden, en: name + ' is hidden: show it to paint on it', de: name + ' ist ausgeblendet: Blende die Ebene zum Malen ein' }
  ]
  const before = $notice.get()
  try {
    for (const language of ['de-DE', 'en', 'zh-CN'] as const) {
      $prefs.set({ ...$prefs.get(), language })
      for (const entry of cases) {
        const state = { width: 8, height: 8, resolution: 72, layers: entry.layer ? [entry.layer] : [], activeLayerId: entry.layer?.id ?? null, guides: [], selection: null }
        const doc = new CanvasDocument({ name, state })
        const originalState = doc.state
        const originalHistory = doc.history.applied
        expect(cannotPaint(doc)).toBe(entry.en)
        expect(paintTarget(doc)).toBeNull()
        expect($notice.get()).toMatchObject({ message: language === 'de-DE' ? entry.de : entry.en, tone: 'error' })
        expect(doc.state).toBe(originalState)
        expect(doc.history.applied).toBe(originalHistory)
        expect(doc.name).toBe(name)
      }
    }
  } finally { $notice.set(before) }
})

it('localizes actual memory actions after language changes while preserving the API and raw errors', async () => {
  const { useMemoryToolset } = await import('../features/memory/use-memory-toolset.ts')
  const { rest } = await import('../lib/rest.ts')
  const notifications = await import('../store/notifications.ts')
  let action: ReturnType<typeof useMemoryToolset> | undefined
  function Harness() { action = useMemoryToolset(); return null }
  renderToStaticMarkup(createElement(Harness))
  const put = vi.spyOn(rest, 'put').mockResolvedValue(undefined)
  const notify = vi.spyOn(notifications, 'notify').mockImplementation(input => ({ ...input, id: 'isolated-test', ts: 0, read: false } as ReturnType<typeof notifications.notify>))
  const diagnostic = 'ECONNRESET external {name}: C:\\User\\Original.txt'
  try {
    for (const language of ['de-DE', 'en', 'zh-CN'] as const) {
      $prefs.set({ ...$prefs.get(), language })
      for (const paused of [true, false]) {
        put.mockResolvedValueOnce(undefined)
        await action!.setPaused(paused)
        expect(put).toHaveBeenLastCalledWith('/api/tools/toolsets/memory', { enabled: !paused })
        expect(notify).toHaveBeenLastCalledWith({
          title: language === 'de-DE' ? (paused ? 'Gedächtnis pausiert' : 'Gedächtnis fortgesetzt') : (paused ? 'Memory paused' : 'Memory resumed'),
          body: language === 'de-DE' ? (paused ? 'Hermes speichert nicht mehr in seinem eigenen Gedächtnis, auch nicht über die CLI, verwendet es aber weiterhin.' : 'Hermes kann wieder Erinnerungen speichern.') : (paused ? 'Hermes stops saving to its own memory, in its CLI too, but still uses it.' : 'Hermes can save memories again.'),
          level: 'success'
        })
        put.mockRejectedValueOnce(new Error(diagnostic))
        await action!.setPaused(paused)
        expect(notify).toHaveBeenLastCalledWith({
          title: language === 'de-DE' ? (paused ? 'Gedächtnis konnte nicht pausiert werden' : 'Gedächtnis konnte nicht fortgesetzt werden') : (paused ? 'Could not pause memory' : 'Could not resume memory'),
          body: diagnostic, level: 'error'
        })
      }
    }
  } finally { put.mockRestore(); notify.mockRestore() }
})

it('preserves raw save errors and filenames in localized Canvas notices', async () => {
  const { CanvasDocument } = await import('../features/canvas/engine/document.ts')
  const project = await import('../features/canvas/engine/project.ts')
  const { save, $notice } = await import('../features/canvas/store.ts')
  const name = 'User {error} Original.png'
  const file = 'C:\\private-fixture\\Original.comp'
  const diagnostic = new Error('External error {name}: C:\\original\\file.png')
  const saveProject = vi.spyOn(project, 'saveProject').mockRejectedValue(diagnostic)
  const before = $notice.get()
  const doc = new CanvasDocument({ name, state: { width: 8, height: 8, resolution: 72, layers: [], activeLayerId: null, guides: [], selection: null } })
  const originalState = doc.state
  try {
    for (const language of ['de-DE', 'en', 'zh-CN'] as const) {
      $prefs.set({ ...$prefs.get(), language })
      await expect(save(doc, { to: file })).rejects.toBe(diagnostic)
      expect(saveProject).toHaveBeenLastCalledWith(doc, file)
      expect($notice.get()).toMatchObject({
        message: language === 'de-DE' ? name + ' konnte nicht gespeichert werden: ' + diagnostic.message : 'Could not save ' + name + ': ' + diagnostic.message,
        tone: 'error'
      })
      expect(doc.name).toBe(name)
      expect(doc.state).toBe(originalState)
    }
  } finally { saveProject.mockRestore(); $notice.set(before) }
})

it.each(['linux', 'darwin'] as const)('preserves native Hermes navigation outside Windows: %s', async platform => {
  const { $env } = await import('../store/backend.ts')
  const { Sidebar } = await import('./Sidebar.tsx')
  const before = $env.get()
  try {
    $env.set({ ...before!, platform })
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('>Hermes</span>')
    expect(html).not.toContain('>Chat</span>')
  } finally { $env.set(before) }
})

it('keeps the original Hermes conversation identity in German and English on Windows', async () => {
  const { $env } = await import('../store/backend.ts')
  const { Conversation } = await import('../features/hermes/Conversation.tsx')
  const before = $env.get()
  try {
    $env.set({ ...before!, platform: 'win32' })
    for (const language of ['de-DE', 'en'] as const) {
      $prefs.set({ ...$prefs.get(), language })
      const html = renderToStaticMarkup(createElement(Conversation, { chat: null, online: false }))
      expect(html).toContain('hermes-avatar.jpg')
      expect(html).toContain('>Hermes</div>')
      expect(html).not.toContain('dragon-mark.png')
      expect(html).not.toContain('DRAGON OS')
    }
  } finally { $env.set(before) }
})

it('names Herald in the English dashboard continuity offer', async () => {
  const { PickUp } = await import('../features/overview/PickUp.tsx')
  const prefs = $prefs.get()
  try {
    $prefs.set({ ...prefs, language: 'en', continuity: { ...prefs.continuity, enabled: null } })
    const html = renderToStaticMarkup(createElement(PickUp))
    expect(html).toContain('When you open Herald OS')
    expect(html).not.toContain('DRAGON OS')
  } finally { $prefs.set(prefs) }
})
