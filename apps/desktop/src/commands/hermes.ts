import { focusSettings } from '../features/settings/sections/shared.tsx'
import { botByProfile } from '../lib/bots.ts'
import { matchProvider, modelChangeScope } from '../lib/model-provider.ts'
import { pauseAllAgents } from '../store/agents-control.ts'
import { $bots, startConversation } from '../store/bots.ts'
import { $activeChat, $chats, interruptChat, openStoredSession, sendPrompt } from '../store/chat.ts'
import { requestHermesLogin } from '../store/hermes-auth.ts'
import { $activeMissions, $completedMissions, $missions, $reviewMissions, focusMissions, markReviewed, type Mission } from '../store/missions.ts'
import { startMission } from '../store/missions-actions.ts'
import { t } from '../store/i18n.ts'
import { focusProvider, modelErrorText, type ModelChange, readProviderChoices, switchToProvider } from '../store/model-provider.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { $sessions, refreshSessions } from '../store/sessions.ts'
import { readToolSearch, setToolSearch } from '../store/tool-search.ts'
import { voiceTargetSessionId } from '../store/voice.ts'
import { openApp, showPage } from '../store/windows.ts'

/* Chat sessions and missions, how Hermes reaches its tools, and the model provider it thinks with. */

function findMission(query: string): { mission: Mission | null; candidates: Mission[] } {
  const needle = query.trim().toLowerCase()
  const missions = $missions.get()

  if (!needle) {
    return { mission: null, candidates: missions }
  }

  const exact = missions.filter(m => m.title.toLowerCase() === needle)

  if (exact.length === 1) {
    return { mission: exact[0], candidates: exact }
  }

  const partial = missions.filter(m => m.title.toLowerCase().includes(needle) || m.goal.toLowerCase().includes(needle))

  return { mission: partial.length === 1 ? partial[0] : null, candidates: partial }
}

const WHICH = { session: 'commands.msg.hermes.whichSession', mission: 'commands.msg.hermes.whichMission', provider: 'commands.msg.hermes.whichProvider' } as const

const ambiguous = (what: keyof typeof WHICH, names: string[]) => fail(t(WHICH[what], { names: `${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}` }), { items: names })

