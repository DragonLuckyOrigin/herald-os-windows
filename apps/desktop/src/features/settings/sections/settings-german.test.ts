import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const actionButtons = vi.hoisted(() => [] as Array<{ children?: unknown; disabled?: boolean; onClick?: (...args: never[]) => unknown }>)
vi.mock('../../../components/ui/glass.tsx', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../components/ui/glass.tsx')>()
  return { ...actual, GlassButton: (props: Parameters<typeof actual.GlassButton>[0]) => {
    actionButtons.push(props)
    return createElement(actual.GlassButton, props)
  } }
})

vi.hoisted(() => {
  Object.assign(globalThis, {
    window: { heraldOS: {}, navigator: { languages: ['en'] } },
    document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, body: { style: {} } }
  })
})

const { $prefs, $env, $backend } = await import('../../../store/backend.ts')
const { $wake } = await import('../../../store/wake.ts')
const { SettingsFilterContext } = await import('./shared.tsx')
const { NotificationsSection } = await import('./NotificationsSection.tsx')
const { AccessibilitySection } = await import('./AccessibilitySection.tsx')
const { AboutSection } = await import('./AboutSection.tsx')
const { AgentsSection } = await import('./AgentsSection.tsx')
const { PrivacySection } = await import('./PrivacySection.tsx')
const { AppearanceSection } = await import('./AppearanceSection.tsx')
const { NetworkSection } = await import('./NetworkSection.tsx')
const { PluginsSection } = await import('./PluginsSection.tsx')
const { SoftwareSection } = await import('./SoftwareSection.tsx')
const { StorageSection } = await import('./StorageSection.tsx')
const { UsageSection } = await import('./UsageSection.tsx')
const { VoiceSection } = await import('./VoiceSection.tsx')
const { $catalog } = await import('../../../store/catalog.ts')

beforeEach(() => $prefs.set({ ...$prefs.get(), language: 'de-DE' }))

