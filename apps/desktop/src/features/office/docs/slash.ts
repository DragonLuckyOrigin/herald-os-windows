import { t as uiT } from '../../../store/i18n.ts'
import { type Editor, Extension, type Range } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'
import { atom } from 'nanostores'
import type { CalloutKind } from '../../../../shared/office/document.ts'
import { isMac } from '../../../lib/shortcuts.ts'
import { applyLive, insertPageBreak, insertTable, setStyle } from './model.ts'

/*
 * The '/' menu: type a slash at the start of a line or after a space, then a few letters of what
 * to insert ("h2", "todo", "warn"), as in Confluence. Each item answers to its name and to the
 * words people reach for.
 */

export interface SlashItem {
  id: string
  label: string
  hint: string
  /** Words it answers to besides its label. */
  aliases: string[]
  group: 'Text' | 'Lists' | 'Insert' | 'Panels'
  run: (editor: Editor) => void
}

const callout = (kind: CalloutKind) => (editor: Editor) => {
  editor
    .chain()
    .focus()
    .wrapIn('callout', { kind })
    .run()
}

/** Pictures come from a file picker the window owns. */
export const $pickImage = atom<number>(0)

export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: 'text', get label() { return uiT("ui.71988c4d8e08") }, get hint() { return uiT("ui.ec88d0c7e206") }, aliases: ['normal', 'paragraph', 'p', 'body'], group: 'Text', run: (editor) => applyLive(editor.view, setStyle('normal')) },
  { id: 'heading1', get label() { return uiT("office.block.heading1") }, get hint() { return uiT("ui.2c50c6432f65") }, aliases: ['h1', '#', 'heading', 'title', 'section'], group: 'Text', run: (editor) => applyLive(editor.view, setStyle('heading1')) },
  { id: 'heading2', get label() { return uiT("office.block.heading2") }, get hint() { return uiT("ui.f39bd9f1de84") }, aliases: ['h2', '##', 'subheading', 'heading'], group: 'Text', run: (editor) => applyLive(editor.view, setStyle('heading2')) },
  { id: 'heading3', get label() { return uiT("office.block.heading3") }, get hint() { return uiT("ui.1768a9c109fb") }, aliases: ['h3', '###', 'heading'], group: 'Text', run: (editor) => applyLive(editor.view, setStyle('heading3')) },
  { id: 'title', get label() { return uiT("ui.7e8cd2056da7") }, get hint() { return uiT("ui.02c6aae53dd9") }, aliases: ['doc title', 'name'], group: 'Text', run: (editor) => applyLive(editor.view, setStyle('title')) },
  { id: 'subtitle', get label() { return uiT("ui.383cd6c0b871") }, get hint() { return uiT("ui.480e0b1d22a0") }, aliases: ['tagline', 'strapline'], group: 'Text', run: (editor) => applyLive(editor.view, setStyle('subtitle')) },
  { id: 'quote', get label() { return uiT("ui.eb4cdebd82bf") }, get hint() { return uiT("ui.0a4c81a06e76") }, aliases: ['blockquote', 'citation', 'cite', '>'], group: 'Text', run: (editor) => applyLive(editor.view, setStyle('quote')) },
  { id: 'code', get label() { return uiT("ui.7545380a2996") }, get hint() { return uiT("ui.6909f410d4f4") }, aliases: ['code', 'pre', 'snippet', 'source', '```'], group: 'Text', run: (editor) => editor.chain().focus().setCodeBlock().run() },
  { id: 'bullets', get label() { return uiT("ui.ce51b395cd6b") }, get hint() { return uiT("ui.1b197e0e6e80") }, aliases: ['bullet', 'ul', 'unordered', 'list', '-', '*'], group: 'Lists', run: (editor) => editor.chain().focus().toggleBulletList().run() },
  { id: 'numbers', get label() { return uiT("ui.cc62f6c7b2a8") }, get hint() { return uiT("ui.6f42531c2252") }, aliases: ['ordered', 'ol', 'number', 'numbers', '1.'], group: 'Lists', run: (editor) => editor.chain().focus().toggleOrderedList().run() },
  { id: 'tasks', get label() { return uiT("ui.7346030400bf") }, get hint() { return uiT("ui.aebf90937dc5") }, aliases: ['todo', 'to do', 'task', 'tasks', 'checkbox', 'check', '[]'], group: 'Lists', run: (editor) => editor.chain().focus().toggleTaskList().run() },
  { id: 'table', get label() { return uiT("ui.16d1c9050a0b") }, get hint() { return uiT("ui.e6444015ed0e") }, aliases: ['grid', 'tbl', 'columns', 'rows', 'spreadsheet'], group: 'Insert', run: (editor) => applyLive(editor.view, insertTable({ rows: 3, cols: 3 }, 'selection')) },
  { id: 'image', get label() { return uiT("ui.9a1c54f55e7c") }, get hint() { return uiT("ui.ed3aaecd5078", { value1: String(isMac ? 'Mac' : 'computer') }) }, aliases: ['image', 'img', 'photo', 'picture', 'screenshot'], group: 'Insert', run: () => $pickImage.set($pickImage.get() + 1) },
  { id: 'divider', get label() { return uiT("ui.cc29053ff492") }, get hint() { return uiT("ui.22cb6a107003") }, aliases: ['hr', 'rule', 'line', 'separator', '---'], group: 'Insert', run: (editor) => editor.chain().focus().setHorizontalRule().run() },
  { id: 'pagebreak', get label() { return uiT("ui.a59506aa431f") }, get hint() { return uiT("ui.691e57c6fd8b") }, aliases: ['break', 'new page', 'newpage', 'page'], group: 'Insert', run: (editor) => applyLive(editor.view, insertPageBreak()) },
  { id: 'info', get label() { return uiT("ui.4fa70af0e3ce") }, get hint() { return uiT("ui.14fb39ffa034") }, aliases: ['callout', 'panel', 'info', 'information', 'note'], group: 'Panels', run: callout('info') },
  { id: 'note', get label() { return uiT("ui.8844bc8ecc58") }, get hint() { return uiT("ui.401499ecebfe") }, aliases: ['callout', 'panel', 'note', 'important', 'remember'], group: 'Panels', run: callout('note') },
  { id: 'success', get label() { return uiT("ui.8f2bb06410d1") }, get hint() { return uiT("ui.02b1de5a92aa") }, aliases: ['callout', 'panel', 'success', 'tip', 'done', 'good'], group: 'Panels', run: callout('success') },
  { id: 'warning', get label() { return uiT("ui.586694ad8d28") }, get hint() { return uiT("ui.669a6ee8e14a") }, aliases: ['callout', 'panel', 'warning', 'warn', 'caution', 'alert'], group: 'Panels', run: callout('warning') },
  { id: 'error', get label() { return uiT("ui.9ac96252374c") }, get hint() { return uiT("ui.635bf00e225c") }, aliases: ['callout', 'panel', 'error', 'danger', 'stop', 'problem'], group: 'Panels', run: callout('error') }
]

