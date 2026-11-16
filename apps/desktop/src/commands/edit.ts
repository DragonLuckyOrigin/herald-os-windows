import type { KeyModifier } from '../../shared/ipc.ts'
import { parseDictationText, withLeadingSpace } from '../lib/voice/dictation.ts'
import { charBeforeCaret, NoEditTargetError, performEdit, scrollFront } from '../store/edit-target.ts'
import { t } from '../store/i18n.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'

/*
 * Typing and editing: what the keyboard does, by voice or by Hermes. Everything lands on the focused
 * text field, the terminal, or the web page in front (see store/edit-target.ts).
 */

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const WORD_MOD: KeyModifier = isMac ? 'alt' : 'control'
const LINE_MOD: KeyModifier = isMac ? 'meta' : 'control'

async function edit(run: () => Promise<{ target: string }>, done: (target: string) => string) {
  try {
    const { target } = await run()

    // The caption says exactly what happened; the voice just confirms.
    return ok(done(target), { spoken: t('commands.msg.edit.done') })
  } catch (error) {
    return fail(error instanceof NoEditTargetError ? error.message : error instanceof Error ? error.message : String(error))
  }
}

/** The Herald Docs page, Sheets cell or Slides text box in front takes the words itself (one step to undo); null leaves them to the focused field. */
async function typeInOffice(text: string, submit: boolean): Promise<string | null> {
  try {
    const { typeIntoOffice } = await import('../features/office/typing.ts')

    return await typeIntoOffice(text, { submit })
  } catch {
    return null
  }
}

const KEY_ALIASES: Record<string, { key: string; modifiers?: KeyModifier[] }> = {
  enter: { key: 'enter' },
  return: { key: 'enter' },
  tab: { key: 'tab' },
  escape: { key: 'escape' },
  esc: { key: 'escape' },
  backspace: { key: 'backspace' },
  delete: { key: 'backspace' },
  space: { key: 'space' },
  'space bar': { key: 'space' },
  up: { key: 'up' },
  'up arrow': { key: 'up' },
  down: { key: 'down' },
  'down arrow': { key: 'down' },
  left: { key: 'left' },
  'left arrow': { key: 'left' },
  right: { key: 'right' },
  'right arrow': { key: 'right' },
  home: { key: 'home' },
  end: { key: 'end' },
  'page up': { key: 'pageup' },
  'page down': { key: 'pagedown' },
  'control c': { key: 'c', modifiers: ['control'] },
  'control d': { key: 'd', modifiers: ['control'] },
  'control l': { key: 'l', modifiers: ['control'] }
}

export const KEY_NAMES: readonly string[] = Object.keys(KEY_ALIASES)

/** The German names of the same keys, understood in addition to the English ones. */
const KEY_ALIASES_DE: Record<string, { key: string; modifiers?: KeyModifier[] }> = {
  eingabe: { key: 'enter' },
  eingabetaste: { key: 'enter' },
  tabulator: { key: 'tab' },
  tabulatortaste: { key: 'tab' },
  escape: { key: 'escape' },
  leertaste: { key: 'space' },
  leerzeichen: { key: 'space' },
  rücktaste: { key: 'backspace' },
  'pfeil nach oben': { key: 'up' },
  'pfeil nach unten': { key: 'down' },
  'pfeil nach links': { key: 'left' },
  'pfeil nach rechts': { key: 'right' },
  pos1: { key: 'home' },
  ende: { key: 'end' },
  'bild nach oben': { key: 'pageup' },
  'bild nach unten': { key: 'pagedown' },
  'strg c': { key: 'c', modifiers: ['control'] },
  'strg d': { key: 'd', modifiers: ['control'] },
  'strg l': { key: 'l', modifiers: ['control'] }
}

