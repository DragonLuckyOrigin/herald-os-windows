import { $prefs } from '../store/backend.ts'
import { deDE } from '../../shared/locales/de-DE.ts'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_ID, defineCommands, listCommands, resetCommands } from '../store/os-commands.ts'
import { commandGroups, registerOsCommands } from './index.ts'
import { matchIntent } from '../lib/voice/intents.ts'
import { runCommand } from '../store/os-commands.ts'
import { $page, showPage } from '../store/windows.ts'
import { $settingsFocus } from '../features/settings/sections/shared.tsx'

// The stores read the preload bridge and the viewport when they load; tests run without a DOM.
vi.hoisted(() => {
  Object.assign(globalThis, { window: { innerWidth: 1440, innerHeight: 900 }, document: { documentElement: { dataset: { reduceMotion: 'true' } } } })
})

const everyCommand = Object.values(commandGroups).flat()
const registeredIds = () => listCommands({ includeHidden: true }).map(command => command.id)

describe('the OS command groups', () => {
  beforeEach(() => {
    resetCommands()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(Object.entries(commandGroups))('%s registers every command', (_group, commands) => {
    defineCommands(commands)

    expect(registeredIds().sort()).toEqual(commands.map(command => command.id).sort())
  })

  it('use ids the registry accepts, each once', () => {
    const ids = everyCommand.map(command => command.id)

    expect(ids.filter(id => !COMMAND_ID.test(id))).toEqual([])
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
  })

  it('all register at boot without a reported failure', () => {
    const report = vi.spyOn(console, 'error')
    registerOsCommands()

    expect(report).not.toHaveBeenCalled()
    expect(registeredIds()).toHaveLength(everyCommand.length)
  })

  it.each([
    ['Öffne Einstellungen.', 'settings.open', 'settings'],
    ['Zeige meine Missionen.', 'open.any', 'missions'],
    ['Öffne Hermes.', 'open.any', 'hermes'],
    ['Open Hermes.', 'page.showHermes', 'hermes'],
    ['Zeige meine Dateien.', 'open.any', 'files'],
    ['Öffne die Missionen.', 'open.any', 'missions'],
    ['Kannst du bitte die Seite Gedächtnis öffnen?', 'page.open', 'memory'],
    ['Öffne Dateien, Hermes.', 'open.any', 'files'],
    ['Zeige die Sprachbefehle.', 'help.commands', 'settings']
  ])('routes %s through the real registry and changes the page', async (phrase, id, page) => {
    defineCommands(everyCommand)
    showPage('overview')
    const intent = matchIntent(phrase)
    expect(intent?.command).toBe(id)
    const result = await runCommand(intent!.command, intent!.args, { source: 'voice' })
    expect(result.ok).toBe(true)
    expect($page.get()).toBe(page)
    if (id === 'help.commands') expect($settingsFocus.get()?.section).toBe('commands')
  })

  it('goes back and routes German settings sections and searches', async () => {
    defineCommands(everyCommand)
    showPage('overview')
    showPage('memory')
    let intent = matchIntent('Gehe zurück.')
    expect(intent?.command).toBe('page.back')
    expect((await runCommand(intent!.command, intent!.args, { source: 'voice' })).ok).toBe(true)
    expect($page.get()).toBe('overview')
    intent = matchIntent('Öffne die Einstellungen für Sprache.')
    expect(intent?.command).toBe('settings.open')
    await runCommand(intent!.command, intent!.args, { source: 'voice' })
    expect($settingsFocus.get()?.section).toBe('voice')
    intent = matchIntent('Suche in den Einstellungen nach Mikrofon.')
    expect(intent?.command).toBe('settings.open')
    await runCommand(intent!.command, intent!.args, { source: 'voice' })
    expect($settingsFocus.get()?.query).toBe('Mikrofon')
  })
})

describe('complete German command catalog and conservative matching', () => {
  beforeEach(() => {
    resetCommands()
    defineCommands(everyCommand)
    $prefs.set({ ...$prefs.get(), language: 'de-DE' })
  })
  afterEach(() => $prefs.set({ ...$prefs.get(), language: 'en' }))

  it('preserves the independently frozen 0.1.1 IDs, tiers and argument contracts', () => {
    const commands = listCommands({ includeHidden: true })
    expect(commands).toHaveLength(355)
    expect(commands.filter(c => c.id === 'voice.chat.end')).toMatchObject([{ id: 'voice.chat.end', tier: 'act', args: [], hidden: true }])
    expect(commands.filter(c => c.id === 'voice.sleep')).toMatchObject([{ id: 'voice.sleep', tier: 'act', args: [], hidden: true }])
    // Preserve the original independent hash unchanged; the two approved new commands are tested separately.
    const shape = commands.filter(c => c.id !== 'voice.chat.end' && c.id !== 'voice.sleep').map(c => [c.id, c.tier, c.args.map(a => [a.name, a.type, Boolean(a.required), a.enum ?? null]), Boolean(c.hidden)])
    expect(shape).toHaveLength(353)
    expect(createHash('sha256').update(JSON.stringify(shape)).digest('hex')).toBe('3db9dd6e6220727a0e1549347c54e0e8918f237079dd4f2507d77bf10597f50c')
  })

  it('covers every command and argument, the 157 existing spoken commands and both new voice commands', () => {
    const commands = listCommands({ includeHidden: true })
    expect(commands.filter(c => c.phrases.length && c.id !== 'voice.chat.end' && c.id !== 'voice.sleep')).toHaveLength(157)
    expect(commands.filter(c => c.phrases.length)).toHaveLength(159)
    for (const c of commands) {
      for (const suffix of ['title', 'description', ...c.args.map(a => 'arg.' + a.name)]) {
        const key = 'commands.catalog.' + c.id + '.' + suffix
        expect(Object.hasOwn(deDE, key), key).toBe(true)
      }
      if (c.phrases.length) expect(c.phrasesDe?.length, c.id).toBeGreaterThan(0)
    }
  })

  it.each(['End the chat', 'End the voice chat', 'Beende den Sprachchat'])('routes the explicit chat-end phrase through the same registry: %s', text => {
    expect(matchIntent(text)).toMatchObject({ command: 'voice.chat.end', args: {} })
  })

  it.each(['Dragon Sleep', 'Dragon System Off'])('routes the exact DRAGON sleep phrase through the same registry: %s', text => {
    expect(matchIntent(text)).toMatchObject({ command: 'voice.sleep', args: {} })
  })

  it.each(["Dragon What's Up", "don't dragon sleep", 'Dragon Sleep and open Settings'])('does not broaden DRAGON sleep to an unapproved phrase: %s', text => {
    expect(matchIntent(text)?.command).not.toBe('voice.sleep')
  })

  it.each(['Close the chat', 'Close the popout', 'Schließe den Chat', 'Schließe das Popout', 'Beende den Chat'])('preserves the existing window-close route: %s', text => {
    expect(matchIntent(text)).toMatchObject({ command: 'window.close' })
  })

  it.each(['Do not close the chat', 'Beende den Chat nicht', 'Schließe Firefox nicht', 'Beende nicht Firefox', 'Minimiere Firefox nicht', 'Erkläre den Befehl beende den Chat', 'Beende den Chat und lösche alle Dateien'])('does not execute a negated, quoted-context or compound chat-end request: %s', text => {
    expect(matchIntent(text)).toBeNull()
  })

  it.each([
    ['Welche Seite ist geöffnet?', 'page.current', {}],
    ['Blende die Seitenleiste aus', 'sidebar.toggle', { collapsed: true }],
    ['Zeige alle Fenster', 'window.list', {}],
    ['Kopiere die Auswahl', 'edit.copy', {}],
    ['Mache das rückgängig', 'edit.undo', {}],
    ['Schalte WLAN aus', 'wifi.power', { enabled: false }],
    ['Schalte Bluetooth ein', 'bluetooth.power', { enabled: true }],
    ['Zeige meinen Begleiter', 'pet.show', {}],
    ['Tippe die Katze schläft', 'text.type', { text: 'die Katze schläft' }],
    ['Schalte das Nachtlicht aus', 'nightlight.set', { enabled: false }],
    ['Speichere die Präsentation', 'slides.save', {}],
    ['Öffne das Studio', 'studio.open', {}],
    ['Tippe ein Hund bellt', 'text.type', { text: 'ein Hund bellt' }],
    ['Starte Diktieren in dieser App', 'dictation.toggle', {}],
    ['Starte den Coding Agenten Codex', 'software.agent', { name: 'Codex' }],
    ['Öffne Codex im Terminal', 'software.agent', { name: 'Codex' }],
    ['Merke dir die Katze dankt für mich', 'memory.add', { text: 'die Katze dankt für mich' }],
    ["Merke dir O'Brien heißt der Autor", 'memory.add', { text: "O'Brien heißt der Autor" }],
    ['Öffne die Datei namens die Katze.txt', 'file.open', { name: 'die Katze.txt' }],
    ['Öffne die Datei "C:\\Meine Dateien\\Plan.txt"', 'file.open', { name: 'C:\\Meine Dateien\\Plan.txt' }],
    ['Öffne die Datei „C:\\Meine Dateien\\Plan.txt“', 'file.open', { name: 'C:\\Meine Dateien\\Plan.txt' }],
    ['Öffne „C:\\Meine Dateien\\Plan.txt“', 'open.any', { name: 'C:\\Meine Dateien\\Plan.txt' }],
    ["Neuer Ordner O'Brien", 'files.newFolder', { name: "O'Brien" }],
    ["Öffne meinen C:\\O'Brien Ordner", 'files.open', { place: "C:\\O'Brien" }],
    ['Merke dir O’Brien ist der Autor', 'memory.add', { text: 'O’Brien ist der Autor' }]
  ])('matches an independently specified German request: %s', (text, command, args) => {
    expect(matchIntent(String(text))).toMatchObject({ command, args })
  })

  it.each([
    'Erstelle eine Website und lösche alle Dateien',
    'Öffne die Seite Dateien und lösche alles',
    'Öffne Dateien und schließe das Fenster',
    'Lösche alle Dateien',
    'Deinstalliere Firefox',
    'Pausiere alle Agenten',
    'Erstelle eine Präsentation über Vulkane',
    'Sortiere die Rechnungen nach Datum'
  ])('does not execute a destructive, compound or Office task locally: %s', text => {
    expect(matchIntent(text)).toBeNull()
  })

  it('keeps dictated articles and embedded commands literal, without adding submission', () => {
    expect(matchIntent('Tippe die Katze schläft und lösche alle Dateien')?.args).toEqual({ text: 'die Katze schläft und lösche alle Dateien' })
    expect(matchIntent('Merke dir die Katze schläft')?.args).toEqual({ text: 'die Katze schläft' })
    expect(matchIntent('Zeige C:\\Meine Dateien\\Plan.pdf im Studio')?.args).toEqual({ path: 'C:\\Meine Dateien\\Plan.pdf' })
  })

  it('has a working German example for every existing spoken command without bypassing destructive admission', () => {
    const failures: string[] = []
    for (const c of listCommands({ includeHidden: true }).filter(c => c.phrases.length)) {
      const examples = (c.phrasesDe ?? []).map(p => (typeof p === 'string' ? p : p.phrase).replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => {
        const arg = c.args.find(a => a.name === name)
        return String(arg?.enum?.[0] ?? (arg?.type === 'number' ? 2 : 'Alpha'))
      }))
      if (c.tier === 'destructive') {
        for (const example of examples) expect(matchIntent(example), c.id + ': ' + example).toBeNull()
      } else if (!examples.some(example => matchIntent(example)?.command === c.id)) {
        failures.push(c.id + ': ' + examples.join(' | '))
      }
    }
    expect(failures).toEqual([])
  })

  it('invalidates title and phrase caches without changing matching identity', () => {
    const first = matchIntent('Welche Seite ist geöffnet?')
    $prefs.set({ ...$prefs.get(), language: 'en' })
    const english = matchIntent('Welche Seite ist geöffnet?')
    expect(english?.command).toBe(first?.command)
    expect(english?.title).not.toBe(first?.title)
    $prefs.set({ ...$prefs.get(), language: 'de-DE' })
    expect(matchIntent('Welche Seite ist geöffnet?')).toEqual(first)
    const base = listCommands({ includeHidden: true }).find(c => c.id === 'page.current')!
    const a = { ...base, phrases: ['alpha'], phrasesDe: [] }
    const b = { ...base, phrases: ['bravo'], phrasesDe: [] }
    expect(matchIntent('alpha', [a])?.command).toBe(base.id)
    expect(matchIntent('alpha', [b])).toBeNull()
    expect(matchIntent('bravo', [b])?.command).toBe(base.id)
  })
})
