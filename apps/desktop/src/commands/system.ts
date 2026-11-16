import { LANGUAGES, type LanguageSetting } from '../../shared/i18n.ts'
import type { HeraldOSPrefs, VoiceEngine } from '../../shared/ipc.ts'
import { isPrivacyPane, PRIVACY_PANE_NAMES } from '../../shared/privacy-panes.ts'
import { WINDOWS_CALENDAR_URL, WINDOWS_SETTINGS } from '../../shared/windows-links.ts'
import { hostPlatform } from '../lib/platform-labels.ts'
import { canOpenPrivacyPanes, openPrivacyPane } from '../lib/privacy-pane.ts'
import { $prefs, updatePrefs } from '../store/backend.ts'
import { $language, setLanguage, t } from '../store/i18n.ts'
import { $nativeApps, loadNativeApps } from '../store/native-apps.ts'
import { delegate, fail, ok, type OsCommand } from '../store/os-commands.ts'
import { looksLikeFileNotUrl } from './files.ts'
import { endConversation, endVoiceChat, interruptSpeech, startVoice, toggleMute } from '../store/voice.ts'
import { $wake, setWakeWordEnabled } from '../store/wake.ts'
import { openWebWindow } from '../store/web-windows.ts'
import { showPage } from '../store/windows.ts'
import { FEATURED_NATIVE } from '../shell/apps.ts'
import { focusSettings, SETTINGS_SECTION_IDS } from '../features/settings/sections/shared.tsx'

/* Native apps, web pages, settings and the voice layer itself. */

const SECTION_ALIASES: Record<string, string> = {
  allgemein: 'general',
  erscheinungsbild: 'appearance',
  aussehen: 'appearance',
  sprache: 'voice',
  sprachsteuerung: 'voice',
  mikrofon: 'voice',
  datenschutz: 'privacy',
  benachrichtigungen: 'notifications',
  netzwerk: 'network',
  speicher: 'storage',
  barrierefreiheit: 'accessibility',
  über: 'about',
  nutzung: 'usage',
  sprachbefehle: 'commands',
  agents: 'agents',
  agent: 'agents',
  hermes: 'agents',
  model: 'agents',
  provider: 'agents',
  account: 'agents',
  language: 'general',
  look: 'appearance',
  theme: 'appearance',
  wallpaper: 'appearance',
  colors: 'appearance',
  colours: 'appearance',
  speech: 'voice',
  microphone: 'voice',
  sound: 'voice',
  wifi: 'network',
  'wi-fi': 'network',
  internet: 'network',
  disk: 'storage',
  space: 'storage',
  security: 'privacy',
  permissions: 'privacy',
  alerts: 'notifications',
  motion: 'accessibility',
  version: 'about',
  update: 'about',
  billing: 'usage',
  tokens: 'usage',
  credits: 'usage',
  limits: 'usage',
  plan: 'usage'
}

function resolveSection(input: string | undefined): string | null {
  if (!input) {
    return null
  }

  const key = input.toLowerCase().replace(/\s+settings?$/, '').trim()

  return SETTINGS_SECTION_IDS.find(id => id === key) ?? SECTION_ALIASES[key] ?? null
}

async function nativeApps() {
  loadNativeApps()

  if ($nativeApps.get().length === 0) {
    // First call: the list is still loading; wait for it briefly.
    await new Promise<void>(resolve => {
      const off = $nativeApps.subscribe(apps => {
        if (apps.length > 0) {
          off()
          resolve()
        }
      })
      setTimeout(() => {
        off()
        resolve()
      }, 3000)
    })
  }

  return $nativeApps.get()
}

