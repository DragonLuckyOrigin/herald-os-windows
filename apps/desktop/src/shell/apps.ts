import type { ComponentType } from 'react'
import type { TextKey } from '../../shared/i18n.ts'
import type { InstalledApp } from '../../shared/ipc.ts'
import { t } from '../store/i18n.ts'

/** Pages inside the main Hermes window (sidebar navigation). */
export type PageId = 'overview' | 'hermes' | 'missions' | 'memory' | 'files' | 'automations' | 'connections' | 'settings'

/** Apps that open in their own floating window. */
export type FloatingAppId = 'terminal' | 'system' | 'chat-popout' | 'web' | 'studio' | 'capture-editor' | 'camera' | 'widget' | 'canvas' | 'docs' | 'sheets' | 'slides'

export type HermesAppId = PageId | FloatingAppId

export type AppCategory = 'productivity' | 'creative' | 'development' | 'system'

export interface HermesAppDef<Id extends HermesAppId = HermesAppId> {
  id: Id
  name: string
  tagline: string
  category: AppCategory
  /** Where the app lives: a page in the main window, or its own floating window. */
  kind: 'page' | 'window'
  /** Codicon-free inline SVG icon id rendered by AppIcon. */
  icon: AppIconId
  defaultSize?: { width: number; height: number }
  shortcut?: string
}

export type AppIconId =
  | 'hermes'
  | 'overview'
  | 'missions'
  | 'memory'
  | 'files'
  | 'automations'
  | 'connections'
  | 'settings'
  | 'terminal'
  | 'system'
  | 'code'
  | 'studio'
  | 'canvas'
  | 'docs'
  | 'sheets'
  | 'slides'
  | 'office'
  | 'documents'
  | 'grid'
  | 'trash'

export const PAGES: readonly HermesAppDef<PageId>[] = [
  { id: 'overview', name: 'Overview', get tagline() { return t('app.tagline.overview') }, category: 'productivity', kind: 'page', icon: 'overview', shortcut: '1' },
  { id: 'hermes', name: 'Hermes', get tagline() { return t('app.tagline.hermes') }, category: 'productivity', kind: 'page', icon: 'hermes', shortcut: '2' },
  { id: 'missions', name: 'Missions', get tagline() { return t('app.tagline.missions') }, category: 'productivity', kind: 'page', icon: 'missions', shortcut: '3' },
  { id: 'memory', name: 'Memory', get tagline() { return t('app.tagline.memory') }, category: 'productivity', kind: 'page', icon: 'memory', shortcut: '4' },
  { id: 'files', name: 'Files', get tagline() { return t('app.tagline.files') }, category: 'productivity', kind: 'page', icon: 'files', shortcut: '5' },
  { id: 'automations', name: 'Automations', get tagline() { return t('app.tagline.automations') }, category: 'productivity', kind: 'page', icon: 'automations', shortcut: '6' },
  { id: 'connections', name: 'Connections', get tagline() { return t('app.tagline.connections') }, category: 'system', kind: 'page', icon: 'connections', shortcut: '7' },
  { id: 'settings', name: 'Settings', get tagline() { return t('app.tagline.settings') }, category: 'system', kind: 'page', icon: 'settings', shortcut: ',' }
]

export const FLOATING_APPS: readonly HermesAppDef<FloatingAppId>[] = [
  { id: 'terminal', name: 'Terminal', get tagline() { return t('app.tagline.terminal') }, category: 'development', kind: 'window', icon: 'terminal', defaultSize: { width: 900, height: 560 }, shortcut: '8' },
  { id: 'system', name: 'System', get tagline() { return t('app.tagline.system') }, category: 'system', kind: 'window', icon: 'system', defaultSize: { width: 980, height: 640 }, shortcut: '9' },
  { id: 'chat-popout', name: 'Hermes', get tagline() { return t('app.tagline.chat-popout') }, category: 'productivity', kind: 'window', icon: 'hermes', defaultSize: { width: 820, height: 620 } },
  // Opened by the shell for a specific page (e.g. the provider sign-in); not launchable on its own.
  { id: 'web', name: 'Web', get tagline() { return t('app.tagline.web') }, category: 'productivity', kind: 'window', icon: 'grid', defaultSize: { width: 960, height: 680 } },
  // One per Hermes session; opened with "build …" or "show me the code".
  { id: 'studio', name: 'Studio', get tagline() { return t('app.tagline.studio') }, category: 'development', kind: 'window', icon: 'studio', defaultSize: { width: 1280, height: 800 } },
  // Opens on a screenshot (the capture preview's Edit).
  { id: 'capture-editor', name: 'Markup', get tagline() { return t('app.tagline.capture-editor') }, category: 'creative', kind: 'window', icon: 'documents', defaultSize: { width: 960, height: 680 } },
  { id: 'camera', name: 'Camera', get tagline() { return t('app.tagline.camera') }, category: 'creative', kind: 'window', icon: 'system', defaultSize: { width: 260, height: 290 } },
  // A widget plugin in its own window (its `panel` placement); opened with plugin.open.
  { id: 'widget', name: 'Widget', get tagline() { return t('app.tagline.widget') }, category: 'productivity', kind: 'window', icon: 'grid', defaultSize: { width: 360, height: 280 } },
  { id: 'canvas', name: 'Herald Canvas', get tagline() { return t('app.tagline.canvas') }, category: 'creative', kind: 'window', icon: 'canvas', defaultSize: { width: 1320, height: 840 } },
  { id: 'docs', name: 'Herald Docs', get tagline() { return t('app.tagline.docs') }, category: 'productivity', kind: 'window', icon: 'docs', defaultSize: { width: 1120, height: 840 } },
  { id: 'sheets', name: 'Herald Sheets', get tagline() { return t('app.tagline.sheets') }, category: 'productivity', kind: 'window', icon: 'sheets', defaultSize: { width: 1280, height: 820 } },
  { id: 'slides', name: 'Herald Slides', get tagline() { return t('app.tagline.slides') }, category: 'productivity', kind: 'window', icon: 'slides', defaultSize: { width: 1280, height: 820 } }
]