/** The items for what was typed after the slash: names first, then words that start, then words that hold it. */
export function slashItems(query: string): SlashItem[] {
  const wanted = query.trim().toLowerCase()

  if (!wanted) {
    return [...SLASH_ITEMS]
  }

  const score = (item: SlashItem): number => {
    const label = item.label.toLowerCase()
    const words = [label, ...item.aliases]

    if (label.startsWith(wanted)) {
      return 3
    }

    if (words.some((word) => word.startsWith(wanted))) {
      return 2
    }

    return words.some((word) => word.includes(wanted)) ? 1 : 0
  }

  return SLASH_ITEMS.map((item) => ({ item, score: score(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item)
}

export interface SlashState {
  items: SlashItem[]
  index: number
  rect: DOMRect | null
  choose: (item: SlashItem) => void
}

/** The open '/' menu, if any (one editor types at a time). */
export const $slash = atom<SlashState | null>(null)

function bridge() {
  const show = (props: SuggestionProps<SlashItem, SlashItem>, index = 0) =>
    $slash.set({ items: props.items, index: Math.min(index, Math.max(0, props.items.length - 1)), rect: props.clientRect?.() ?? null, choose: (item) => props.command(item) })

  return {
    onStart: (props: SuggestionProps<SlashItem, SlashItem>) => show(props),
    onUpdate: (props: SuggestionProps<SlashItem, SlashItem>) => show(props, $slash.get()?.index ?? 0),
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      const state = $slash.get()

      if (!state) {
        return false
      }

      if (event.key === 'Escape') {
        $slash.set(null)

        return true
      }

      if (!state.items.length) {
        return false
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const step = event.key === 'ArrowDown' ? 1 : -1
        $slash.set({ ...state, index: (state.index + step + state.items.length) % state.items.length })

        return true
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        state.choose(state.items[state.index])

        return true
      }

      return false
    },
    onExit: () => $slash.set(null)
  }
}

export const slashKey = new PluginKey('docsSlash')

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: slashKey,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        allowedPrefixes: [' ', '\t', '\u00a0'],
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)

          return $from.parent.type.name !== 'codeBlock' && !$from.marks().some((mark) => mark.type.name === 'code')
        },
        items: ({ query }) => slashItems(query),
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) => {
          editor.chain().focus().deleteRange(range).run()
          props.run(editor)
        },
        render: bridge
      })
    ]
  }
})
