import { t } from '../store/i18n.ts'
import { hostPlatform } from '../lib/platform-labels.ts'
import { $prefs, updatePrefs } from '../store/backend.ts'
import { $dictation, toggleDictation } from '../store/dictation.ts'
import { openEmojiPicker } from '../store/emoji.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { isMainSurface, relayToMain } from '../store/shell.ts'

/* Typing helpers that work in every app: dictation, the emoji picker and the keyboard layout. */

export const typingCommands: readonly OsCommand[] = [
  {
    id: 'dictation.toggle',
    title: 'Dictate',
    description: 'Start dictation (or finish it): what you say next is typed into the focused app, with spoken punctuation. It ends by itself after a pause.',
    tier: 'act',
    args: [],
    phrases: ['start dictation', 'dictate into this app', 'stop dictation'],
    phrasesDe: ["starte das diktieren","starte diktieren in dieser app","beende das diktieren"],
    run: async () => {
      if (!isMainSurface) {
        relayToMain({ type: 'dictate' })

        return ok(t('commands.result.dictation.toggled'))
      }

      const wasListening = $dictation.get().phase === 'listening'
      toggleDictation()

      return ok(wasListening ? t('commands.result.dictation.finishing') : t('commands.result.dictation.listening'))
    }
  },
  {
    id: 'emoji.pick',
    title: 'Emoji',
    description: 'Open the emoji picker; the pick is typed into the field you were in.',
    tier: 'act',
    args: [],
    phrases: ['emoji', 'insert an emoji', 'open the emoji picker'],
    phrasesDe: ["emoji","füge ein emoji ein","öffne die emoji auswahl"],
    run: async () => {
      openEmojiPicker()

      return ok(t('commands.result.emoji.open'))
    }
  },
  {
    id: 'keymap.set',
    title: 'Keyboard layout',
    description: "Herald OS Linux: Herald's keys, or the Omarchy keymap where Super+C, X and V copy, cut and paste in every app (voice moves to Super+Shift+V).",
    tier: 'mutate',
    args: [{ name: 'keymap', type: 'string', description: 'herald or omarchy', required: true, enum: ['herald', 'omarchy'] }],
    phrases: [
      { phrase: 'use the omarchy keymap', args: { keymap: 'omarchy' } },
      { phrase: 'use the herald keymap', args: { keymap: 'herald' } }
    ],
    phrasesDe: [{"phrase":"nutze die omarchy tastenbelegung","args":{"keymap":"omarchy"}},{"phrase":"nutze die herald tastenbelegung","args":{"keymap":"herald"}}],
    run: async ({ keymap }) => {
      if (hostPlatform() !== 'linux') {
        return fail(t('commands.result.keymap.platform'))
      }

      const next = keymap === 'omarchy' ? 'omarchy' : 'herald'

      if (($prefs.get().keymap ?? 'herald') !== next) {
        await updatePrefs({ keymap: next })
      }

      return ok(next === 'omarchy' ? t('commands.result.keymap.omarchy') : t('commands.result.keymap.herald'), { highlight: { kind: 'setting', id: 'general' } })
    }
  }
]