export const hermesCommands: readonly OsCommand[] = [
  {
    id: 'chat.new',
    title: 'New chat',
    description: 'Start a new conversation and show it. It runs as the bot last chosen for new conversations: Hermes, unless bots.chat picked another.',
    tier: 'act',
    args: [{ name: 'title', type: 'string', description: 'Optional title' }],
    phrases: ['new chat', 'start a new chat', 'new conversation', 'new session'],
    phrasesDe: ['neuer chat', 'starte einen neuen chat', 'neue unterhaltung', 'starte eine neue unterhaltung', 'neue sitzung'],
    run: async ({ title }) => {
      const chat = await startConversation(undefined, { title: title ? String(title) : undefined })
      showPage('hermes')

      return ok(chat.profile ? t('commands.msg.hermes.newChatWith', { name: botByProfile($bots.get(), chat.profile).name }) : t('commands.msg.hermes.newChat'), { page: 'hermes', data: { sessionId: chat.sessionId } })
    }
  },
  {
    id: 'chat.open',
    title: 'Open a session',
    description: 'Open a past Hermes session by title.',
    tier: 'read',
    args: [{ name: 'title', type: 'string', description: 'Part of the session title', required: true }],
    phrases: ['open the chat about {title}', 'open my {title} session', 'open the conversation about {title}'],
    phrasesDe: ['öffne den chat über {title}', 'öffne meine {title} sitzung', 'öffne die unterhaltung über {title}'],
    run: async ({ title }) => {
      const needle = String(title).toLowerCase()
      let rows = $sessions.get()

      if (rows.length === 0) {
        await refreshSessions()
        rows = $sessions.get()
      }

      const matches = rows.filter(row => `${row.title ?? ''} ${row.preview ?? ''}`.toLowerCase().includes(needle))

      if (matches.length === 0) {
        return fail(t('commands.msg.hermes.noSession', { title: String(title) }))
      }

      const exact = matches.filter(row => (row.title ?? '').toLowerCase() === needle)
      const choices = exact.length ? exact : matches
      if (choices.length > 1) {
        return ambiguous(
          'session',
          choices.map(row => row.title || row.preview || row.id)
        )
      }

      const row = choices[0]
      showPage('hermes')
      const chat = await openStoredSession(row.id)

      return ok(t('commands.msg.hermes.sessionOpened', { title: row.title || row.preview || t('commands.msg.hermes.sessionFallback') }), { page: 'hermes', data: { sessionId: chat.sessionId } })
    }
  },
  {
    id: 'chat.stop',
    title: 'Stop Hermes',
    description: 'Interrupt the running turn in the active session.',
    tier: 'act',
    args: [],
    phrases: ['stop hermes', 'stop the current task', 'interrupt', 'cancel that'],
    phrasesDe: ['stoppe hermes', 'stoppe die aktuelle aufgabe', 'unterbrich', 'brich das ab'],
    run: async (_args, context) => {
      const target = context.source === 'voice' ? voiceTargetSessionId() : null
      const chat = context.source === 'voice' ? (target ? $chats.get()[target] : null) : $activeChat.get()

      if (!chat?.streaming) {
        return ok(t('commands.msg.hermes.nothingRunning'), { spoken: t('commands.msg.hermes.nothingRunningSpoken') })
      }

      await interruptChat(chat.sessionId)

      return ok(t('commands.msg.hermes.stopped'))
    }
  },
  {
    id: 'chat.popout',
    title: 'Pop out the chat',
    description: 'Open the active session in its own window.',
    tier: 'read',
    args: [],
    phrases: ['pop out the chat', 'open the chat in a window', 'chat popout'],
    phrasesDe: ['löse den chat heraus', 'öffne den chat in einem fenster', 'chat in eigenem fenster öffnen', 'chat popout'],
    run: () => {
      const chat = $activeChat.get()

      if (!chat) {
        return fail(t('commands.msg.hermes.noActiveSession'))
      }

      openApp('chat-popout', { payload: { sessionId: chat.storedSessionId, profile: chat.profile }, title: chat.title || botByProfile($bots.get(), chat.profile).name })

      return ok(t('commands.msg.hermes.poppedOut'))
    }
  },
  {
    id: 'chat.send',
    title: 'Ask Hermes',
    description: 'Send a message to Hermes in the active session.',
    tier: 'act',
    args: [{ name: 'text', type: 'string', description: 'The message', required: true }],
    hidden: true,
    run: async ({ text }) => {
      showPage('hermes')
      const sid = await sendPrompt(String(text))

      return ok(t('commands.msg.hermes.sent'), { page: 'hermes', data: { sessionId: sid } })
    }
  },
  {
    id: 'mission.start',
    title: 'Start a mission',
    description: 'Start a mission: Hermes plans the steps and works through them.',
    tier: 'mutate',
    args: [{ name: 'goal', type: 'string', description: 'What the mission should achieve', required: true }],
    phrases: ['start a mission to {goal}', 'new mission {goal}', 'create a mission to {goal}', 'start a mission: {goal}'],
    phrasesDe: ['starte eine mission um {goal}', 'neue mission {goal}', 'erstelle eine mission um {goal}', 'starte eine mission: {goal}'],
    run: async ({ goal }) => {
      const { sessionId, title } = await startMission(String(goal))

      return ok(t('commands.msg.hermes.missionStarted', { title }), { spoken: t('commands.msg.hermes.missionStartedSpoken'), page: 'hermes', data: { sessionId } })
    }
  },
  {
    id: 'mission.compose',
    title: 'New mission form',
    description: 'Open the Missions page with the new-mission form.',
    tier: 'read',
    args: [],
    phrases: ['new mission', 'start a mission', 'create a mission'],
    phrasesDe: ['neue mission', 'starte eine mission', 'erstelle eine mission'],
    hidden: true,
    run: () => {
      showPage('missions')
      focusMissions({ compose: true })

      return ok(t('commands.msg.hermes.missionForm'), { page: 'missions' })
    }
  },
  {
    id: 'mission.open',
    title: 'Open a mission',
    description: 'Show a mission by name on the Missions page.',
    tier: 'read',
    args: [{ name: 'name', type: 'string', description: 'Part of the mission title', required: true }],
    phrases: ['open the {name} mission', 'show the mission {name}', 'open mission {name}'],
    phrasesDe: ['öffne die mission {name}', 'zeige die mission {name}', 'öffne mission {name}', 'öffne die {name} mission'],
    run: ({ name }) => {
      const { mission, candidates } = findMission(String(name))

      if (!mission) {
        return candidates.length ? ambiguous('mission', candidates.map(m => m.title)) : fail(t('commands.msg.hermes.noMission', { name: String(name) }))
      }

      showPage('missions')
      focusMissions({ tab: mission.status, missionId: mission.id })

      return ok(t('commands.msg.hermes.showingMission', { title: mission.title }), { page: 'missions', highlight: { kind: 'mission', id: mission.id }, data: { status: mission.status, progress: mission.progress } })
    }
  },
  {
    id: 'mission.list',
    title: 'List missions',
    description: 'Summarise active missions and those waiting for review.',
    tier: 'read',
    args: [],
    phrases: ['what missions are running', 'list my missions', 'show my missions', 'how are my missions going'],
    phrasesDe: ['welche missionen laufen', 'liste meine missionen auf', 'wie laufen meine missionen', 'was machen meine missionen'],
    run: () => {
      const active = $activeMissions.get()
      const review = $reviewMissions.get()
      const completed = $completedMissions.get()
      showPage('missions')
      const summary = t('commands.msg.hermes.missionSummary', { active: active.length, review: review.length, completed: completed.length })

      return ok(summary, {
        page: 'missions',
        spoken: active.length ? t('commands.msg.hermes.missionSpokenActive', { summary, titles: active.map(m => m.title).slice(0, 3).join(', ') }) : t('commands.msg.hermes.missionSpoken', { summary }),
        items: [...active, ...review].map(m => ({ id: m.id, title: m.title, status: m.status, progress: m.progress, currentStep: m.currentStep }))
      })
    }
  },
  {
    id: 'mission.pause',
    title: 'Pause a mission',
    description: 'Interrupt a running mission.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Part of the mission title', required: true }],
    phrases: ['pause the {name} mission', 'stop the {name} mission'],
    phrasesDe: ['pausiere die mission {name}', 'stoppe die mission {name}', 'halte die mission {name} an'],
    run: async ({ name }) => {
      const { mission, candidates } = findMission(String(name))

      if (!mission) {
        return candidates.length ? ambiguous('mission', candidates.map(m => m.title)) : fail(t('commands.msg.hermes.noMission', { name: String(name) }))
      }

      if (!mission.runtimeId) {
        return fail(t('commands.msg.hermes.notRunning', { title: mission.title }))
      }

      await interruptChat(mission.runtimeId)
      showPage('missions')
      focusMissions({ missionId: mission.id })

      return ok(t('commands.msg.hermes.missionPaused', { title: mission.title }), { page: 'missions', highlight: { kind: 'mission', id: mission.id } })
    }
  },
  {
    id: 'mission.markReviewed',
    title: 'Mark a mission reviewed',
    description: 'Move a mission from Needs review to Completed.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Part of the mission title', required: true }],
    phrases: ['mark the {name} mission as reviewed', 'mark {name} reviewed', 'i reviewed the {name} mission'],
    phrasesDe: ['markiere die mission {name} als geprüft', 'markiere {name} als geprüft', 'ich habe die mission {name} geprüft'],
    run: ({ name }) => {
      const { mission, candidates } = findMission(String(name))

      if (!mission) {
        return candidates.length ? ambiguous('mission', candidates.map(m => m.title)) : fail(t('commands.msg.hermes.noMission', { name: String(name) }))
      }

      markReviewed(mission.id)
      showPage('missions')
      focusMissions({ tab: 'completed', missionId: mission.id })

      return ok(t('commands.msg.hermes.markedReviewed', { title: mission.title }), { page: 'missions', highlight: { kind: 'mission', id: mission.id } })
    }
  },
  {
    id: 'agents.pauseAll',
    title: 'Pause all agents',
    description: 'Interrupt every running session and pause every automation.',
    tier: 'destructive',
    args: [],
    phrases: ['pause all agents', 'pause everything', 'stop everything'],
    phrasesDe: ['pausiere alle agenten', 'pausiere alles', 'stoppe alles', 'halte alles an'],
    run: async () => {
      const result = await pauseAllAgents()

      return ok(t('commands.msg.hermes.pausedAll', { interrupted: result.interrupted, paused: result.paused }), { data: { ...result } })
    }
  },
  {
    id: 'agents.toolSearch.set',
    title: 'Tool search',
    description: "Hermes's Tool Search for every session: on looks plugin and MCP tools up when needed (fewer prompt tokens), off keeps Herald OS's system tools directly callable. New conversations use it.",
    tier: 'mutate',
    args: [{ name: 'enabled', type: 'boolean', description: 'true to turn Tool Search on, false to turn it off; leave it out to flip it' }],
    phrases: [
      { phrase: 'turn on tool search', args: { enabled: true } },
      { phrase: 'turn off tool search', args: { enabled: false } }
    ],
    phrasesDe: [
      { phrase: 'schalte die tool-suche ein', args: { enabled: true } },
      { phrase: 'schalte tool search ein', args: { enabled: true } },
      { phrase: 'schalte die tool-suche aus', args: { enabled: false } },
      { phrase: 'schalte tool search aus', args: { enabled: false } }
    ],
    run: async ({ enabled }) => {
      const on = enabled === undefined ? !(await readToolSearch()) : Boolean(enabled)
      await setToolSearch(on)

      return ok(on ? t('commands.msg.hermes.toolSearchOn') : t('commands.msg.hermes.toolSearchOff'), { highlight: { kind: 'setting', id: 'agents' }, data: { enabled: on } })
    }
  },
  {
    id: 'agents.provider.list',
    title: 'Model providers',
    description: 'The model providers Hermes knows (Nous Portal, OpenRouter, OpenAI, Anthropic, a ChatGPT account, …), the one it thinks with, and which are set up.',
    tier: 'read',
    args: [],
    phrases: ['which model providers are set up', 'list the model providers', 'which model provider does hermes use'],
    phrasesDe: ['welche modellanbieter sind eingerichtet', 'liste die modellanbieter auf', 'welchen modellanbieter nutzt hermes'],
    run: async () => {
      const choices = await readProviderChoices()
      const current = choices.find(choice => choice.current)
      const ready = choices.filter(choice => choice.ready && !choice.current)
      const now = current ? t(current.ready ? 'commands.msg.hermes.thinksWith' : 'commands.msg.hermes.thinksWithNotReady', { name: current.name }) : t('commands.msg.hermes.noProviderYet')
      const others = ready.length ? t('commands.msg.hermes.alsoSetUp', { names: ready.map(choice => choice.name).join(', ') }) : t('commands.msg.hermes.noOtherProvider')

      return ok(`${now}. ${others}`, {
        highlight: { kind: 'setting', id: 'agents' },
        items: choices.map(choice => ({ id: choice.slug, name: choice.name, current: choice.current, ready: choice.ready, setup: choice.ready ? null : choice.setup }))
      })
    }
  },
  {
    id: 'agents.provider.set',
    title: 'Use a model provider',
    description:
      "Switch the provider Hermes thinks with. One that is set up (signed in, or its API key saved) is used at once, on Hermes's recommended model for it; one that signs in on an account opens the sign-in card; any other opens Settings > Hermes & agents at its setup. An API key is only ever typed into Settings, never passed to a command.",
    tier: 'mutate',
    args: [{ name: 'provider', type: 'string', description: 'Provider name or id: OpenRouter, Anthropic, Nous Portal, openai-codex, …', required: true }],
    phrases: ['switch hermes to {provider}', 'use {provider} as the model provider', 'change the model provider to {provider}', 'set the model provider to {provider}'],
    phrasesDe: ['wechsle hermes zu {provider}', 'nutze {provider} als modellanbieter', 'ändere den modellanbieter auf {provider}', 'setze den modellanbieter auf {provider}'],
    run: async ({ provider }, context) => {
      const voiceTarget = context.source === 'voice' ? voiceTargetSessionId() : null
      const choices = await readProviderChoices()
      const { choice, candidates } = matchProvider(choices, String(provider))
      const highlight = { kind: 'setting', id: 'agents' } as const

      if (!choice) {
        return candidates.length > 1 ? ambiguous('provider', candidates.map(item => item.name)) : fail(t('commands.msg.hermes.noProvider', { provider: String(provider) }))
      }

      if (choice.ready && choice.current) {
        return ok(t('commands.msg.hermes.alreadyThinksWith', { name: choice.name }), { highlight })
      }

      if (choice.ready) {
        let change: ModelChange
        try { change = await (context.source === 'voice' ? switchToProvider(choice.slug, false, voiceTarget) : switchToProvider(choice.slug)) }
        catch (error) { return fail(modelErrorText(error), { highlight }) }

        if (!change.ok) {
          return fail(t('commands.msg.hermes.chooseModel', { confirm: change.confirm, name: choice.name }), { highlight })
        }

        const scope = modelChangeScope(change.session, context.source === 'voice' ? voiceTarget ?? undefined : $activeChat.get()?.sessionId)
        const messageKeys = {
          'chat-and-new': 'settings.agents.model.saved.chatAndNew',
          'new-only': 'settings.agents.model.saved.newOnly',
          'earlier-chat-and-new': 'settings.agents.model.saved.earlierChat',
          'chat-failed': 'settings.agents.model.saved.chatFailed',
          'chat-queued': 'settings.agents.model.saved.chatQueued'
        } as const
        const summary = `${t(messageKeys[scope], { name: choice.name, model: change.model })}${change.local ? ` ${t('settings.provider.local.responseUnverified')}` : ''}`

        return ok(summary, { spoken: summary, highlight, data: { provider: change.provider, model: change.model } })
      }

      if (choice.setup === 'sign-in') {
        requestHermesLogin(t('commands.msg.hermes.signInPrompt', { name: choice.name }), choice.slug)

        return ok(t('commands.msg.hermes.signInOnCard', { name: choice.name }), { data: { provider: choice.slug } })
      }

      showPage('settings')
      focusSettings({ section: 'agents' })
      focusProvider(choice.slug)

      return ok(choice.setup === 'key' ? t('commands.msg.hermes.pasteKey', { name: choice.name }) : t('commands.msg.hermes.setupShown', { name: choice.name }), { page: 'settings', highlight, data: { provider: choice.slug, setup: choice.setup } })
    }
  }
]
