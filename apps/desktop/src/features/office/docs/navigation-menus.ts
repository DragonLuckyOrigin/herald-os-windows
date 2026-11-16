import { t as uiT } from '../../../store/i18n.ts'
import type { OfficeCommand } from '../shell/commands.ts'
import { $navigationPane, showNavigationPane } from './navigation-store.ts'
import { activeEditor } from './store.ts'

export const NAVIGATION_PANE_SHORTCUT = 'mod+alt+o'

/** What the View menu offers for the navigation pane. */
export const navigationViewItems = (): OfficeCommand[] => [
  { id: 'navigation-pane', label: uiT("ui.ed04d2c3c4ce"), shortcut: NAVIGATION_PANE_SHORTCUT, enabled: () => Boolean(activeEditor()), checked: () => $navigationPane.get(), run: () => showNavigationPane(!$navigationPane.get()) }
]
