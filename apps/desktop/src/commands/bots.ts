import { findBot } from '../lib/bots.ts'
import { $bots, $newChatBot, focusBots, refreshBots, startConversation } from '../store/bots.ts'
import { t } from '../store/i18n.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { showPage } from '../store/windows.ts'

/* The bots a conversation can run as: Hermes itself and the other Hermes profiles (lib/bots.ts). */

/** "Hermes, Alfred and Sally". */
const listed = (names: readonly string[]): string => (names.length > 1 ? t('commands.msg.bots.listJoin', { first: names.slice(0, -1).join(', '), last: names.at(-1) ?? '' }) : (names[0] ?? ''))

/** The bot a name means, asking the gateway again when the roster has no such bot yet (one made since it was read). */
async function lookUp(name: string): Promise<ReturnType<typeof findBot>> {
  const cached = findBot($bots.get(), name)

  return cached.bot || cached.candidates.length > 1 ? cached : findBot(await refreshBots(), name)
}

export const botCommands: readonly OsCommand[] = [
  {
    id: 'bots.list',
    title: 'List bots',
    description: "The bots a conversation can run as (every Hermes profile, Hermes itself first) and the one new conversations run as, shown in the Hermes page's New conversation menu.",
    tier: 'read',
    args: [],
    phrases: ['which bots do i have', 'list my bots', 'show my bots', 'what bots do i have'],
    phrasesDe: ['welche bots habe ich', 'liste meine bots auf', 'zeige meine bots', 'was für bots habe ich'],
    run: async () => {
      const bots = await refreshBots()
      const next = $newChatBot.get()
      const items = bots.map(bot => ({ profile: bot.profile, name: bot.name, description: bot.description, current: bot.profile === next.profile }))

      if (bots.length < 2) {
        return ok(t('commands.msg.bots.onlyHermes'), { spoken: t('commands.msg.bots.onlyHermesSpoken'), items })
      }

      showPage('hermes')
      focusBots()

      return ok(t('commands.msg.bots.list', { count: bots.length, names: listed(bots.map(bot => bot.name)), name: next.name }), { page: 'hermes', items })
    }
  },
  {
    id: 'bots.chat',
    title: 'Talk to a bot',
    description: 'Start a new conversation with one of your bots (a Hermes profile) and show it. New conversations run as that bot from then on, until another is chosen.',
    tier: 'act',
    args: [{ name: 'bot', type: 'string', description: 'The bot by its name or profile: Alfred, mark, Hermes', required: true }],
    phrases: ['talk to {bot}', 'chat with {bot}', 'start a conversation with {bot}', 'new conversation with {bot}', 'new chat with {bot}'],
    phrasesDe: ['sprich mit {bot}', 'chatte mit {bot}', 'starte ein gespräch mit {bot}', 'neues gespräch mit {bot}', 'neuer chat mit {bot}'],
    run: async ({ bot: name }) => {
      const { bot, candidates } = await lookUp(String(name))

      if (!bot) {
        const names = candidates.map(candidate => candidate.name)

        return names.length > 1 ? fail(t('commands.msg.bots.which', { names: `${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}` }), { items: names }) : fail(t('commands.msg.bots.noBot', { name: String(name) }))
      }

      const chat = await startConversation(bot.profile)
      showPage('hermes')

      return ok(t('commands.msg.bots.started', { name: bot.name }), { page: 'hermes', data: { sessionId: chat.sessionId, bot: bot.profile } })
    }
  }
]