/** Floating apps the launcher and command bar offer; the rest open only with a payload. */
export const LAUNCHABLE_APPS: readonly HermesAppDef[] = [...PAGES, ...FLOATING_APPS].filter(app => app.id !== 'chat-popout' && app.id !== 'web' && app.id !== 'studio' && app.id !== 'capture-editor' && app.id !== 'widget')

export const HERMES_APPS: readonly HermesAppDef[] = [...PAGES, ...FLOATING_APPS]

export const appById = (id: HermesAppId): HermesAppDef => HERMES_APPS.find(a => a.id === id) ?? PAGES[0]

const APP_NAMES: Record<HermesAppId, TextKey> = {
  overview: 'app.overview',
  hermes: 'app.hermes',
  missions: 'app.missions',
  memory: 'app.memory',
  files: 'app.files',
  automations: 'app.automations',
  connections: 'app.connections',
  settings: 'app.settings',
  terminal: 'app.terminal',
  system: 'app.system',
  'chat-popout': 'app.chatPopout',
  web: 'app.web',
  studio: 'app.studio',
  'capture-editor': 'app.captureEditor',
  camera: 'app.camera',
  widget: 'app.widget',
  canvas: 'app.canvas',
  docs: 'app.docs',
  sheets: 'app.sheets',
  slides: 'app.slides'
}

/** An app's name in the language Herald shows; `name` stays English, which commands, voice and the Dock match on. */
export const appName = (app: Pick<HermesAppDef, 'id'>): string => t(APP_NAMES[app.id])

/** Native macOS apps the launcher and dock feature by name; matched against the installed list. */
export interface NativeAppAlias {
  label: string
  /** Candidate bundle names, first match wins. */
  names: string[]
  category: AppCategory
  icon: AppIconId
}

export const FEATURED_NATIVE: readonly NativeAppAlias[] = [
  { label: "Browser", names: ['Safari', 'Google Chrome', 'Arc', 'Firefox'], category: 'productivity', icon: 'grid' },
  { label: "Mail", names: ['Mail'], category: 'productivity', icon: 'grid' },
  { label: "Calendar", names: ['Calendar'], category: 'productivity', icon: 'grid' },
  { label: "Notes", names: ['Notes'], category: 'productivity', icon: 'grid' },
  { label: "Code", names: ['Visual Studio Code', 'Cursor', 'Zed', 'Xcode'], category: 'development', icon: 'code' },
  { label: "Photos", names: ['Photos'], category: 'creative', icon: 'grid' },
  { label: "Music", names: ['Music', 'Spotify'], category: 'creative', icon: 'grid' },
  { label: "App Store", names: ['App Store'], category: 'system', icon: 'grid' }
]

/**
 * An installed app's label beside Herald's own: GNOME Files becomes "Files (Nautilus)" next to
 * Herald's Files, named after the last part of its id. `taken` holds lowercase labels already shown.
 */
export function distinctAppLabel(app: Pick<InstalledApp, 'name' | 'bundleId'>, taken: ReadonlySet<string>): string {
  const tail = app.bundleId?.split('.').pop() ?? ''

  if (!taken.has(app.name.toLowerCase()) || !tail || tail.toLowerCase() === app.name.toLowerCase()) {
    return app.name
  }

  return `${app.name} (${tail[0].toUpperCase()}${tail.slice(1)})`
}

export type PageComponent = ComponentType<Record<string, never>>