export const systemCommands: readonly OsCommand[] = [
  {
    id: 'settings.openWindows',
    title: 'Open Windows Settings',
    description: 'Open native Windows settings for network, Bluetooth, sound, display or power.',
    tier: 'read',
    hidden: true,
    args: [{ name: 'panel', type: 'string', description: 'The quick panel', required: true, enum: Object.keys(WINDOWS_SETTINGS) }],
    run: async ({ panel }) => {
      if (hostPlatform() !== 'win32') return fail(t('commands.msg.system.windowsOnly'))
      if (typeof panel !== 'string' || !Object.hasOwn(WINDOWS_SETTINGS, panel)) return fail(t('commands.msg.system.unknownWindowsPage'))
      await window.heraldOS.shell.openExternal(WINDOWS_SETTINGS[panel as keyof typeof WINDOWS_SETTINGS])
      return ok(t('commands.msg.system.windowsSettingsOpened'))
    }
  },
  {
    id: 'calendar.openNative',
    title: 'Open Outlook Calendar',
    description: 'Open the installed Outlook calendar on Windows. Accounts and events stay in Outlook.',
    tier: 'read',
    hidden: true,
    args: [],
    run: async () => {
      if (hostPlatform() !== 'win32') return fail(t('commands.msg.system.calendarWindowsOnly'))
      await window.heraldOS.shell.openExternal(WINDOWS_CALENDAR_URL)
      return ok(t('commands.msg.system.calendarOpened'))
    }
  },
  {
    id: 'native.launch',
    title: 'Launch an app',
    description: 'Launch an installed application by name (Safari, Mail, Notes, …).',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Application name', required: true }],
    phrases: ['open the app {name}', 'launch the app {name}', 'start the app {name}'],
    phrasesDe: ['öffne die app {name}', 'starte die app {name}', 'starte das programm {name}', 'öffne das programm {name}'],
    run: async ({ name }) => {
      const apps = await nativeApps()
      const key = String(name).toLowerCase().trim()
      const alias = FEATURED_NATIVE.find(a => a.label.toLowerCase() === key)
      const candidates = alias ? alias.names.map(n => n.toLowerCase()) : [key]
      const app = apps.find(a => candidates.includes(a.name.toLowerCase())) ?? apps.find(a => a.name.toLowerCase().startsWith(key)) ?? apps.find(a => a.name.toLowerCase().includes(key))

      if (!app) {
        return fail(t('commands.msg.system.noApp', { name: String(name) }))
      }

      await window.heraldOS.apps.launch(app.path)

      return ok(t('commands.msg.system.launched', { name: app.name }), { spoken: t('commands.msg.system.launching', { name: app.name }), data: { path: app.path } })
    }
  },
  {
    id: 'web.open',
    title: 'Open a web page',
    description: 'Open a URL in a window inside Herald OS.',
    tier: 'act',
    args: [
      { name: 'url', type: 'string', description: 'URL or domain (https is assumed)', required: true },
      { name: 'title', type: 'string', description: 'Window title' }
    ],
    phrases: ['open the website {url}', 'go to {url}', 'open {url} in a window', 'browse to {url}'],
    phrasesDe: ['öffne die webseite {url}', 'öffne die website {url}', 'öffne {url} in einem fenster', 'surfe zu {url}'],
    run: async ({ url, title }, context) => {
      let target = String(url).trim()

      // "www.hello.pdf" is a mis-heard file name, not a site.
      if (looksLikeFileNotUrl(target)) {
        return delegate('file.open', { name: target }, context)
      }

      if (!/^https?:\/\//i.test(target)) {
        if (!/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(target)) {
          return fail(t('commands.msg.system.notWebAddress', { url: target }))
        }

        target = `https://${target}`
      }

      const id = await openWebWindow(target, { title: title ? String(title) : undefined })

      return ok(t('commands.msg.system.webOpened', { url: target }), { spoken: t('commands.msg.system.webOpening'), highlight: { kind: 'window', id: String(id) }, data: { url: target } })
    }
  },
  {
    id: 'settings.open',
    title: 'Open Settings',
    description: 'Open Settings, optionally at a section (general, appearance, pet, agents, usage, voice, privacy, notifications, network, storage, accessibility, about).',
    tier: 'read',
    args: [
      { name: 'section', type: 'string', description: 'Section name' },
      { name: 'query', type: 'string', description: 'Search inside Settings' }
    ],
    phrases: ['open settings', 'open {section} settings', 'show {section} settings', 'go to {section} settings', 'search settings for {query}'],
    phrasesDe: ['öffne Einstellungen', 'öffne die Einstellungen', 'zeige die einstellungen', 'gehe zu den einstellungen', 'öffne die Einstellungen für {section}', 'zeige die Einstellungen für {section}', 'öffne die {section} einstellungen', 'suche in den Einstellungen nach {query}', 'durchsuche die einstellungen nach {query}'],
    run: ({ section, query }) => {
      const id = resolveSection(section ? String(section) : undefined)

      if (section && !id) {
        return fail(t('commands.settings.unknown', { name: String(section) }))
      }

      showPage('settings')
      focusSettings({ section: id ?? undefined, query: query ? String(query) : undefined })

      return ok(t('commands.settings.opened'), { page: 'settings', highlight: id ? { kind: 'setting', id } : undefined })
    }
  },
  {
    id: 'privacy.openPane',
    title: 'Open a Privacy & Security pane',
    description: 'Open the list in macOS System Settings > Privacy & Security where Herald OS is allowed a permission (microphone, camera, calendars, screen, accessibility, automation).',
    tier: 'read',
    hidden: true,
    args: [{ name: 'pane', type: 'string', description: 'The permission', required: true, enum: PRIVACY_PANE_NAMES }],
    run: async ({ pane }) => {
      if (!canOpenPrivacyPanes()) {
        return fail(t('commands.msg.system.macOnly'))
      }

      if (!isPrivacyPane(pane)) {
        return fail(t('commands.msg.system.noPane', { pane: String(pane), panes: PRIVACY_PANE_NAMES.join(', ') }))
      }

      await openPrivacyPane(pane)

      return ok(t('commands.msg.system.paneOpened', { pane }))
    }
  },
  {
    id: 'language.set',
    title: 'Set the language',
    description: 'Show Herald OS in English, German (Deutsch) or Simplified Chinese (简体中文), or follow the system languages again (the default).',
    tier: 'mutate',
    args: [{ name: 'language', type: 'string', description: 'system, en (English), de-DE (German) or zh-CN (Simplified Chinese)', required: true, enum: ['system', 'en', 'zh-CN', 'de-DE'] }],
    phrases: [
      { phrase: 'switch to english', args: { language: 'en' } },
      { phrase: 'use english', args: { language: 'en' } },
      { phrase: 'set the language to english', args: { language: 'en' } },
      { phrase: 'switch to chinese', args: { language: 'zh-CN' } },
      { phrase: 'use chinese', args: { language: 'zh-CN' } },
      { phrase: 'set the language to chinese', args: { language: 'zh-CN' } },
      { phrase: 'use the system language', args: { language: 'system' } },
      { phrase: 'follow the system language', args: { language: 'system' } }
    ],
    phrasesDe: [
      { phrase: 'wechsle zu englisch', args: { language: 'en' } },
      { phrase: 'verwende englisch', args: { language: 'en' } },
      { phrase: 'stelle die sprache auf englisch', args: { language: 'en' } },
      { phrase: 'wechsle zu deutsch', args: { language: 'de-DE' } },
      { phrase: 'verwende deutsch', args: { language: 'de-DE' } },
      { phrase: 'stelle die sprache auf deutsch', args: { language: 'de-DE' } },
      { phrase: 'wechsle zu chinesisch', args: { language: 'zh-CN' } },
      { phrase: 'verwende chinesisch', args: { language: 'zh-CN' } },
      { phrase: 'stelle die sprache auf chinesisch', args: { language: 'zh-CN' } },
      { phrase: 'verwende die systemsprache', args: { language: 'system' } },
      { phrase: 'folge der systemsprache', args: { language: 'system' } }
    ],
    run: async ({ language }) => {
      const setting = language as LanguageSetting
      await setLanguage(setting)
      const shown = LANGUAGES.find(entry => entry.id === $language.get())?.name ?? ''

      return ok(setting === 'system' ? t('commands.msg.system.languageSystem', { language: shown }) : t('commands.msg.system.languageSet', { language: shown }), { highlight: { kind: 'setting', id: 'general' } })
    }
  },
  {
    id: 'accent.set',
    title: 'Set the accent colour',
    description: 'Switch the accent colour (blue, ice or violet).',
    tier: 'mutate',
    args: [{ name: 'accent', type: 'string', description: 'Accent name', required: true, enum: ['blue', 'ice', 'violet'], aliases: { blau: 'blue', eis: 'ice', eisblau: 'ice', violett: 'violet', lila: 'violet' } }],
    phrases: ['set the accent to {accent}', 'make the accent {accent}', 'change the accent color to {accent}'],
    phrasesDe: ['setze den akzent auf {accent}', 'mach den akzent {accent}', 'ändere die akzentfarbe auf {accent}', 'ändere die akzentfarbe zu {accent}'],
    run: async ({ accent }) => {
      // An accent belongs to the Ocean and Graphite presets; a theme with its own colours steps aside.
      const preset = $prefs.get().theme
      await updatePrefs({ accent: accent as HeraldOSPrefs['accent'], themeColors: undefined, themeScheme: undefined, themeName: `herald-${preset}` })

      return ok(t('commands.msg.system.accentSet', { accent: String(accent) }), { highlight: { kind: 'setting', id: 'appearance' } })
    }
  },
  {
    id: 'motion.reduce',
    title: 'Reduce motion',
    description: 'Turn reduced motion on or off.',
    tier: 'mutate',
    args: [{ name: 'enabled', type: 'boolean', description: 'true to reduce motion', required: true }],
    phrases: [
      { phrase: 'turn on reduce motion', args: { enabled: true } },
      { phrase: 'reduce motion', args: { enabled: true } },
      { phrase: 'turn off reduce motion', args: { enabled: false } },
      { phrase: 'enable animations', args: { enabled: false } }
    ],
    phrasesDe: [
      { phrase: 'reduziere die bewegung', args: { enabled: true } },
      { phrase: 'schalte reduzierte bewegung ein', args: { enabled: true } },
      { phrase: 'aktiviere reduzierte bewegung', args: { enabled: true } },
      { phrase: 'schalte reduzierte bewegung aus', args: { enabled: false } },
      { phrase: 'aktiviere animationen', args: { enabled: false } },
      { phrase: 'schalte animationen ein', args: { enabled: false } }
    ],
    run: async ({ enabled }) => {
      await updatePrefs({ reduceMotion: Boolean(enabled) })

      return ok(enabled ? t('commands.msg.system.motionOn') : t('commands.msg.system.motionOff'), { highlight: { kind: 'setting', id: 'accessibility' } })
    }
  },
  {
    id: 'dock.autoHide',
    title: 'Dock auto-hide',
    description: 'Hide the Dock until the cursor reaches the bottom edge, or keep it visible.',
    tier: 'mutate',
    args: [{ name: 'enabled', type: 'boolean', description: 'true to auto-hide', required: true }],
    phrases: [
      { phrase: 'hide the dock', args: { enabled: true } },
      { phrase: 'auto hide the dock', args: { enabled: true } },
      { phrase: 'show the dock', args: { enabled: false } },
      { phrase: 'keep the dock visible', args: { enabled: false } }
    ],
    phrasesDe: [
      { phrase: 'verstecke das dock', args: { enabled: true } },
      { phrase: 'blende das dock automatisch aus', args: { enabled: true } },
      { phrase: 'zeige das dock', args: { enabled: false } },
      { phrase: 'lass das dock sichtbar', args: { enabled: false } }
    ],
    run: async ({ enabled }) => {
      await updatePrefs({ dockAutoHide: Boolean(enabled) })

      return ok(enabled ? t('commands.msg.system.dockOn') : t('commands.msg.system.dockOff'))
    }
  },
  {
    id: 'voice.engine.set',
    title: 'Voice engine',
    description: 'Choose the voice engine: chained (free) or live (GPT-Live, paid).',
    tier: 'mutate',
    args: [{ name: 'engine', type: 'string', description: 'chained or live', required: true, enum: ['chained', 'live'] }],
    phrases: [
      { phrase: 'use the free voice engine', args: { engine: 'chained' } },
      { phrase: 'switch to the free voice engine', args: { engine: 'chained' } },
      { phrase: 'switch to the live voice engine', args: { engine: 'live' } },
      { phrase: 'use live voice', args: { engine: 'live' } }
    ],
    phrasesDe: [
      { phrase: 'nutze die kostenlose sprach-engine', args: { engine: 'chained' } },
      { phrase: 'nutze die kostenlose sprachengine', args: { engine: 'chained' } },
      { phrase: 'wechsle zur kostenlosen sprach-engine', args: { engine: 'chained' } },
      { phrase: 'wechsle zur live sprach-engine', args: { engine: 'live' } },
      { phrase: 'wechsle zur live sprachengine', args: { engine: 'live' } },
      { phrase: 'nutze live-sprache', args: { engine: 'live' } }
    ],
    run: async ({ engine }) => {
      const prefs = $prefs.get().voice
      await updatePrefs({ voice: { ...prefs, engine: engine as VoiceEngine } })

      return ok(t('commands.msg.system.engineSet', { engine: String(engine) }), { highlight: { kind: 'setting', id: 'voice' } })
    }
  },
  {
    id: 'voice.wake.set',
    title: 'Wake word',
    description: 'Turn the "hey hermes" wake word on or off.',
    tier: 'mutate',
    args: [{ name: 'enabled', type: 'boolean', description: 'true to listen for the wake word', required: true }],
    phrases: [
      { phrase: 'turn on the wake word', args: { enabled: true } },
      { phrase: 'enable hey hermes', args: { enabled: true } },
      { phrase: 'turn off the wake word', args: { enabled: false } },
      { phrase: 'stop listening for hey hermes', args: { enabled: false } }
    ],
    phrasesDe: [
      { phrase: 'schalte das aktivierungswort ein', args: { enabled: true } },
      { phrase: 'schalte das weckwort ein', args: { enabled: true } },
      { phrase: 'aktiviere hey hermes', args: { enabled: true } },
      { phrase: 'schalte das aktivierungswort aus', args: { enabled: false } },
      { phrase: 'schalte das weckwort aus', args: { enabled: false } },
      { phrase: 'höre nicht mehr auf hey hermes', args: { enabled: false } }
    ],
    run: async ({ enabled }) => {
      await setWakeWordEnabled(Boolean(enabled))

      return ok(enabled ? t('commands.msg.system.wakeOn') : t('commands.msg.system.wakeOff'), { highlight: { kind: 'setting', id: 'voice' } })
    }
  },
  {
    id: 'voice.start',
    title: 'Start a voice conversation',
    description: 'Open the microphone and talk to Hermes.',
    tier: 'act',
    args: [],
    phrases: ['start listening', 'talk to me'],
    phrasesDe: ['höre zu', 'fang an zuzuhören', 'sprich mit mir'],
    hidden: true,
    run: async () => {
      await startVoice('command')

      return ok(t('commands.msg.system.listening'))
    }
  },
  {
    id: 'voice.chat.end',
    title: 'End the visible voice chat',
    description: 'Return voice to its hidden operational session, keeping the visible chat history.',
    tier: 'act',
    args: [],
    phrases: ['end the chat', 'end the voice chat', 'return to operational voice'],
    phrasesDe: ['beende den sprachchat', 'zurück zur operativen sprachsitzung'],
    hidden: true,
    run: async () => {
      const result = await endVoiceChat()
      if (result === 'approval-pending') return fail(t('voice.session.approvalPending'))
      if (result === 'unavailable') return fail(t('voice.session.unavailable'))
      return ok(t(result === 'ended' ? 'voice.session.chatEnded' : 'voice.session.noVisibleChat'))
    }
  },
  {
    id: 'voice.stop',
    title: 'End the voice conversation',
    description: 'Close the microphone and end the conversation.',
    tier: 'read',
    args: [],
    phrases: ['stop listening', 'end the conversation', 'goodbye hermes'],
    phrasesDe: ['hör auf zuzuhören', 'beende das gespräch', 'auf wiedersehen hermes'],
    hidden: true,
    run: async () => {
      await endConversation('user')

      return ok(t('commands.msg.system.conversationEnded'))
    }
  },
  {
    id: 'voice.sleep',
    title: 'Put Herald OS to sleep',
    description: 'End the active voice conversation, hide Herald OS and resume wake listening.',
    tier: 'act',
    args: [],
    phrases: ['dragon sleep', 'dragon system off'],
    phrasesDe: ['dragon sleep', 'dragon system off'],
    hidden: true,
    run: async () => {
      if (hostPlatform() !== 'win32') return fail(t('commands.msg.system.sleepWindowsOnly'))

      try {
        await endConversation('user')
      } catch {
        return fail(t('commands.msg.system.sleepEndFailed'))
      }

      const wake = $wake.get()
      if (!wake.listening || wake.paused || wake.error) {
        return fail(t('commands.msg.system.sleepWakeUnavailable'))
      }

      try {
        await window.heraldOS.window.hide()
      } catch {
        // Hiding can fail after the native window already changed state; show it explicitly.
        try {
          await window.heraldOS.window.show()
        } catch {
          return fail(t('commands.msg.system.sleepRecoveryFailed'))
        }
        return fail(t('commands.msg.system.sleepHideFailed'))
      }

      return ok(t('commands.msg.system.sleeping'))
    }
  },
  {
    id: 'voice.mute',
    title: 'Mute the microphone',
    description: 'Mute or unmute the microphone during a conversation.',
    tier: 'read',
    args: [],
    phrases: ['mute', 'mute the microphone', 'unmute'],
    phrasesDe: ['stumm', 'mikrofon stummschalten', 'schalte das mikrofon stumm', 'stummschaltung aufheben'],
    hidden: true,
    run: () => {
      toggleMute()

      return ok(t('commands.msg.system.muteToggled'))
    }
  },
  {
    id: 'voice.quiet',
    title: 'Stop talking',
    description: 'Cut the current spoken reply short.',
    tier: 'read',
    args: [],
    phrases: ['be quiet', 'stop talking', 'shush', 'enough'],
    phrasesDe: ['sei still', 'hör auf zu reden', 'genug', 'psst'],
    hidden: true,
    run: () => {
      interruptSpeech()

      return ok(t('commands.msg.system.stoppedSpeaking'))
    }
  }
]