export const editCommands: readonly OsCommand[] = [
  {
    id: 'text.type',
    title: 'Type text',
    description: 'Type text into the focused field, the terminal or the web page; with Herald Docs, Sheets or Slides in front, at the caret, into the active cell (then down the column) or into the text box being edited or selected (else a new one). Say "comma", "question mark", "new line" for punctuation; end with "and press enter" to submit.',
    tier: 'mutate',
    args: [
      { name: 'text', type: 'string', description: 'What to type', required: true },
      { name: 'submit', type: 'boolean', description: 'Press Enter afterwards' }
    ],
    phrases: ['type {text}', 'dictate {text}', 'type in {text}', 'write down {text}'],
    phrasesDe: ['tippe {text}', 'diktiere {text}', 'schreibe auf {text}', 'schreib auf {text}'],
    run: async ({ text, submit }) => {
      const parsed = parseDictationText(String(text))
      const pressEnter = Boolean(submit) || parsed.submit
      const office = await typeInOffice(parsed.text, pressEnter)

      if (office) {
        return ok(office, { spoken: t('commands.msg.edit.done') })
      }

      const insert = withLeadingSpace(charBeforeCaret(), parsed.text)

      if (parsed.text && !insert && !pressEnter) {
        return ok(t('commands.msg.edit.alreadyAfter', { text: parsed.text }), { spoken: t('commands.msg.edit.done') })
      }

      return edit(
        async () => {
          const result = insert ? await performEdit({ kind: 'insert', text: insert }, { needsField: true }) : { target: '' }

          if (pressEnter) {
            return performEdit({ kind: 'key', key: 'enter' }, { needsField: true })
          }

          return result
        },
        target => t(pressEnter ? 'commands.msg.edit.typedEnter' : 'commands.msg.edit.typed', { text: parsed.text.slice(0, 60), target })
      )
    }
  },
  {
    id: 'key.press',
    title: 'Press a key',
    description: 'Press Enter, Tab, Escape, Backspace, an arrow key, Page Up/Down, Home/End, or Control-C/D/L.',
    tier: 'mutate',
    args: [{ name: 'key', type: 'string', description: 'Key name (enter, tab, escape, backspace, up, down, left, right, page down, control c, …)', required: true }],
    phrases: ['press {key}', 'hit {key}', 'press the {key} key', 'hit the {key} key', { phrase: 'send it', args: { key: 'enter' } }, { phrase: 'submit', args: { key: 'enter' } }, { phrase: 'press enter', args: { key: 'enter' } }],
    phrasesDe: ['drücke {key}', 'drücke die taste {key}', 'drücke die {key} taste', { phrase: 'schicke es ab', args: { key: 'enter' } }, { phrase: 'absenden', args: { key: 'enter' } }, { phrase: 'drücke enter', args: { key: 'enter' } }, { phrase: 'drücke die eingabetaste', args: { key: 'enter' } }],
    run: ({ key }) => {
      const name = String(key).toLowerCase().replace(/\s+(key|taste)$/, '').trim()
      const alias = KEY_ALIASES[name] ?? KEY_ALIASES_DE[name]

      if (!alias) {
        return fail(t('commands.msg.edit.unknownKey', { key: String(key) }))
      }

      return edit(
        () => performEdit({ kind: 'key', key: alias.key, modifiers: alias.modifiers }, { needsField: true }),
        target => t('commands.msg.edit.pressed', { key: String(key), target })
      )
    }
  },
  {
    id: 'text.newLine',
    title: 'New line',
    description: 'Start a new line without sending (Shift+Enter).',
    tier: 'mutate',
    args: [],
    phrases: ['new line', 'next line', 'line break'],
    phrasesDe: ['neue zeile', 'nächste zeile', 'zeilenumbruch'],
    run: () => edit(() => performEdit({ kind: 'key', key: 'enter', modifiers: ['shift'] }, { needsField: true }), target => t('commands.msg.edit.newLine', { target }))
  },
  {
    id: 'edit.selectAll',
    title: 'Select all',
    description: 'Select everything in the focused field or page.',
    tier: 'act',
    args: [],
    phrases: ['select all', 'select everything', 'select all the text', 'select all text'],
    phrasesDe: ['wähle alles aus', 'alles auswählen', 'markiere alles', 'wähle den ganzen text aus', 'markiere den ganzen text'],
    run: () => edit(() => performEdit({ kind: 'selectAll' }), target => t('commands.msg.edit.selectedAll', { target }))
  },
  {
    id: 'edit.select',
    title: 'Select a word or line',
    description: 'Extend the selection back by a word or to the start of the line.',
    tier: 'act',
    args: [{ name: 'scope', type: 'string', description: 'word or line', required: true, enum: ['word', 'line'], aliases: { wort: 'word', zeile: 'line' } }],
    phrases: [
      { phrase: 'select the last word', args: { scope: 'word' } },
      { phrase: 'select the previous word', args: { scope: 'word' } },
      { phrase: 'select word', args: { scope: 'word' } },
      { phrase: 'select the line', args: { scope: 'line' } },
      { phrase: 'select the whole line', args: { scope: 'line' } },
      { phrase: 'select line', args: { scope: 'line' } }
    ],
    phrasesDe: [
      { phrase: 'wähle das letzte wort aus', args: { scope: 'word' } },
      { phrase: 'wähle das vorherige wort aus', args: { scope: 'word' } },
      { phrase: 'wähle wort aus', args: { scope: 'word' } },
      { phrase: 'wähle die zeile aus', args: { scope: 'line' } },
      { phrase: 'wähle die ganze zeile aus', args: { scope: 'line' } },
      { phrase: 'wähle zeile aus', args: { scope: 'line' } }
    ],
    run: ({ scope }) =>
      edit(
        () => performEdit({ kind: 'key', key: 'left', modifiers: ['shift', scope === 'line' ? LINE_MOD : WORD_MOD] }, { needsField: true }),
        target => t(scope === 'line' ? 'commands.msg.edit.selectedLine' : 'commands.msg.edit.selectedWord', { target })
      )
  },
  {
    id: 'edit.deselect',
    title: 'Deselect',
    description: 'Clear the selection.',
    tier: 'act',
    args: [],
    phrases: ['deselect', 'unselect', 'clear the selection', 'select nothing'],
    phrasesDe: ['auswahl aufheben', 'markierung aufheben', 'hebe die auswahl auf', 'wähle nichts aus'],
    run: () => edit(() => performEdit({ kind: 'unselect' }), target => t('commands.msg.edit.deselected', { target }))
  },
  {
    id: 'edit.copy',
    title: 'Copy',
    description: 'Copy the selection to the clipboard.',
    tier: 'act',
    args: [],
    phrases: ['copy', 'copy that', 'copy it', 'copy this', 'copy the selection'],
    phrasesDe: ['kopiere', 'kopiere das', 'kopiere es', 'kopiere dies', 'kopiere die auswahl'],
    run: () => edit(() => performEdit({ kind: 'copy' }), () => t('commands.msg.edit.copied'))
  },
  {
    id: 'edit.cut',
    title: 'Cut',
    description: 'Cut the selection to the clipboard.',
    tier: 'mutate',
    args: [],
    phrases: ['cut', 'cut that', 'cut it', 'cut this', 'cut the selection'],
    phrasesDe: ['ausschneiden', 'schneide aus', 'schneide das aus', 'schneide es aus', 'schneide die auswahl aus'],
    run: () => edit(() => performEdit({ kind: 'cut' }, { needsField: true }), target => t('commands.msg.edit.cut', { target }))
  },
  {
    id: 'edit.paste',
    title: 'Paste',
    description: 'Paste the clipboard into the focused field, terminal or page.',
    tier: 'mutate',
    args: [],
    phrases: ['paste', 'paste that', 'paste it', 'paste here', 'paste the clipboard'],
    phrasesDe: ['einfügen', 'füge ein', 'füge das ein', 'füge es ein', 'füge hier ein', 'füge die zwischenablage ein'],
    run: () => edit(() => performEdit({ kind: 'paste' }, { needsField: true }), target => t('commands.msg.edit.pasted', { target }))
  },
  {
    id: 'edit.undo',
    title: 'Undo',
    description: 'Undo the last edit.',
    tier: 'mutate',
    args: [],
    phrases: ['undo', 'undo that', 'undo it', 'take that back'],
    phrasesDe: ['rückgängig', 'mach das rückgängig', 'mache das rückgängig', 'mach es rückgängig', 'nimm das zurück'],
    run: () => edit(() => performEdit({ kind: 'undo' }), target => t('commands.msg.edit.undid', { target }))
  },
  {
    id: 'edit.redo',
    title: 'Redo',
    description: 'Redo the last undone edit.',
    tier: 'mutate',
    args: [],
    phrases: ['redo', 'redo that', 'redo it'],
    phrasesDe: ['wiederholen', 'wiederhole das', 'stelle das wieder her'],
    run: () => edit(() => performEdit({ kind: 'redo' }), target => t('commands.msg.edit.redid', { target }))
  },
  {
    id: 'edit.delete',
    title: 'Delete',
    description: 'Delete the selection or the character before the cursor; "the last word" deletes a word; "clear" empties the field.',
    tier: 'mutate',
    args: [{ name: 'what', type: 'string', description: 'selection, word or all', enum: ['selection', 'word', 'all'], aliases: { auswahl: 'selection', wort: 'word', alles: 'all' } }],
    phrases: [
      { phrase: 'delete that', args: { what: 'selection' } },
      { phrase: 'delete it', args: { what: 'selection' } },
      { phrase: 'delete', args: { what: 'selection' } },
      { phrase: 'erase that', args: { what: 'selection' } },
      { phrase: 'backspace', args: { what: 'selection' } },
      { phrase: 'delete the last word', args: { what: 'word' } },
      { phrase: 'delete the previous word', args: { what: 'word' } },
      { phrase: 'delete word', args: { what: 'word' } },
      { phrase: 'clear the field', args: { what: 'all' } },
      { phrase: 'clear it', args: { what: 'all' } },
      { phrase: 'clear the text', args: { what: 'all' } },
      { phrase: 'clear everything', args: { what: 'all' } },
      { phrase: 'delete everything', args: { what: 'all' } }
    ],
    phrasesDe: [
      { phrase: 'lösche das', args: { what: 'selection' } },
      { phrase: 'lösche es', args: { what: 'selection' } },
      { phrase: 'lösche die auswahl', args: { what: 'selection' } },
      { phrase: 'entferne das', args: { what: 'selection' } },
      { phrase: 'rücktaste', args: { what: 'selection' } },
      { phrase: 'lösche das letzte wort', args: { what: 'word' } },
      { phrase: 'lösche das vorherige wort', args: { what: 'word' } },
      { phrase: 'lösche wort', args: { what: 'word' } },
      { phrase: 'leere das feld', args: { what: 'all' } },
      { phrase: 'leere es', args: { what: 'all' } },
      { phrase: 'leere den text', args: { what: 'all' } },
      { phrase: 'alles im feld löschen', args: { what: 'all' } }
    ],
    run: ({ what }) =>
      edit(
        async () => {
          if (what === 'all') {
            await performEdit({ kind: 'selectAll' }, { needsField: true })
          }

          return performEdit({ kind: 'key', key: 'backspace', modifiers: what === 'word' ? [WORD_MOD] : [] }, { needsField: true })
        },
        target => t(what === 'all' ? 'commands.msg.edit.clearedAll' : what === 'word' ? 'commands.msg.edit.deletedWord' : 'commands.msg.edit.deleted', { target })
      )
  },
  {
    id: 'view.scroll',
    title: 'Scroll',
    description: 'Scroll the frontmost window up, down, to the top or to the bottom.',
    tier: 'read',
    args: [{ name: 'direction', type: 'string', description: 'up, down, top or bottom', required: true, enum: ['down', 'up', 'top', 'bottom'], aliases: { runter: 'down', unten: 'down', hoch: 'up', oben: 'up', anfang: 'top', ende: 'bottom' } }],
    phrases: [
      { phrase: 'scroll down', args: { direction: 'down' } },
      { phrase: 'scroll up', args: { direction: 'up' } },
      { phrase: 'page down', args: { direction: 'down' } },
      { phrase: 'page up', args: { direction: 'up' } },
      { phrase: 'scroll to the top', args: { direction: 'top' } },
      { phrase: 'go to the top', args: { direction: 'top' } },
      { phrase: 'scroll to the bottom', args: { direction: 'bottom' } },
      { phrase: 'go to the bottom', args: { direction: 'bottom' } }
    ],
    phrasesDe: [
      { phrase: 'scrolle nach unten', args: { direction: 'down' } },
      { phrase: 'scrolle runter', args: { direction: 'down' } },
      { phrase: 'seite nach unten', args: { direction: 'down' } },
      { phrase: 'scrolle nach oben', args: { direction: 'up' } },
      { phrase: 'scrolle hoch', args: { direction: 'up' } },
      { phrase: 'seite nach oben', args: { direction: 'up' } },
      { phrase: 'scrolle ganz nach oben', args: { direction: 'top' } },
      { phrase: 'gehe ganz nach oben', args: { direction: 'top' } },
      { phrase: 'gehe zum anfang', args: { direction: 'top' } },
      { phrase: 'scrolle ganz nach unten', args: { direction: 'bottom' } },
      { phrase: 'gehe ganz nach unten', args: { direction: 'bottom' } },
      { phrase: 'gehe zum ende', args: { direction: 'bottom' } }
    ],
    run: ({ direction }) => {
      if (!scrollFront(direction as 'up' | 'down' | 'top' | 'bottom')) {
        return fail(t('commands.msg.edit.nothingScrolls'))
      }

      return ok(direction === 'up' ? t('commands.msg.edit.scrolledUp') : direction === 'top' ? t('commands.msg.edit.scrolledTop') : direction === 'bottom' ? t('commands.msg.edit.scrolledBottom') : t('commands.msg.edit.scrolledDown'))
    }
  }
]