describe('German owned settings surfaces', () => {
  it('keeps the unapproved Herald download channel disabled without opening DRAGON releases', async () => {
    const before = $env.get()
    const openExternal = vi.fn().mockResolvedValue(undefined)
    window.heraldOS.shell = { ...window.heraldOS.shell, openExternal }
    actionButtons.length = 0
    try {
      $env.set({ platform: 'win32', hermesHome: 'C:\\fixture', homeDir: 'C:\\fixture-user', version: '0.1.0', isDev: false, shellMode: 'desktop' })
      const html = renderToStaticMarkup(createElement(AboutSection))
      expect(html).toContain('keinen freigegebenen Download- oder Updatekanal')
      expect(html).toContain('Herald OS')
      expect(html).not.toContain('Deine Einstellungen bleiben erhalten')
      const action = actionButtons.find(button => button.children === 'Versionen und Downloads öffnen')
      expect(action).toBeDefined()
      expect(action?.disabled).toBe(true)
      expect(action?.onClick).toBeUndefined()
      expect(openExternal).not.toHaveBeenCalled()
      expect(html).not.toContain('herald-windows-dragon')
    } finally { $env.set(before) }
  })
  it('names Herald on Windows and separates its package updates from Hermes', () => {
    const before = $env.get()
    try {
      $env.set({ platform: 'win32', hermesHome: 'C:\\fixture', homeDir: 'C:\\fixture-user', version: '0.1.0', isDev: false, shellMode: 'desktop' })
      const html = renderToStaticMarkup(createElement(AboutSection))
      expect(html).toContain('Herald OS unter Windows aktualisieren')
      expect(html).toContain('Hermes Stable aktualisierst du separat')
      expect(html).not.toContain('Terminal öffnen')
      expect(html).toContain('>Herald OS<')
    } finally {
      $env.set(before)
    }
  })

  it.each([
    [NotificationsSection, 'Freigaben', 'Finished turns'],
    [AccessibilitySection, 'Textgröße', 'Text size'],
    [AboutSection, 'Wartung', 'Maintenance'],
    [AgentsSection, 'Persönlicher Assistent', 'Personal agent'],
    [PrivacySection, 'Berechtigungsrichtlinie', 'Permission policy'],
    [AppearanceSection, 'Hintergrundbild', 'Choose image'],
    [NetworkSection, 'Hermes-Laufzeit', 'Hermes runtime'],
    [PluginsSection, 'Noch keine Plugins', 'No plugins yet'],
    [SoftwareSection, 'Installierte Software wird geprüft', 'Checking what is installed'],
    [StorageSection, 'Laufwerke', 'Disks'],
    [UsageSection, 'Tarifgrenzen', 'Plan limits'],
    [VoiceSection, 'Mikrofonzugriff', 'Microphone access']
  ])('renders %s in German', (Component, german, english) => {
    const html = renderToStaticMarkup(createElement(Component))
    expect(html.includes(german), `Missing German text: ${german}`).toBe(true)
    expect(html.includes(english), `Remaining English text: ${english}`).toBe(false)
  })

  it('renders the loaded empty software state', () => {
    const before = $catalog.get()
    try {
      $catalog.set({ ...before, loaded: true, groups: [] })
      const html = renderToStaticMarkup(createElement(SoftwareSection))
      expect(html.includes('Erneut prüfen')).toBe(true)
      expect(html.includes('Installierte Software wird geprüft')).toBe(false)
    } finally {
      $catalog.set(before)
    }
  })

  it('translates software actions without altering supplied names or descriptions', () => {
    const before = $catalog.get()
    try {
      $catalog.set({ ...before, loaded: true, groups: [{ id: 'fixture', label: 'Original group', description: '', entries: ['link', 'npm'].map(method => ({ id: method, group: 'fixture', label: `Original ${method}`, description: 'External description', installed: false, available: true, method })) }] })
      const html = renderToStaticMarkup(createElement(SoftwareSection))
      expect(html).toContain('Herunterladen')
      expect(html).toContain('Installieren')
      expect(html).toContain('Original link')
      expect(html).toContain('External description')
    } finally { $catalog.set(before) }
  })

  it('retains the complete policy and gateway instructions in German', () => {
    const before = $backend.get()
    try {
      $backend.set({ ...before, sharedGateway: 12345 })
      const privacy = renderToStaticMarkup(createElement(PrivacySection))
      expect(privacy).toContain('allow, confirm oder deny')
      const network = renderToStaticMarkup(createElement(NetworkSection))
      expect(network).toContain('PID 12345')
      expect(network).toContain('HERALD_OS_BACKEND_URL')
      expect(network).toContain('HERALD_OS_BACKEND_TOKEN')
    } finally { $backend.set(before) }
  })

  it('keeps sentence spacing and uses a Windows plugin path without leaking the English device noun', () => {
    const env = $env.get(), wake = $wake.get()
    try {
      $env.set({ ...env!, platform: 'win32', hermesHome: 'C:\\fixture' })
      $wake.set({ ...wake, listening: true, capture: 'local' })
      const voice = renderToStaticMarkup(createElement(VoiceSection))
      expect(voice).toContain('Hört zu (Hermes hat das Mikrofon selbst geöffnet).')
      expect(voice).not.toContain('(computer)')
      const storage = renderToStaticMarkup(createElement(StorageSection))
      expect(storage).toContain('C:\\fixture · wird gemessen…')
      const plugins = renderToStaticMarkup(createElement(PluginsSection))
      expect(plugins).toContain('%USERPROFILE%\\.config\\herald-os\\plugins')
      expect(plugins).not.toContain('Linux-Beispiel')
    } finally { $env.set(env); $wake.set(wake) }
  })

  it.each([
    [NotificationsSection, 'Freigaben', 'Freigaben'],
    [AccessibilitySection, 'Bewegung reduzieren', 'Bewegung reduzieren'],
    [AgentsSection, 'Anbieter', 'Modellanbieter'],
    [AgentsSection, 'Schlüssel', 'Modellanbieter'],
    [PrivacySection, 'Datenschutz', 'Berechtigungsrichtlinie'],
    [PrivacySection, 'Berechtigung', 'Berechtigungsrichtlinie']
  ])('finds German settings labels without changing the search implementation', (Component, query, expected) => {
    const html = renderToStaticMarkup(createElement(SettingsFilterContext.Provider, { value: query }, createElement(Component)))
    expect(html.includes(expected)).toBe(true)
    expect(html.includes('data-settings-row')).toBe(true)
  })
})

