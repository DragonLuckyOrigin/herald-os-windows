import { t as uiT } from '../../../store/i18n.ts'
import type { Editor } from '@tiptap/core'
import { CellSelection } from '@tiptap/pm/tables'
import type { MenuItemDef } from '../../files/Menu.tsx'

/* What can be done to the table at the selection: rows, columns, merging, the header row, borders. */

export interface TableAction {
  id: string
  label: string
  enabled: (editor: Editor) => boolean
  checked?: (editor: Editor) => boolean
  run: (editor: Editor) => void
  dividerBefore?: boolean
}

const firstRowIsHeader = (editor: Editor): boolean => {
  const { $from } = editor.state.selection

  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)

    if (node.type.name === 'table') {
      const row = node.firstChild

      return Boolean(row && row.childCount && [...Array(row.childCount).keys()].every((index) => row.child(index).type.name === 'tableHeader'))
    }
  }

  return false
}

const bordersOn = (editor: Editor): boolean => editor.getAttributes('table').borders !== false

export const TABLE_ACTIONS: readonly TableAction[] = [
  { id: 'row-above', get label() { return uiT("ui.a6c1f35ccb5a") }, enabled: (editor) => editor.can().addRowBefore(), run: (editor) => editor.chain().focus().addRowBefore().run() },
  { id: 'row-below', get label() { return uiT("ui.928ae5db553d") }, enabled: (editor) => editor.can().addRowAfter(), run: (editor) => editor.chain().focus().addRowAfter().run() },
  { id: 'col-left', get label() { return uiT("ui.ca764f106c30") }, enabled: (editor) => editor.can().addColumnBefore(), run: (editor) => editor.chain().focus().addColumnBefore().run() },
  { id: 'col-right', get label() { return uiT("ui.c56e17b4d400") }, enabled: (editor) => editor.can().addColumnAfter(), run: (editor) => editor.chain().focus().addColumnAfter().run() },
  { id: 'delete-row', get label() { return uiT("ui.43654c6556c7") }, enabled: (editor) => editor.can().deleteRow(), run: (editor) => editor.chain().focus().deleteRow().run(), dividerBefore: true },
  { id: 'delete-col', get label() { return uiT("ui.f4ede32c5528") }, enabled: (editor) => editor.can().deleteColumn(), run: (editor) => editor.chain().focus().deleteColumn().run() },
  { id: 'merge', get label() { return uiT("ui.398456d6a82b") }, enabled: (editor) => editor.state.selection instanceof CellSelection && editor.can().mergeCells(), run: (editor) => editor.chain().focus().mergeCells().run(), dividerBefore: true },
  { id: 'split', get label() { return uiT("ui.b18b3e4759fd") }, enabled: (editor) => editor.can().splitCell(), run: (editor) => editor.chain().focus().splitCell().run() },
  { id: 'header', get label() { return uiT("ui.42b9e2612ed8") }, enabled: (editor) => editor.can().toggleHeaderRow(), checked: firstRowIsHeader, run: (editor) => editor.chain().focus().toggleHeaderRow().run(), dividerBefore: true },
  { id: 'borders', get label() { return uiT("ui.0de9f358ad56") }, enabled: (editor) => editor.isActive('table'), checked: bordersOn, run: (editor) => editor.chain().focus().updateAttributes('table', { borders: !bordersOn(editor) }).run() },
  { id: 'delete-table', get label() { return uiT("ui.8e5eac659f83") }, enabled: (editor) => editor.can().deleteTable(), run: (editor) => editor.chain().focus().deleteTable().run(), dividerBefore: true }
]

export const tableMenu = (editor: Editor): MenuItemDef[] =>
  TABLE_ACTIONS.map((action) => ({ id: action.id, label: action.label, disabled: !action.enabled(editor), checked: action.checked?.(editor), dividerBefore: action.dividerBefore, onSelect: () => action.run(editor) }))
