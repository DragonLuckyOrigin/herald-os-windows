import { desktopProductName } from '../../lib/platform-labels.ts'
import { t as uiT, useT as useUiT, $language as $uiLanguage } from '../../store/i18n.ts'
import {
  IconAlarm,
  IconAlertTriangle,
  IconAppWindow,
  IconApps,
  IconBattery,
  IconBolt,
  IconBrush,
  IconCalendar,
  IconCamera,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconCloud,
  IconCode,
  IconCoffee,
  IconColorPicker,
  IconCpu,
  IconHeart,
  IconHistory,
  IconHome,
  IconDeviceDesktop,
  IconDownload,
  IconFolder,
  IconKeyboard,
  IconLock,
  IconLogout,
  IconMail,
  IconMessage,
  IconMicrophone,
  IconMoon,
  IconMusic,
  IconNotes,
  IconPalette,
  IconPhoto,
  IconPower,
  IconQrcode,
  IconRefresh,
  IconRocket,
  IconRotateClockwise,
  IconSearch,
  IconSettings,
  IconStar,
  IconSunset2,
  IconTerminal2,
  IconTextRecognition,
  IconToggleRight,
  IconTrash,
  IconVideo,
  IconWorld,
  type Icon
} from '@tabler/icons-react'
import { useStore } from '@nanostores/react'
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { CatalogEntryView, PowerAction } from '../../../shared/ipc.ts'
import type { MenuExtension, MenuExtensionIcon, MenuExtensions } from '../../../shared/menu-extensions.ts'
import { HermesAvatar } from '../../components/app-icon.tsx'
import { GlassButton } from '../../components/ui/glass.tsx'
import { Kbd, Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { CLI_UNAVAILABLE_MESSAGE, type CliOutcome, parseThemeList, runHeraldOs, runHeraldOsWithToast } from '../../lib/herald-os-cli.ts'
import { logFailure } from '../../lib/report.ts'
import { $env } from '../../store/backend.ts'
import { $catalog, loadCatalog } from '../../store/catalog.ts'
import { openSurface, relayToMain } from '../../store/shell.ts'
import { openApp, showPage } from '../../store/windows.ts'

/*
 * The Herald OS control menu (Mod+M or Mod+Alt+Space), modelled on Omarchy's: a tree of groups whose leaves
 * run the `herald-os` CLI, a power action, or a shell navigation. Leaves that need input show an
 * inline form step; destructive power actions show an inline confirm step. Everything degrades to
 * "Available on Herald OS Linux" where the CLI does not exist.
 */

interface FormField {
  id: string
  label: string
  placeholder: string
  required?: boolean
}

interface FormLeaf {
  kind: 'form'
  fields: FormField[]
  submitLabel: string
  argv: (values: Record<string, string>) => string[]
}

type Leaf =
  /** Run the CLI here, showing a spinner and the result. `detached` relays to the Hermes window and closes first (screenshots must not capture the overlay). */
  | { kind: 'cli'; argv: string[]; detached?: boolean }
  | FormLeaf
  | { kind: 'power'; action: PowerAction; confirm: boolean }
  | { kind: 'theme' }
  | { kind: 'wallpaper' }
  | { kind: 'local'; run: () => void }
  /** Pick from the install catalog (herald-os catalog list), then run `install <id>` or `remove <id>`. */
  | { kind: 'catalog'; mode: 'install' | 'remove' }
  /** A menu.json program: main starts it by the entry's id. */
  | { kind: 'exec'; id: string }
  | { kind: 'message'; text: string }

export interface MenuItem {
  id: string
  label: string
  hint?: string
  icon: Icon
  danger?: boolean
  leaf?: Leaf
  children?: MenuItem[]
}

export interface PowerItem {
  action: PowerAction
  label: string
  hint: string
  icon: Icon
  /** Destructive actions ask before running. */
  confirm: boolean
  danger?: boolean
}

export const POWER_ITEMS: PowerItem[] = [
  { action: 'lock', get label() { return uiT("ui.db44b8db4f05") }, get hint() { return uiT("ui.19d06546a039") }, icon: IconLock, confirm: false },
  { action: 'suspend', get label() { return uiT("ui.4948e134182f") }, get hint() { return uiT("ui.3444bc2e9563") }, icon: IconMoon, confirm: false },
  { action: 'reboot', get label() { return uiT("ui.6b983a81e5e8") }, get hint() { return uiT("ui.154f7b5e66ad") }, icon: IconRotateClockwise, confirm: true },
  { action: 'poweroff', get label() { return uiT("ui.a4193461e8ac") }, get hint() { return uiT("ui.2089aa6cd044") }, icon: IconPower, confirm: true, danger: true },
  { action: 'logout', get label() { return uiT("ui.49616145514e") }, get hint() { return uiT("ui.f9773e55e528") }, icon: IconLogout, confirm: true }
]

const powerItemLabel = (action: PowerAction): string => POWER_ITEMS.find(item => item.action === action)?.label ?? action

/** Confirmation copy for the destructive power actions. */
const POWER_CONFIRM: Partial<Record<PowerAction, string>> = {
  reboot: 'Open windows close and the machine restarts.',
  poweroff: 'Open windows close and the machine powers off.',
  logout: 'Open windows close and you return to the login screen.'
}

/** Run a power action; resolves to an inline message when the machine cannot do it here. */
export async function runPower(action: PowerAction): Promise<string | null> {
  const bridge = window.heraldOS?.shell?.power
  const platform = $env.get()?.platform

  // systemctl / niri / herald-os only exist on Herald OS Linux; elsewhere say so instead of spawning nothing.
  if (typeof bridge !== 'function' || (platform && platform !== 'linux')) {
    return CLI_UNAVAILABLE_MESSAGE
  }

  try {
    await bridge(action)

    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    return /not available|only available|ENOENT|unknown power/i.test(message) ? CLI_UNAVAILABLE_MESSAGE : message
  }
}

const field = (id: string, label: string, placeholder: string): FormField => ({ id, label, placeholder, required: true })

/** The menu tree. `herald-os` argv per leaf is spelled out inline so it doubles as documentation. */
function buildMenu(actions: { applications: () => void; close: () => void }): MenuItem[] {
  return [
    {
      id: 'install',
      label: uiT("ui.569ca49f4aaf"),
      hint: uiT("ui.64bb726972a4"),
      icon: IconDownload,
      children: [
        { id: 'install-catalog', label: uiT("ui.9b321a9df3c8"), hint: uiT("ui.7793b50f0bdd"), icon: IconApps, leaf: { kind: 'catalog', mode: 'install' } },
        {
          id: 'install-app',
          label: uiT("ui.92f23b0831cf"),
          hint: uiT("ui.b0b9e734b3cf"),
          icon: IconAppWindow,
          leaf: { kind: 'form', submitLabel: 'Install', fields: [field('name', 'Package', 'e.g. firefox')], argv: values => ['install', 'app', values.name] }
        },
        {
          id: 'install-webapp',
          label: uiT("ui.8af8784463ac"),
          hint: uiT("ui.a4e0621ba41c"),
          icon: IconWorld,
          leaf: {
            kind: 'form',
            submitLabel: 'Install',
            fields: [field('name', 'Name', 'e.g. Linear'), field('url', 'URL', 'https://')],
            argv: values => ['install', 'webapp', values.name, values.url]
          }
        }
      ]
    },
    {
      id: 'remove',
      label: uiT("ui.c3812fc4acb8"),
      hint: uiT("ui.fe199528850a"),
      icon: IconTrash,
      children: [
        { id: 'remove-catalog', label: uiT("ui.9b321a9df3c8"), hint: uiT("ui.e1237c4dca85"), icon: IconApps, leaf: { kind: 'catalog', mode: 'remove' } },
        {
          id: 'remove-app',
          label: uiT("ui.92f23b0831cf"),
          hint: uiT("ui.b0b9e734b3cf"),
          icon: IconAppWindow,
          leaf: { kind: 'form', submitLabel: 'Remove', fields: [field('name', 'Package', 'e.g. firefox')], argv: values => ['remove', 'app', values.name] }
        },
        {
          id: 'remove-webapp',
          label: uiT("ui.8af8784463ac"),
          hint: uiT("ui.2ba513bee6a8"),
          icon: IconWorld,
          leaf: { kind: 'form', submitLabel: 'Remove', fields: [field('name', 'Name', 'e.g. Linear')], argv: values => ['remove', 'webapp', values.name] }
        }
      ]
    },
    {
      id: 'update',
      label: uiT("ui.c1c1009d3f37"),
      hint: 'Herald OS',
      icon: IconRefresh,
      children: [
        { id: 'update-herald-os', label: 'Herald OS', hint: uiT("ui.c559c10897d4"), icon: IconRefresh, leaf: { kind: 'cli', argv: ['update'] } },
        { id: 'update-firmware-check', label: 'Firmware', hint: uiT("ui.0c59a5f9d4fa"), icon: IconCpu, leaf: { kind: 'cli', argv: ['firmware', 'check'] } },
        { id: 'update-firmware', label: uiT("ui.b45043e0ebca"), hint: uiT("ui.807588319792"), icon: IconCpu, leaf: { kind: 'cli', argv: ['firmware', 'update'] } },
        { id: 'update-rollback', label: uiT("ui.58a9408413a8"), hint: uiT("ui.37aeb8a2881b"), icon: IconHistory, leaf: { kind: 'cli', argv: ['rollback'] } }
      ]
    },
    {
      id: 'style',
      label: uiT("ui.7e744141b40e"),
      hint: uiT("ui.7f269e73c884"),
      icon: IconPalette,
      children: [
        { id: 'style-theme', label: uiT("ui.3f3b89ceb8e5"), hint: uiT("ui.ae37d3efa94f"), icon: IconBrush, leaf: { kind: 'theme' } },
        { id: 'style-wallpaper', label: uiT("ui.9bb4d045e1c9"), hint: uiT("ui.ceed9fd5f54d"), icon: IconPhoto, leaf: { kind: 'wallpaper' } }
      ]
    },
    {
      id: 'trigger',
      label: uiT("ui.8b9c643731c9"),
      hint: uiT("ui.d7900d8a4841"),
      icon: IconBolt,
      children: [
        {
          id: 'trigger-reminder',
          label: uiT("ui.bd2f248b88f0"),
          hint: uiT("ui.f14dcd307daf"),
          icon: IconAlarm,
          leaf: {
            kind: 'form',
            submitLabel: 'Set reminder',
            fields: [field('duration', 'In', 'e.g. 10m, 1h30m'), field('message', 'Message', 'What to remind you of')],
            argv: values => ['reminder', values.duration, values.message]
          }
        },
        { id: 'trigger-ask-region', label: uiT("ui.a91dbccba2db"), hint: uiT("ui.c9c223cf6dea"), icon: IconCamera, leaf: { kind: 'cli', argv: ['capture', 'region', '--ask'], detached: true } },
        { id: 'trigger-notice-time', label: uiT("ui.8784a620a520"), icon: IconClock, leaf: { kind: 'cli', argv: ['notice', 'time'] } },
        { id: 'trigger-notice-battery', label: uiT("ui.cc7948134580"), icon: IconBattery, leaf: { kind: 'cli', argv: ['notice', 'battery'] } },
        { id: 'trigger-notice-weather', label: uiT("ui.c89dcf05acfb"), icon: IconCloud, leaf: { kind: 'cli', argv: ['notice', 'weather'] } }
      ]
    },
    {
      id: 'capture',
      label: uiT("ui.1900b478a586"),
      hint: uiT("ui.e2b47a6bc794"),
      icon: IconCamera,
      children: [
        { id: 'capture-region', label: uiT("ui.b4350ddbfb67"), hint: uiT("ui.df0fe79898ef"), icon: IconCamera, leaf: { kind: 'cli', argv: ['capture', 'screenshot', 'region'], detached: true } },
        { id: 'capture-window', label: uiT("ui.699a0ddb0898"), hint: 'Super+Print', icon: IconAppWindow, leaf: { kind: 'cli', argv: ['capture', 'screenshot', 'window'], detached: true } },
        { id: 'capture-screen', label: uiT("ui.f115765aff84"), hint: 'Super+Shift+Print', icon: IconDeviceDesktop, leaf: { kind: 'cli', argv: ['capture', 'screenshot', 'screen'], detached: true } },
        { id: 'capture-record', label: uiT("ui.adfcda4dafd2"), hint: uiT("ui.25b2adb96ca8"), icon: IconVideo, leaf: { kind: 'cli', argv: ['capture', 'record'], detached: true } },
        { id: 'capture-record-audio', label: uiT("ui.132d0ab66ca2"), hint: uiT("ui.1ddead54acc8"), icon: IconMicrophone, leaf: { kind: 'cli', argv: ['capture', 'record', 'audio'], detached: true } },
        { id: 'capture-camera', label: uiT("ui.4edc1893e594"), hint: uiT("ui.4840468ebbc3"), icon: IconCamera, leaf: { kind: 'local', run: () => openApp('camera') } },
        { id: 'capture-color', label: uiT("ui.db1608796438"), hint: uiT("ui.f84b685ac4a6"), icon: IconColorPicker, leaf: { kind: 'cli', argv: ['capture', 'color'], detached: true } },
        { id: 'capture-qr', label: uiT("ui.1cddd4dbb6de"), hint: uiT("ui.7a9e115afbb2"), icon: IconQrcode, leaf: { kind: 'cli', argv: ['capture', 'qr'], detached: true } },
        { id: 'capture-text', label: uiT("ui.b81ce54cc97d"), hint: uiT("ui.fd1e61d37a80"), icon: IconTextRecognition, leaf: { kind: 'cli', argv: ['capture', 'text'], detached: true } }
      ]
    },
    {
      id: 'toggle',
      label: uiT("ui.3d03a1dea561"),
      hint: uiT("ui.6efb9c1dbc2a"),
      icon: IconToggleRight,
      children: [
        { id: 'toggle-nightlight', label: uiT("ui.78c28ebe0498"), hint: uiT("ui.95b8c97902a6"), icon: IconSunset2, leaf: { kind: 'cli', argv: ['toggle', 'nightlight'] } },
        { id: 'toggle-dnd', label: uiT("ui.fe39f3cdd983"), hint: uiT("ui.72cb3f303284"), icon: IconMoon, leaf: { kind: 'cli', argv: ['toggle', 'dnd'] } },
        { id: 'toggle-idle', label: uiT("ui.3d27b15954c5"), hint: uiT("ui.48c237d9557a"), icon: IconCoffee, leaf: { kind: 'cli', argv: ['toggle', 'idle'] } },
        { id: 'toggle-screensaver', label: uiT("ui.7c9b526d4ae7"), hint: uiT("ui.18feed95d6e0"), icon: IconDeviceDesktop, leaf: { kind: 'cli', argv: ['toggle', 'screensaver'] } },
        { id: 'toggle-screensaver-now', label: uiT("ui.4bcd28089a78"), hint: uiT("ui.fe18013d93d2"), icon: IconDeviceDesktop, leaf: { kind: 'cli', argv: ['screensaver'], detached: true } }
      ]
    },
    {
      id: 'system',
      label: uiT("ui.6725e7bbcd28"),
      hint: uiT("ui.4f532a0788ab"),
      icon: IconPower,
      children: POWER_ITEMS.map(item => ({
        id: `system-${item.action}`,
        label: item.label,
        hint: item.hint,
        icon: item.icon,
        danger: item.danger,
        leaf: { kind: 'power', action: item.action, confirm: item.confirm }
      }))
    },
    {
      id: 'hermes',
      label: 'Hermes',
      hint: uiT("ui.5415778fe6cf"),
      icon: IconApps,
      children: [
        { id: 'hermes-applications', label: uiT("ui.98e33b0f3104"), hint: uiT("ui.22614ace1aef"), icon: IconApps, leaf: { kind: 'local', run: actions.applications } },
        {
          id: 'hermes-terminal',
          label: uiT("ui.e0926fdac700"),
          hint: uiT("ui.37fff3347c99"),
          icon: IconTerminal2,
          leaf: {
            kind: 'local',
            run: () => {
              openApp('terminal')
              actions.close()
            }
          }
        },
        {
          id: 'hermes-files',
          label: uiT("ui.abc7e9892806"),
          hint: uiT("ui.9b25b9d5fbe9"),
          icon: IconFolder,
          leaf: {
            kind: 'local',
            run: () => {
              showPage('files')
              actions.close()
            }
          }
        },
        {
          id: 'hermes-settings',
          label: uiT("ui.74a883a037bc"),
          hint: uiT("ui.9b25b9d5fbe9"),
          icon: IconSettings,
          leaf: {
            kind: 'local',
            run: () => {
              showPage('settings')
              actions.close()
            }
          }
        },
        { id: 'hermes-hotkeys', label: uiT("ui.c15f1530d219"), hint: uiT("ui.97c6d31fe05c"), icon: IconKeyboard, leaf: { kind: 'cli', argv: ['wm', 'show-hotkey-overlay'], detached: true } }
      ]
    }
  ]
}

const EXTENSION_ICONS: Record<MenuExtensionIcon, Icon> = {
  star: IconStar,
  app: IconAppWindow,
  terminal: IconTerminal2,
  world: IconWorld,
  bolt: IconBolt,
  folder: IconFolder,
  notes: IconNotes,
  music: IconMusic,
  camera: IconCamera,
  code: IconCode,
  calendar: IconCalendar,
  mail: IconMail,
  chat: IconMessage,
  heart: IconHeart,
  home: IconHome,
  rocket: IconRocket
}

function extensionItem(entry: MenuExtension, close: () => void): MenuItem {
  const base = { id: entry.id, label: entry.label, hint: entry.hint, icon: EXTENSION_ICONS[entry.icon ?? 'star'] }
  const { action } = entry

  switch (action.kind) {
    case 'herald-os':
      return { ...base, leaf: { kind: 'cli', argv: action.argv } }
    case 'exec':
      return { ...base, leaf: { kind: 'exec', id: entry.id } }
    case 'url':
      return {
        ...base,
        leaf: {
          kind: 'local',
          run: () => {
            void window.heraldOS.shell.openExternal(action.url).catch(logFailure('shell.openExternal'))
            close()
          }
        }
      }
    case 'command':
      return {
        ...base,
        leaf: {
          kind: 'local',
          run: () => {
            relayToMain({ type: 'os', args: [action.command], payload: action.args })
            close()
          }
        }
      }
  }
}

/** The menu with the person's menu.json entries: in the group they name, or under "Yours". */
export function withExtensions(menu: MenuItem[], extensions: MenuExtensions, close: () => void): MenuItem[] {
  const groups = menu.map(group => ({ ...group, children: group.children ? [...group.children] : undefined }))
  const yours: MenuItem[] = []

  for (const entry of extensions.entries) {
    const item = extensionItem(entry, close)
    const group = entry.group ? groups.find(candidate => candidate.id === entry.group) : undefined

    if (group?.children) {
      group.children.push(item)
    } else {
      yours.push(item)
    }
  }

  if (extensions.errors.length > 0) {
    yours.push({ id: 'yours-problems', label: uiT("ui.533dea7953b4"), hint: extensions.errors[0], icon: IconAlertTriangle, danger: true, leaf: { kind: 'message', text: extensions.errors.join('\n') } })
  }

  return yours.length > 0 ? [...groups, { id: 'yours', label: uiT("ui.54b26f7d3d0d"), hint: uiT("ui.d666a20db2fd"), icon: IconStar, children: yours }] : groups
}

interface FlatItem {
  item: MenuItem
  /** Group labels above the item, for the filtered (flattened) view. */
  trail: string[]
}

function flatten(items: MenuItem[], trail: string[] = []): FlatItem[] {
  const out: FlatItem[] = []

  for (const item of items) {
    if (item.children) {
      out.push(...flatten(item.children, [...trail, item.label]))
    } else {
      out.push({ item, trail })
    }
  }

  return out
}

function findItem(items: MenuItem[], id: string): MenuItem | null {
  for (const item of items) {
    if (item.id === id) {
      return item
    }

    const nested = item.children ? findItem(item.children, id) : null

    if (nested) {
      return nested
    }
  }

  return null
}

type Step =
  | { kind: 'form'; item: MenuItem; leaf: FormLeaf }
  | { kind: 'confirm'; item: MenuItem; action: PowerAction }
  | { kind: 'run'; title: string; argv: string[] }
  | { kind: 'theme' }
  | { kind: 'catalog'; mode: 'install' | 'remove' }
  | { kind: 'message'; title: string; text: string; tone: 'muted' | 'danger' }

export interface ControlMenuProps {
  onClose: () => void
  onApplications: () => void
  /** Jump straight to an item (by id), e.g. `update-herald-os` from the menu bar's update indicator. */
  initialItem?: string
}

export function ControlMenu({ onClose, onApplications, initialItem }: ControlMenuProps) {
  useUiT()
  const [extensions, setExtensions] = useState<MenuExtensions>({ entries: [], errors: [] })
  const menu = useMemo(() => withExtensions(buildMenu({ applications: onApplications, close: onClose }), extensions, onClose), [$uiLanguage.get(), onApplications, onClose, extensions])

  // Read menu.json each time the menu opens, so an edit shows up without a restart.
  useEffect(() => {
    void window.heraldOS.shell
      .menuExtensions?.()
      .then(setExtensions)
      .catch(() => undefined)
  }, [])
  const [path, setPath] = useState<MenuItem[]>([])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [step, setStep] = useState<Step | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const level = path.length > 0 ? (path[path.length - 1]?.children ?? []) : menu
  const trimmed = query.trim().toLowerCase()
  const visible: FlatItem[] = useMemo(() => {
    if (!trimmed) {
      return level.map(item => ({ item, trail: [] }))
    }

    const scope = path.length > 0 ? level : menu

    return flatten(scope).filter(({ item, trail }) => `${trail.join(' ')} ${item.label} ${item.hint ?? ''}`.toLowerCase().includes(trimmed))
  }, [$uiLanguage.get(), trimmed, level, menu, path.length])

  useEffect(() => {
    setActive(0)
  }, [trimmed, path])

  useEffect(() => {
    if (!step) {
      inputRef.current?.focus()
    }
  }, [step, path])

  // Keep the active row in view while arrowing through a long, scrolling level.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    row?.scrollIntoView({ block: 'nearest' })
  }, [active, visible])

  const activate = (item: MenuItem) => {
    if (item.children) {
      setPath(current => [...current, item])
      setQuery('')

      return
    }

    const leaf = item.leaf

    if (!leaf) {
      return
    }

    switch (leaf.kind) {
      case 'cli':
        if (leaf.detached) {
          relayToMain({ type: 'herald-os', args: leaf.argv, text: item.label })
          onClose()
        } else {
          setStep({ kind: 'run', title: item.label, argv: leaf.argv })
        }

        return
      case 'form':
        setStep({ kind: 'form', item, leaf })

        return
      case 'power':
        if (leaf.confirm) {
          setStep({ kind: 'confirm', item, action: leaf.action })
        } else {
          void runPower(leaf.action).then(message => {
            if (message) {
              setStep({ kind: 'message', title: item.label, text: message, tone: message === CLI_UNAVAILABLE_MESSAGE ? 'muted' : 'danger' })
            } else {
              onClose()
            }
          })
        }

        return
      case 'theme':
        setStep({ kind: 'theme' })

        return
      case 'catalog':
        setStep({ kind: 'catalog', mode: leaf.mode })

        return
      case 'wallpaper':
        // The file dialog would blur (and so close) this overlay, so the Hermes window owns the picker.
        relayToMain({ type: 'pick-wallpaper' })
        openSurface('main')
        onClose()

        return
      case 'local':
        leaf.run()

        return
      case 'exec':
        void window.heraldOS.shell.runMenuExtension(leaf.id).then(onClose, (error: unknown) =>
          setStep({ kind: 'message', title: item.label, text: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error), tone: 'danger' })
        )

        return
      case 'message':
        setStep({ kind: 'message', title: item.label, text: leaf.text, tone: 'danger' })

        return
      default:
        return
    }
  }

  // Deep link (menu bar update dot): open the item as if it had been chosen.
  useEffect(() => {
    if (!initialItem) {
      return
    }

    const target = findItem(menu, initialItem)

    if (target) {
      activate(target)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialItem])

  const back = () => {
    if (step) {
      setStep(null)

      return
    }

    if (trimmed) {
      setQuery('')

      return
    }

    setPath(current => current.slice(0, -1))
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      if (step || path.length > 0 || trimmed) {
        // Nested: step back instead of closing the overlay (the surface listens for unhandled Escape).
        event.preventDefault()
        back()
      }

      return
    }

    if (step) {
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()

      if (visible.length > 0) {
        setActive(current => (current + (event.key === 'ArrowDown' ? 1 : visible.length - 1)) % visible.length)
      }
    } else if (event.key === 'ArrowRight') {
      const target = visible[active]?.item

      if (target?.children) {
        event.preventDefault()
        activate(target)
      }
    } else if (event.key === 'ArrowLeft' && path.length > 0 && !trimmed) {
      event.preventDefault()
      back()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const target = visible[active]?.item

      if (target) {
        activate(target)
      }
    } else if (event.key === 'Backspace' && !query && path.length > 0) {
      event.preventDefault()
      back()
    }
  }

  const title = path.map(item => item.label)

  return (
    <div className="float flex flex-col overflow-hidden rounded-2xl animate-pop" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        {path.length > 0 || step ? (
          <button type="button" aria-label={uiT("ui.76900f1bfd16")} onClick={back} className="flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-white/10 hover:text-fg">
            <IconChevronLeft size={16} />
          </button>
        ) : (
          <HermesAvatar size={22} rounded={6} />
        )}
        <span className="flex min-w-0 items-center gap-1.5 text-[14px] font-semibold">
          <span className={cn(title.length > 0 && 'text-fg-3')}>{desktopProductName()}</span>
          {title.map(label => (
            <span key={label} className="flex items-center gap-1.5">
              <IconChevronRight size={13} className="text-fg-4" />
              <span className="truncate">{label}</span>
            </span>
          ))}
        </span>
        <span className="flex-1" />
        <Kbd>esc</Kbd>
      </div>
      <div className="h-px bg-line" />

      {step ? (
        <StepView step={step} onBack={back} onClose={onClose} onRun={(runTitle, argv) => setStep({ kind: 'run', title: runTitle, argv })} />
      ) : (
        <>
          <label className="mx-3 mt-3 flex h-9 items-center gap-2.5 rounded-lg px-3 glass-input">
            <IconSearch size={15} className="shrink-0 text-fg-3" />
            <input
              ref={inputRef}
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={path.length > 0 ? uiT("ui.046b24e9c2fb", { value1: String(path[path.length - 1]?.label ?? '') }) : uiT("ui.14b26622d3f9")}
              aria-label={uiT("ui.148edbcf5004")}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4"
            />
          </label>
          <div ref={listRef} className="flex max-h-[400px] flex-col gap-0.5 overflow-y-auto p-2" role="menu">
            {visible.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-fg-4">{uiT("ui.1ae09c1b2172")}{query.trim()}"</div>}
            {visible.map(({ item, trail }, index) => {
              const ItemIcon = item.icon
              const isActive = index === active

              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  data-active={isActive}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => activate(item)}
                  className={cn('flex h-10 items-center gap-3 rounded-lg px-3 text-[13px] text-fg-2', isActive && 'bg-white/10 text-fg', item.danger && isActive && 'text-danger')}
                >
                  <span className={cn('flex size-6 items-center justify-center text-fg-3', item.danger && 'text-danger/80')}>
                    <ItemIcon size={16} />
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    {trail.length > 0 && <span className="truncate text-fg-4">{trail.join(' › ')} ›</span>}
                    <span className="truncate">{item.label}</span>
                  </span>
                  {item.hint && <span className="truncate text-[11px] text-fg-4">{item.hint}</span>}
                  {item.children && <IconChevronRight size={14} className="text-fg-4" />}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function StepView({ step, onBack, onClose, onRun }: { step: Step; onBack: () => void; onClose: () => void; onRun: (title: string, argv: string[]) => void }) {
  useUiT()
  switch (step.kind) {
    case 'form':
      return <FormStep item={step.item} leaf={step.leaf} onCancel={onBack} onSubmit={argv => onRun(step.item.label.replace(/…$/, ''), argv)} />
    case 'confirm':
      return <PowerConfirm action={step.action} onCancel={onBack} onDone={onClose} />
    case 'run':
      return <RunStep title={step.title} argv={step.argv} onClose={onClose} onBack={onBack} />
    case 'theme':
      return <ThemeStep onBack={onBack} onRun={onRun} />
    case 'catalog':
      return <CatalogStep mode={step.mode} onBack={onBack} onRun={onRun} />
    case 'message':
      return <MessageStep title={step.title} text={step.text} tone={step.tone} onBack={onBack} />
    default:
      return null
  }
}

/** Inline form for leaves that need arguments (package name, web app name and URL, reminder). */
function FormStep({ item, leaf, onCancel, onSubmit }: { item: MenuItem; leaf: FormLeaf; onCancel: () => void; onSubmit: (argv: string[]) => void }) {
  useUiT()
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(leaf.fields.map(f => [f.id, ''])))
  const firstRef = useRef<HTMLInputElement>(null)
  const ItemIcon = item.icon

  useEffect(() => {
    firstRef.current?.focus()
  }, [])

  const complete = leaf.fields.every(f => !f.required || values[f.id]?.trim())

  const submit = () => {
    if (!complete) {
      return
    }

    const clean = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]))
    onSubmit(leaf.argv(clean))
  }

  return (
    <form
      className="flex flex-col gap-3 p-4"
      onSubmit={event => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="flex items-center gap-3">
        <span className="icon-tile size-9 rounded-lg">
          <ItemIcon size={18} />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-fg">{item.label.replace(/…$/, '')}</div>
          {item.hint && <div className="text-[12px] text-fg-3">{item.hint}</div>}
        </div>
      </div>
      {leaf.fields.map((fieldDef, index) => (
        <label key={fieldDef.id} className="flex flex-col gap-1">
          <span className="text-[11.5px] text-fg-3">{fieldDef.label}</span>
          <input
            ref={index === 0 ? firstRef : undefined}
            value={values[fieldDef.id] ?? ''}
            onChange={event => setValues(current => ({ ...current, [fieldDef.id]: event.target.value }))}
            placeholder={fieldDef.placeholder}
            spellCheck={false}
            className="glass-input h-9 rounded-lg px-3 text-[13px] outline-none placeholder:text-fg-4"
          />
        </label>
      ))}
      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="text-[11.5px] text-fg-4">
          <Kbd>↵</Kbd> {leaf.submitLabel.toLowerCase()} · <Kbd>esc</Kbd>{uiT("ui.baed01e0241b")}</span>
        <div className="flex items-center gap-2">
          <GlassButton size="sm" variant="ghost" onClick={onCancel}>
            {uiT("ui.0ef70263b054")}</GlassButton>
          <GlassButton size="sm" variant="primary" type="submit" disabled={!complete}>
            {leaf.submitLabel}
          </GlassButton>
        </div>
      </div>
    </form>
  )
}

/** Confirm step for restart, shut down and log out. Shared with the power card. */
export function PowerConfirm({ action, onCancel, onDone }: { action: PowerAction; onCancel: () => void; onDone: () => void }) {
  useUiT()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const label = powerItemLabel(action)
  const danger = action === 'poweroff'

  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  const confirm = () => {
    if (busy) {
      return
    }

    setBusy(true)
    void runPower(action).then(result => {
      if (result) {
        setBusy(false)
        setMessage(result)
      } else {
        onDone()
      }
    })
  }

  return (
    <div className="flex flex-col gap-3 p-4" role="alertdialog" aria-label={`${label}?`}>
      <div className="flex items-start gap-3">
        <span className={cn('icon-tile size-9 rounded-lg', danger && 'text-danger')}>
          <IconAlertTriangle size={18} />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-fg">{label}{uiT("ui.3ef5e33815f1")}</div>
          <div className="text-[12px] text-fg-3">{POWER_CONFIRM[action] ?? uiT("ui.b545dd165128")}</div>
        </div>
      </div>
      {message && <InlineMessage text={message} tone={message === CLI_UNAVAILABLE_MESSAGE ? 'muted' : 'danger'} />}
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11.5px] text-fg-4">
          <Kbd>↵</Kbd>{uiT("ui.69cf0e7ce9c0")}<Kbd>esc</Kbd>{uiT("ui.baed01e0241b")}</span>
        <div className="flex items-center gap-2">
          <GlassButton size="sm" variant="ghost" onClick={onCancel}>
            {uiT("ui.0ef70263b054")}</GlassButton>
          <GlassButton ref={confirmRef} size="sm" variant={danger ? 'danger' : 'primary'} onClick={confirm} disabled={busy || message === CLI_UNAVAILABLE_MESSAGE}>
            {busy && <Spinner />}
            {label}
          </GlassButton>
        </div>
      </div>
    </div>
  )
}

/** Runs one `herald-os` command with a spinner, then shows the tail of its output. */
function RunStep({ title, argv, onClose, onBack }: { title: string; argv: string[]; onClose: () => void; onBack: () => void }) {
  useUiT()
  const [outcome, setOutcome] = useState<CliOutcome | null>(null)
  const doneRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let cancelled = false
    setOutcome(null)
    void runHeraldOsWithToast(argv, title).then(result => {
      if (!cancelled) {
        setOutcome(result)
      }
    })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [argv.join('\u0000')])

  useEffect(() => {
    if (outcome) {
      doneRef.current?.focus()
    }
  }, [outcome])

  const command = `herald-os ${argv.map(arg => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <span className={cn('icon-tile size-9 rounded-lg', outcome && !outcome.ok && !outcome.unavailable && 'text-danger')}>
          {!outcome ? <Spinner className="size-4" /> : outcome.ok ? <IconCheck size={18} /> : outcome.unavailable ? <IconTerminal2 size={18} /> : <IconAlertTriangle size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg">{!outcome ? `${title}…` : outcome.ok ? uiT("ui.8aaf979fe58c", { value1: String(title) }) : outcome.unavailable ? title : uiT("ui.e419211b1bc0", { value1: String(title) })}</div>
          <div className="truncate font-mono text-[11.5px] text-fg-4" title={command}>
            {command}
          </div>
        </div>
      </div>
      {outcome && <InlineMessage text={outcome.output || (outcome.ok ? 'Finished with no output.' : `Exited with code ${outcome.code}.`)} tone={outcome.unavailable ? 'muted' : outcome.ok ? 'ok' : 'danger'} />}
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11.5px] text-fg-4">{outcome ? <><Kbd>↵</Kbd>{uiT("ui.bf7209099f1e")}<Kbd>esc</Kbd>{uiT("ui.5441b51aa794")}</> : uiT("ui.f4ccae29e1bb")}</span>
        <div className="flex items-center gap-2">
          {outcome && (
            <GlassButton size="sm" variant="ghost" onClick={onBack}>
              {uiT("ui.9153f74ab465")}</GlassButton>
          )}
          <GlassButton ref={doneRef} size="sm" variant="primary" onClick={onClose} disabled={!outcome}>
            {uiT("ui.79c84b48c2f0")}</GlassButton>
        </div>
      </div>
    </div>
  )
}

/** `herald-os theme list` as a keyboard-navigable list of choices; picking one runs `theme set <name>`. */
function ThemeStep({ onBack, onRun }: { onBack: () => void; onRun: (title: string, argv: string[]) => void }) {
  useUiT()
  const [themes, setThemes] = useState<string[] | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([runHeraldOs(['theme', 'list']), runHeraldOs(['theme', 'current'])]).then(([list, now]) => {
      if (cancelled) {
        return
      }

      if (!list.ok) {
        setMessage(list.output || `theme list exited with code ${list.code}`)
        setThemes([])

        return
      }

      setThemes(parseThemeList(list.output))
      setCurrent(now.ok ? now.output.trim().split('\n').pop() ?? null : null)
      inputRef.current?.focus()
    })

    return () => {
      cancelled = true
    }
  }, [])

  const trimmed = query.trim().toLowerCase()
  const visible = (themes ?? []).filter(name => name.toLowerCase().includes(trimmed))

  useEffect(() => {
    setActive(0)
  }, [trimmed])

  const choose = (name: string) => onRun(`Theme ${name}`, ['theme', 'set', name])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()

      if (visible.length > 0) {
        setActive(index => (index + (event.key === 'ArrowDown' ? 1 : visible.length - 1)) % visible.length)
      }
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const name = visible[active]

      if (name) {
        choose(name)
      }
    } else if (event.key === 'Backspace' && !query) {
      event.preventDefault()
      onBack()
    }
  }

  if (!themes) {
    return (
      <div className="flex items-center gap-3 px-4 py-6 text-[12.5px] text-fg-3">
        <Spinner />{uiT("ui.2b2588d90560")}</div>
    )
  }

  if (message || themes.length === 0) {
    return <MessageStep title={uiT("ui.efb52e7172b7")} text={message ?? uiT("ui.38baff3bd1ed")} tone={message === CLI_UNAVAILABLE_MESSAGE ? 'muted' : 'danger'} onBack={onBack} />
  }

  return (
    <div className="flex flex-col" onKeyDown={onKeyDown}>
      <label className="mx-3 mt-3 flex h-9 items-center gap-2.5 rounded-lg px-3 glass-input">
        <IconSearch size={15} className="shrink-0 text-fg-3" />
        <input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} placeholder={uiT("ui.559203745522")} aria-label={uiT("ui.559203745522")} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4" />
      </label>
      <div className="flex max-h-[360px] flex-col gap-0.5 overflow-y-auto p-2" role="listbox" aria-label={uiT("ui.43ae3265b99f")}>
        {visible.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-fg-4">{uiT("ui.71f68b4da31c")}{query.trim()}"</div>}
        {visible.map((name, index) => (
          <button
            key={name}
            type="button"
            role="option"
            aria-selected={index === active}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(name)}
            className={cn('flex h-9 items-center gap-3 rounded-lg px-3 text-[13px] text-fg-2', index === active && 'bg-white/10 text-fg')}
          >
            <span className="flex size-6 items-center justify-center text-fg-3">
              <IconBrush size={16} />
            </span>
            <span className="flex-1 truncate text-left">{name}</span>
            {name === current && <IconCheck size={14} className="text-accent-strong" aria-label={uiT("ui.4089af3e4041")} />}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The install catalog as a filterable list: what can be installed here, or what is installed. */
function CatalogStep({ mode, onBack, onRun }: { mode: 'install' | 'remove'; onBack: () => void; onRun: (title: string, argv: string[]) => void }) {
  useUiT()
  const catalog = useStore($catalog)
  const [active, setActive] = useState(0)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadCatalog().then(() => inputRef.current?.focus())
  }, [])

  const trimmed = query.trim().toLowerCase()
  const rows = catalog.groups.flatMap(group =>
    group.entries
      .filter(entry => (mode === 'install' ? entry.available && !entry.installed : entry.removable))
      .filter(entry => !trimmed || `${group.label} ${entry.label} ${entry.id} ${entry.description}`.toLowerCase().includes(trimmed))
      .map(entry => ({ entry, group: group.label }))
  )

  useEffect(() => {
    setActive(0)
  }, [trimmed])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (entry: CatalogEntryView) => onRun(`${mode === 'install' ? 'Install' : 'Remove'} ${entry.label}`, [mode, entry.id])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()

      if (rows.length > 0) {
        setActive(index => (index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length)
      }
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const row = rows[active]

      if (row) {
        choose(row.entry)
      }
    } else if (event.key === 'Backspace' && !query) {
      event.preventDefault()
      onBack()
    }
  }

  if (!catalog.loaded) {
    return (
      <div className="flex items-center gap-3 px-4 py-6 text-[12.5px] text-fg-3">
        <Spinner />{uiT("ui.feb2943af54c")}</div>
    )
  }

  if (catalog.error) {
    return <MessageStep title={uiT("ui.3877d14889a9")} text={catalog.error} tone="danger" onBack={onBack} />
  }

  return (
    <div className="flex flex-col" onKeyDown={onKeyDown}>
      <label className="mx-3 mt-3 flex h-9 items-center gap-2.5 rounded-lg px-3 glass-input">
        <IconSearch size={15} className="shrink-0 text-fg-3" />
        <input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} placeholder={mode === 'install' ? uiT("ui.c9b958868265") : uiT("ui.4dd09b354579")} aria-label={uiT("ui.2f0d50e1229e")} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4" />
      </label>
      <div ref={listRef} className="flex max-h-[360px] flex-col gap-0.5 overflow-y-auto p-2" role="listbox" aria-label={uiT("ui.3877d14889a9")}>
        {rows.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-fg-4">{trimmed ? uiT("ui.9c359bb498db", { value1: String(query.trim()) }) : mode === 'install' ? uiT("ui.eb0390b6359a") : uiT("ui.65fb3925881f")}</div>}
        {rows.map(({ entry, group }, index) => (
          <button
            key={entry.id}
            type="button"
            role="option"
            aria-selected={index === active}
            data-active={index === active}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(entry)}
            className={cn('flex h-10 items-center gap-3 rounded-lg px-3 text-[13px] text-fg-2', index === active && 'bg-white/10 text-fg')}
          >
            <span className="flex size-6 items-center justify-center text-fg-3">{mode === 'install' ? <IconDownload size={16} /> : <IconTrash size={16} />}</span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
              <span className="truncate text-fg-4">{group} ›</span>
              <span className="truncate">{entry.label}</span>
            </span>
            <span className="truncate text-[11px] text-fg-4">{entry.method === 'link' ? uiT("ui.13e673ba8f32") : entry.method}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function MessageStep({ title, text, tone, onBack }: { title: string; text: string; tone: 'muted' | 'danger'; onBack: () => void }) {
  useUiT()
  const backRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    backRef.current?.focus()
  }, [])

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="text-[13px] font-medium text-fg">{title}</div>
      <InlineMessage text={text} tone={tone} />
      <div className="flex justify-end">
        <GlassButton ref={backRef} size="sm" onClick={onBack}>
          {uiT("ui.9153f74ab465")}</GlassButton>
      </div>
    </div>
  )
}

/** A compact result line: CLI output tail, an error, or the "not here" notice. */
export function InlineMessage({ text, tone, className }: { text: string; tone: 'muted' | 'ok' | 'danger'; className?: string }) {
  useUiT()
  const tones = { muted: 'border-line bg-white/4 text-fg-3', ok: 'border-ok/30 bg-ok/8 text-fg-2', danger: 'border-danger/40 bg-danger/10 text-danger' }

  return (
    <pre className={cn('max-h-28 overflow-auto rounded-lg border px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words', tones[tone], className)} role={tone === 'danger' ? 'alert' : 'status'}>
      {text}
    </pre>
  )
}

/** Power mode (`herald-os power`): the System group as a compact card. */
export function PowerCard({ onClose }: { onClose: () => void }) {
  useUiT()
  const [confirm, setConfirm] = useState<PowerAction | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState<PowerAction | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!confirm) {
      gridRef.current?.querySelector<HTMLButtonElement>('[data-active="true"]')?.focus()
    }
  }, [confirm, active])

  const pick = (item: PowerItem) => {
    if (item.confirm) {
      setConfirm(item.action)

      return
    }

    setBusy(item.action)
    void runPower(item.action).then(result => {
      setBusy(null)

      if (result) {
        setMessage(result)
      } else {
        onClose()
      }
    })
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (confirm) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setConfirm(null)
      }

      return
    }

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(index => (index + 1) % POWER_ITEMS.length)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(index => (index + POWER_ITEMS.length - 1) % POWER_ITEMS.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const item = POWER_ITEMS[active]

      if (item) {
        pick(item)
      }
    }
  }

  return (
    <div className="float flex flex-col overflow-hidden rounded-2xl animate-pop" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <HermesAvatar size={22} rounded={6} />
        <span className="text-[14px] font-semibold">{uiT("ui.848e96567d6b")}</span>
        <span className="flex-1" />
        <Kbd>esc</Kbd>
      </div>
      <div className="h-px bg-line" />
      {confirm ? (
        <PowerConfirm action={confirm} onCancel={() => setConfirm(null)} onDone={onClose} />
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <div ref={gridRef} className="grid grid-cols-5 gap-3" role="menu" aria-label={uiT("ui.af9ca6e6e43f")}>
            {POWER_ITEMS.map((item, index) => {
              const ItemIcon = item.icon

              return (
                <button
                  key={item.action}
                  type="button"
                  role="menuitem"
                  data-active={index === active}
                  onMouseEnter={() => setActive(index)}
                  onFocus={() => setActive(index)}
                  onClick={() => pick(item)}
                  disabled={busy !== null}
                  className={cn(
                    'glass-card glass-card-hover flex flex-col items-center gap-2.5 rounded-xl px-2 py-4 text-[12.5px] text-fg-2 outline-none hover:text-fg disabled:opacity-60',
                    index === active && 'glass-card-selected text-fg',
                    item.danger && 'hover:border-danger/50 hover:text-danger'
                  )}
                >
                  <span className={cn('icon-tile size-11 rounded-xl', item.danger && 'text-danger')}>{busy === item.action ? <Spinner className="size-4" /> : <ItemIcon size={22} />}</span>
                  {item.label}
                </button>
              )
            })}
          </div>
          {message && <InlineMessage text={message} tone={message === CLI_UNAVAILABLE_MESSAGE ? 'muted' : 'danger'} />}
        </div>
      )}
    </div>
  )
}