import { $notificationsOpen, clearNotifications } from '../store/notifications.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { setSidebarCollapsed, toggleSidebar } from '../store/sidebar.ts'
import { $spaces, setActiveSpace } from '../store/spaces.ts'
import { $applicationsOpen, toggleCommandBar } from '../store/surface.ts'
import { $focusedWindowId, $page, $windows, closeWindow, focusWindow, goBackPage, MAIN_WINDOW_ID, minimizeWindow, openApp, showPage, toggleMaximize } from '../store/windows.ts'
import { appName, FLOATING_APPS, type HermesAppId, PAGES, type PageId } from '../shell/apps.ts'
import { t } from '../store/i18n.ts'
import { focusSettings } from '../features/settings/sections/shared.tsx'

/*
 * Navigation and window commands. Page and app names accept the labels users say ("missions",
 * "the memory page", "terminal") plus a few synonyms; see `resolveAppId`.
 */

const PAGE_ALIASES: Record<string, PageId> = {
  übersicht: 'overview',
  startseite: 'overview',
  missionen: 'missions',
  gedächtnis: 'memory',
  erinnerungen: 'memory',
  dateien: 'files',
  automatisierungen: 'automations',
  verbindungen: 'connections',
  einstellungen: 'settings',
  home: 'overview',
  today: 'overview',
  dashboard: 'overview',
  chat: 'hermes',
  conversation: 'hermes',
  conversations: 'hermes',
  sessions: 'hermes',
  mission: 'missions',
  tasks: 'automations',
  automation: 'automations',
  schedules: 'automations',
  cron: 'automations',
  routines: 'automations',
  memories: 'memory',
  notes: 'memory',
  file: 'files',
  finder: 'files',
  folders: 'files',
  documents: 'files',
  connection: 'connections',
  integrations: 'connections',
  tools: 'connections',
  mcp: 'connections',
  preferences: 'settings',
  options: 'settings',
  config: 'settings'
}

const APP_ALIASES: Record<string, HermesAppId> = {
  shell: 'terminal',
  console: 'terminal',
  command: 'terminal',
  monitor: 'system',
  'system monitor': 'system',
  'activity monitor': 'system',
  processes: 'system',
  cpu: 'system',
  popout: 'chat-popout',
  'chat window': 'chat-popout'
}

const normalise = (value: string) => value.toLowerCase().trim().replace(/^(the|my|die|den|das|meine|meinen)\s+/, '').replace(/\s+(page|tab|window|app|screen|section|seite|fenster)$/, '').trim()

/** Resolve a spoken/typed name to a Hermes page or app id. */
export function resolveAppId(name: string): HermesAppId | null {
  const key = normalise(name)

  if (!key) {
    return null
  }

  const page = PAGES.find(p => p.id === key || p.name.toLowerCase() === key)

  if (page) {
    return page.id
  }

  const app = FLOATING_APPS.find(a => a.id === key || a.name.toLowerCase() === key)

  if (app && app.id !== 'web') {
    return app.id
  }

  return PAGE_ALIASES[key] ?? APP_ALIASES[key] ?? null
}

export const APP_NAMES: readonly string[] = [...PAGES.map(p => p.name.toLowerCase()), ...FLOATING_APPS.filter(a => a.id !== 'web' && a.id !== 'chat-popout').map(a => a.name.toLowerCase()), ...Object.keys(PAGE_ALIASES), ...Object.keys(APP_ALIASES)]

function appLabel(id: HermesAppId): string {
  return [...PAGES, ...FLOATING_APPS].find(a => a.id === id)?.name ?? id
}

/** Find an open floating window by app name/title; "this"/"current" means the focused one. */
function resolveWindow(name: string | undefined): { id: string; label: string } | null {
  const windows = Object.values($windows.get()).filter(w => w.phase !== 'closing')
  const key = normalise(name ?? '')

  if (!key || ['this', 'current', 'focused', 'it', 'that', 'this one', 'the window', 'window'].includes(key)) {
    const focused = $focusedWindowId.get()
    const win = focused ? windows.find(w => w.id === focused) : undefined

    return win ? { id: win.id, label: win.id === MAIN_WINDOW_ID ? 'Hermes' : win.title } : null
  }

  const listed = windows.find(w => w.id === name?.trim())

  if (listed) {
    return { id: listed.id, label: listed.id === MAIN_WINDOW_ID ? 'Hermes' : listed.title }
  }

  const appId = resolveAppId(key)
  const win = windows.find(w => (appId && w.appId === appId) || w.title.toLowerCase() === key || w.title.toLowerCase().includes(key))

  return win ? { id: win.id, label: win.id === MAIN_WINDOW_ID ? 'Hermes' : win.title } : null
}

