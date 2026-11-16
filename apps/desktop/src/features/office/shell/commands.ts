import { t as uiT } from '../../../store/i18n.ts'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { matches } from '../../../lib/shortcuts.ts'
import type { OfficeSession } from '../session.ts'

/*
 * The menus every Office app shares (File and Edit) and the app's own, in one table with their
 * shortcuts. The file shortcuts work while typing in a document, as they do in other office apps.
 */

export interface OfficeCommand {
  id: string
  label: string
  /** `mod` is ⌘ on the Mac and Ctrl elsewhere. */
  shortcut?: string
  run: () => void
  enabled?: () => boolean
  checked?: () => boolean
  dividerBefore?: boolean
  submenu?: OfficeCommand[]
}

export interface OfficeMenu {
  id: string
  label: string
  items: OfficeCommand[]
}

/** What the shared menus need from the app: its session, and its own commands by menu. */
export interface MenuSource<Model> {
  session: OfficeSession<Model>
  /** Commands added to File (after Export), Edit (after Redo), and menus of the app's own. */
  file?: OfficeCommand[]
  edit?: OfficeCommand[]
  menus?: OfficeMenu[]
  /** Whether the app opens and saves any format here (Slides does neither until .pptx). */
  canOpen?: boolean
  canSave: boolean
  /** What File > New does instead of making a blank document (Herald Docs' template gallery). */
  onNew?: () => void
}

export function officeMenus<Model>(source: MenuSource<Model>): OfficeMenu[] {
  const { session } = source
  const doc = () => session.active()
  const hasDoc = () => Boolean(doc())

  return [
    {
      id: 'file',
      label: uiT("ui.50009ce1da4d"),
      items: [
        { id: 'new', label: uiT("ui.18fdd549b2ed"), shortcut: 'mod+n', run: source.onNew ?? (() => session.create()) },
        { id: 'open', label: uiT("ui.1f1d592bdd1a"), shortcut: 'mod+o', enabled: () => source.canOpen !== false, run: () => void session.openPicked() },
        { id: 'save', label: uiT("ui.1509f561f241"), shortcut: 'mod+s', enabled: () => hasDoc() && source.canSave, run: () => void session.save().catch(() => {}), dividerBefore: true },
        { id: 'save-as', label: uiT("ui.a4b76af59533"), shortcut: 'mod+shift+s', enabled: () => hasDoc() && source.canSave, run: () => void session.save(doc(), { as: true }).catch(() => {}) },
        { id: 'export-pdf', label: uiT("ui.95fbb41bf5a3"), enabled: hasDoc, run: () => void session.exportPdf() },
        { id: 'print', label: uiT("ui.07c371255954"), shortcut: 'mod+p', enabled: hasDoc, run: () => void session.print() },
        ...(source.file ?? []),
        {
          id: 'notes',
          label: uiT("ui.2be7bdb6906b"),
          enabled: () => Boolean(doc()?.notes.length),
          run: () => {
            const active = doc()

            if (active) {
              session.$dialog.set({ kind: 'notes', title: uiT("ui.1fb6cc4af17a", { value1: String(active.name) }), notes: active.notes })
            }
          },
          dividerBefore: true
        },
        { id: 'close', label: uiT("ui.7d9eb7acb13e"), shortcut: 'mod+w', enabled: hasDoc, run: () => session.$dialog.set({ kind: 'close', key: doc()!.key }), dividerBefore: true }
      ]
    },
    {
      id: 'edit',
      label: uiT("ui.464c4ffd019e"),
      items: [{ id: 'undo', label: uiT("ui.a8283ade3185"), enabled: hasDoc, run: () => doc()?.editor?.undo() }, { id: 'redo', label: uiT("ui.74273989b096"), enabled: hasDoc, run: () => doc()?.editor?.redo() }, ...(source.edit ?? [])]
    },
    ...(source.menus ?? [])
  ]
}

const everyCommand = (commands: readonly OfficeCommand[]): OfficeCommand[] => commands.flatMap((command) => [command, ...everyCommand(command.submenu ?? [])])

/** Run the command a key press is for; true when one ran. */
export function runShortcut(event: KeyboardEvent | ReactKeyboardEvent, menus: readonly OfficeMenu[]): boolean {
  for (const menu of menus) {
    for (const command of everyCommand(menu.items)) {
      if (command.shortcut && matches(event, command.shortcut) && (command.enabled?.() ?? true)) {
        command.run()

        return true
      }
    }
  }

  return false
}