export const navigationCommands: readonly OsCommand[] = [
  {
    id: 'page.open',
    title: 'Open a page or app',
    description: 'Show a Herald OS page (overview, hermes, missions, memory, files, automations, connections, settings) or open an app (terminal, system).',
    tier: 'read',
    args: [{ name: 'name', type: 'string', description: 'Page or app name', required: true }],
    phrases: ['open the {name} page', 'switch to {name}', 'go to the {name} page'],
    phrasesDe: ['öffne die Seite {name}', 'die Seite {name} öffnen', 'gehe zur Seite {name}', 'wechsle zur Seite {name}', 'wechsle zu {name}'],
    run: ({ name }) => {
      const id = resolveAppId(String(name))

      if (!id) {
        return fail(t('commands.page.unknown', { name: String(name) }))
      }

      openApp(id)
      const definition = [...PAGES, ...FLOATING_APPS].find(app => app.id === id)
      const label = definition ? appName(definition) : id
      const page = PAGES.some(p => p.id === id) ? (id as PageId) : undefined

      return ok(t('commands.page.opened', { name: label }), { spoken: t('commands.page.opening', { name: label }), page, highlight: { kind: 'page', id } })
    }
  },
  {
    id: 'page.current',
    title: 'Which page is open',
    description: 'Report the current page and open windows.',
    tier: 'read',
    args: [],
    phrases: ['where am i', 'what page is this', 'which page is open'],
    phrasesDe: ['wo bin ich', 'welche seite ist das', 'welche seite ist offen', 'welche seite ist geöffnet'],
    hidden: true,
    run: () => {
      const page = $page.get()
      const windows = Object.values($windows.get())
        .filter(w => w.id !== MAIN_WINDOW_ID && w.phase !== 'closing')
        .map(w => ({ id: w.id, app: w.appId, title: w.title, minimized: w.phase === 'minimized' }))

      return ok(windows.length ? t('commands.msg.navigation.onPageWith', { page: appLabel(page), windows: windows.map(w => w.title).join(', ') }) : t('commands.msg.navigation.onPage', { page: appLabel(page) }), { page, data: { page, windows } })
    }
  },
  {
    id: 'overlay.commandBar',
    title: 'Command bar',
    description: 'Open the command bar (Cmd+K).',
    tier: 'read',
    args: [],
    phrases: ['open the command bar', 'command bar', 'open command palette'],
    phrasesDe: ['öffne die befehlsleiste', 'öffne befehlsleiste', 'befehlsleiste', 'öffne die befehlspalette'],
    run: () => {
      toggleCommandBar(true)

      return ok(t('commands.msg.navigation.commandBarOpened'))
    }
  },
  {
    id: 'overlay.applications',
    title: 'Applications',
    description: 'Open the application launcher.',
    tier: 'read',
    args: [],
    phrases: ['open applications', 'show applications', 'open apps', 'open my apps', 'show my apps', 'show all apps', 'open the launcher', 'app launcher'],
    phrasesDe: ['öffne anwendungen', 'zeige anwendungen', 'öffne apps', 'öffne meine apps', 'zeige meine apps', 'zeige alle apps', 'öffne den launcher', 'app-launcher'],
    run: () => {
      $applicationsOpen.set(true)

      return ok(t('commands.msg.navigation.applicationsOpened'))
    }
  },
  {
    id: 'overlay.notifications',
    title: 'Notifications',
    description: 'Open or close the notifications panel.',
    tier: 'read',
    args: [{ name: 'open', type: 'boolean', description: 'true to open, false to close (default: toggle)' }],
    phrases: [
      { phrase: 'show notifications', args: { open: true } },
      { phrase: 'open notifications', args: { open: true } },
      { phrase: 'show my notifications', args: { open: true } },
      { phrase: 'close notifications', args: { open: false } },
      { phrase: 'hide notifications', args: { open: false } }
    ],
    phrasesDe: [
      { phrase: 'zeige benachrichtigungen', args: { open: true } },
      { phrase: 'öffne benachrichtigungen', args: { open: true } },
      { phrase: 'zeige meine benachrichtigungen', args: { open: true } },
      { phrase: 'schließe benachrichtigungen', args: { open: false } },
      { phrase: 'verberge benachrichtigungen', args: { open: false } },
      { phrase: 'blende benachrichtigungen aus', args: { open: false } }
    ],
    run: ({ open }) => {
      const next = typeof open === 'boolean' ? open : !$notificationsOpen.get()
      $notificationsOpen.set(next)

      return ok(next ? t('commands.msg.navigation.notificationsOpened') : t('commands.msg.navigation.notificationsClosed'))
    }
  },
  {
    id: 'notifications.clear',
    title: 'Clear notifications',
    description: 'Dismiss every notification.',
    tier: 'act',
    args: [],
    phrases: ['clear notifications', 'clear my notifications', 'dismiss all notifications'],
    phrasesDe: ['benachrichtigungen löschen', 'lösche die benachrichtigungen', 'verwerfe alle benachrichtigungen', 'benachrichtigungen verwerfen'],
    run: () => {
      clearNotifications()

      return ok(t('commands.msg.navigation.notificationsCleared'))
    }
  },
  {
    id: 'sidebar.toggle',
    title: 'Toggle sidebar',
    description: 'Collapse or expand the sidebar.',
    tier: 'read',
    args: [{ name: 'collapsed', type: 'boolean', description: 'true to collapse, false to expand (default: toggle)' }],
    phrases: [
      'toggle the sidebar',
      { phrase: 'hide the sidebar', args: { collapsed: true } },
      { phrase: 'collapse the sidebar', args: { collapsed: true } },
      { phrase: 'show the sidebar', args: { collapsed: false } },
      { phrase: 'expand the sidebar', args: { collapsed: false } }
    ],
    phrasesDe: [
      'seitenleiste umschalten',
      'schalte die seitenleiste um',
      { phrase: 'verberge die seitenleiste', args: { collapsed: true } },
      { phrase: 'verstecke die seitenleiste', args: { collapsed: true } },
      { phrase: 'blende die seitenleiste aus', args: { collapsed: true } },
      { phrase: 'klappe die seitenleiste ein', args: { collapsed: true } },
      { phrase: 'zeige die seitenleiste', args: { collapsed: false } },
      { phrase: 'blende die seitenleiste ein', args: { collapsed: false } },
      { phrase: 'klappe die seitenleiste aus', args: { collapsed: false } }
    ],
    run: ({ collapsed }) => {
      if (typeof collapsed === 'boolean') {
        setSidebarCollapsed(collapsed)
      } else {
        toggleSidebar()
      }

      return ok(t('commands.msg.navigation.sidebarToggled'))
    }
  },
  {
    id: 'space.switch',
    title: 'Switch Space',
    description: 'Switch to a Space by name (Personal, Work, Ideas, …).',
    tier: 'read',
    args: [{ name: 'name', type: 'string', description: 'Space name', required: true }],
    phrases: ['switch to {name} space', 'go to my {name} space', 'open {name} space'],
    phrasesDe: ['wechsle zum space {name}', 'wechsle zum bereich {name}', 'gehe zu meinem {name} space', 'öffne den space {name}'],
    run: ({ name }) => {
      const key = String(name).toLowerCase().replace(/\s+space$/, '').trim()
      const space = $spaces.get().find(s => s.id === key || s.name.toLowerCase() === key)

      if (!space) {
        return fail(t('commands.msg.navigation.noSpace', { name: String(name), spaces: $spaces.get().map(s => s.name).join(', ') }))
      }

      setActiveSpace(space.id)

      return ok(t('commands.msg.navigation.spaceSwitched', { name: space.name }), { spoken: t('commands.msg.navigation.spaceSpoken', { name: space.name }) })
    }
  },
  {
    id: 'window.fullscreen',
    title: 'Toggle fullscreen',
    description: 'Enter or leave fullscreen.',
    tier: 'act',
    args: [],
    phrases: ['toggle fullscreen', 'go fullscreen', 'fullscreen', 'exit fullscreen', 'leave fullscreen', 'enter fullscreen'],
    phrasesDe: ['vollbild umschalten', 'vollbild', 'vollbildmodus', 'gehe in den vollbildmodus', 'beende den vollbildmodus', 'verlasse den vollbildmodus'],
    run: async () => {
      await window.heraldOS.window.toggleFullscreen()

      return ok(t('commands.msg.navigation.fullscreenToggled'))
    }
  },
  {
    id: 'window.focus',
    title: 'Focus a window',
    description: 'Bring a window to the front (by app name or title).',
    tier: 'read',
    args: [{ name: 'name', type: 'string', description: 'Window or app name, or an id from window.list', required: true }],
    phrases: ['focus {name}', 'bring {name} to the front', 'switch to the {name} window'],
    phrasesDe: ['fokussiere {name}', 'bringe {name} nach vorn', 'bringe {name} nach vorne', 'wechsle zum fenster {name}'],
    run: ({ name }) => {
      const win = resolveWindow(String(name))

      if (!win) {
        return fail(t('commands.msg.navigation.noWindow', { name: String(name) }))
      }

      focusWindow(win.id)

      return ok(t('commands.msg.navigation.focused', { name: win.label }), { highlight: { kind: 'window', id: win.id } })
    }
  },
  {
    id: 'window.close',
    title: 'Close a window',
    description: 'Close a floating window (the Hermes window minimizes instead).',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Window or app name, or an id from window.list; omit for the focused window' }],
    phrases: ['close', 'close it', 'close that', 'close this window', 'close window', 'close the window', 'close {name}', 'close the {name} window', 'quit {name}'],
    phrasesDe: ['schließe', 'schließe es', 'schließe das', 'schließe dieses fenster', 'schließe fenster', 'schließe das fenster', 'schließe {name}', 'schließe das {name} fenster', 'schließe das fenster {name}', 'beende {name}'],
    run: ({ name }) => {
      const win = resolveWindow(name ? String(name) : undefined)

      if (!win) {
        return fail(name ? t('commands.msg.navigation.noWindow', { name: String(name) }) : t('commands.msg.navigation.noFocused'))
      }

      closeWindow(win.id)

      return ok(t('commands.msg.navigation.closed', { name: win.label }))
    }
  },
  {
    id: 'window.minimize',
    title: 'Minimize a window',
    description: 'Minimize a window to the Dock.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Window or app name, or an id from window.list; omit for the focused window' }],
    phrases: ['minimize', 'minimize it', 'minimize this', 'minimize this window', 'minimize the window', 'minimize {name}', 'hide it', 'hide this window', 'hide {name}', 'put it away'],
    phrasesDe: ['minimiere', 'minimiere es', 'minimiere das', 'minimiere dieses fenster', 'minimiere das fenster', 'minimiere {name}', 'verstecke es', 'verstecke dieses fenster', 'verstecke {name}', 'lege es weg'],
    run: ({ name }) => {
      const win = resolveWindow(name ? String(name) : undefined)

      if (!win) {
        return fail(name ? t('commands.msg.navigation.noWindow', { name: String(name) }) : t('commands.msg.navigation.noFocused'))
      }

      minimizeWindow(win.id)

      return ok(t('commands.msg.navigation.minimized', { name: win.label }))
    }
  },
  {
    id: 'window.maximize',
    title: 'Maximize a window',
    description: 'Make a window fill the desktop.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Window or app name, or an id from window.list; omit for the focused window' }],
    phrases: ['maximize', 'maximize it', 'maximize this window', 'expand', 'expand it', 'expand this window', 'make it bigger', 'make it full size', 'maximize {name}', 'expand {name}', 'make {name} bigger'],
    phrasesDe: ['maximiere', 'maximiere es', 'maximiere dieses fenster', 'vergrößere', 'vergrößere es', 'vergrößere dieses fenster', 'mach es größer', 'mach es maximal', 'maximiere {name}', 'vergrößere {name}', 'mach {name} größer'],
    run: ({ name }) => {
      const win = resolveWindow(name ? String(name) : undefined)

      if (!win) {
        return fail(name ? t('commands.msg.navigation.noWindow', { name: String(name) }) : t('commands.msg.navigation.noFocused'))
      }

      if ($windows.get()[win.id]?.maximized) {
        return ok(t('commands.msg.navigation.alreadyMaximized', { name: win.label }))
      }

      toggleMaximize(win.id)

      return ok(t('commands.msg.navigation.maximized', { name: win.label }))
    }
  },
  {
    id: 'window.restore',
    title: 'Restore a window',
    description: 'Bring a minimized window back, or return a maximized one to its normal size.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Window or app name, or an id from window.list; omit for the focused window' }],
    phrases: ['restore', 'restore it', 'restore the window', 'make it smaller', 'shrink it', 'unmaximize', 'restore {name}', 'bring back {name}', 'bring {name} back'],
    phrasesDe: ['stelle wieder her', 'stelle es wieder her', 'stelle das fenster wieder her', 'mach es kleiner', 'verkleinere es', 'normale größe', 'stelle {name} wieder her', 'hole {name} zurück', 'bringe {name} zurück'],
    run: ({ name }) => {
      const key = name ? String(name) : undefined
      // A minimized window is never focused; look it up by name among all windows.
      const target = key
        ? Object.values($windows.get()).find(w => w.phase !== 'closing' && (resolveAppId(key) === w.appId || w.title.toLowerCase().includes(key.toLowerCase())))
        : (Object.values($windows.get()).find(w => w.id === $focusedWindowId.get()) ?? Object.values($windows.get()).filter(w => w.phase === 'minimized').sort((a, b) => b.z - a.z)[0])

      if (!target) {
        return fail(key ? t('commands.msg.navigation.noWindowToRestoreNamed', { name: key }) : t('commands.msg.navigation.noWindowToRestore'))
      }

      const label = target.id === MAIN_WINDOW_ID ? 'Hermes' : target.title

      if (target.phase === 'minimized' || target.phase === 'minimizing') {
        focusWindow(target.id)

        return ok(t('commands.msg.navigation.restored', { name: label }))
      }

      if (target.maximized && target.id !== MAIN_WINDOW_ID) {
        toggleMaximize(target.id)

        return ok(t('commands.msg.navigation.restoredNormal', { name: label }))
      }

      focusWindow(target.id)

      return ok(t('commands.msg.navigation.alreadyNormal', { name: label }))
    }
  },
  {
    id: 'page.back',
    title: 'Go back',
    description: 'Return to the previous page.',
    tier: 'read',
    args: [],
    phrases: ['go back', 'back', 'previous page', 'go to the previous page', 'take me back'],
    phrasesDe: ['gehe zurück', 'geh zurück', 'zurück', 'vorherige Seite', 'gehe zur vorherigen seite', 'bring mich zurück'],
    run: () => {
      const previous = goBackPage()

      const definition = PAGES.find(app => app.id === previous)
      return previous ? ok(t('commands.page.back', { name: definition ? appName(definition) : previous }), { page: previous }) : fail(t('commands.page.noPrevious'))
    }
  },
  {
    id: 'help.commands',
    title: 'What can I say',
    description: 'Open the list of every voice command.',
    tier: 'read',
    args: [],
    phrases: ['what can i say', 'what can i ask', 'show voice commands', 'list voice commands', 'show me the commands', 'voice commands', 'help me with voice commands', 'what commands are there'],
    phrasesDe: ['zeige die Sprachbefehle', 'zeige Sprachbefehle', 'welche Sprachbefehle gibt es', 'was kann ich sagen', 'was kann ich fragen', 'liste die sprachbefehle auf', 'sprachbefehle', 'hilf mir mit sprachbefehlen', 'welche befehle gibt es', 'zeige mir die befehle'],
    run: () => {
      showPage('settings')
      focusSettings({ section: 'commands' })

      return ok(t('commands.help.opened'), { spoken: t('commands.help.opened'), page: 'settings' })
    }
  },
  {
    id: 'window.list',
    title: 'List windows',
    description: 'List the open windows.',
    tier: 'read',
    args: [],
    phrases: ['what windows are open', 'list windows', 'which windows are open'],
    phrasesDe: ['welche fenster sind offen', 'liste die fenster auf', 'fenster auflisten', 'zeige alle fenster'],
    hidden: true,
    run: () => {
      const windows = Object.values($windows.get())
        .filter(w => w.phase !== 'closing')
        .map(w => ({ id: w.id, app: w.appId, title: w.id === MAIN_WINDOW_ID ? `Hermes (${appLabel($page.get())})` : w.title, minimized: w.phase === 'minimized', focused: w.id === $focusedWindowId.get() }))

      return ok(windows.map(w => w.title).join(', ') || t('commands.msg.navigation.noWindows'), { items: windows })
    }
  },
  {
    id: 'page.showHermes',
    title: 'Show Hermes',
    description: 'Bring the Hermes window to the front on the Hermes page.',
    tier: 'read',
    args: [],
    phrases: ['show hermes', 'open hermes', 'talk to hermes', 'open the chat'],
    phrasesDe: ['sprich mit hermes', 'öffne den chat', 'öffne den hermes chat'],
    hidden: true,
    run: () => {
      showPage('hermes')

      return ok(t('commands.msg.navigation.hermesOpened'), { page: 'hermes' })
    }
  }
]
