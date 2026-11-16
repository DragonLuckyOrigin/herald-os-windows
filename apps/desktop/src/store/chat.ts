import { t as uiT } from './i18n.ts'
import type { GatewayEvent, SessionCreateResult, SessionResumeResult } from '@herald-os/client'
import { atom, computed, map } from 'nanostores'
import { ELSEWHERE_NOTE } from '../lib/attachments.ts'
import { isDefaultProfile, profileParam, sameProfile } from '../lib/bots.ts'
import { appendSystem, appendUser, type ChatState, emptyChat, fromTranscript, reduceChatEvent } from '../lib/chat-model.ts'
import { currentModelText } from '../lib/model-provider.ts'
import { attachFiles, hermesReadsLocalFiles } from './attachments.ts'
import { $env, $prefs } from './backend.ts'
import { $connectionEpoch, gatewayRequest, onAnyGatewayEvent } from './gateway.ts'
import { notify } from './notifications.ts'
import { refreshSessions, rememberRuntimeId } from './sessions.ts'

export const SESSION_SOURCE = 'herald_os'
/** Sessions this shell lists: its own (including those saved before the rename) and other interactive clients. */
export const LISTED_SESSION_SOURCES: ReadonlySet<string> = new Set([SESSION_SOURCE, 'hermes_os', 'desktop', 'cli', 'tui'])

/** Live chat state per runtime session id. */
export const $chats = map<Record<string, ChatState>>({})
export const $activeChatId = atom<string | null>(null)
export const $activeChat = computed([$chats, $activeChatId], (chats, id) => (id ? (chats[id] ?? null) : null))

/** Runtime ids requested as hidden. Suppress them until confirmation succeeds or an epoch reset retires them. */
const pendingHiddenSessions = new Set<string>()

export function isHiddenChat(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId && (pendingHiddenSessions.has(sessionId) || $chats.get()[sessionId]?.hidden))
}

const CHAT_EVENTS = new Set<GatewayEvent['type']>([
  'message.start',
  'message.delta',
  'message.interim',
  'message.complete',
  'thinking.delta',
  'reasoning.delta',
  'tool.start',
  'tool.complete',
  'status.update',
  'session.title',
  'session.info',
  'session.usage',
  'error'
])

/** Chats started in the background for a surface that shows their replies itself (an Office window's Ask Hermes bar). */
const quietChats = new Set<string>()

function adopt(result: SessionCreateResult | SessionResumeResult, fallbackStored?: string, profile?: string, remember = true): ChatState {
  const stored = result.stored_session_id ?? fallbackStored ?? result.session_id
  const state = emptyChat(result.session_id, stored, result.info)
  state.messages = fromTranscript(result.messages ?? [])
  state.title = result.info?.title ?? state.title
  const inflight = 'inflight' in result ? result.inflight : null

  if (!isDefaultProfile(profile)) {
    state.profile = profile
  }

  if (inflight?.assistant) {
    state.messages.push({ id: `inflight-${result.session_id}`, role: 'assistant', text: inflight.assistant, reasoning: '', streaming: Boolean(inflight.streaming), ts: Date.now() })
    state.openAssistantId = inflight.streaming ? `inflight-${result.session_id}` : null
  }

  state.streaming = Boolean(result.info?.running || ('running' in result && result.running))
  if (remember) rememberRuntimeId(stored, result.session_id, profile)

  return state
}

/** Ask Hermes to own the hidden flag and return the canonical key for this live runtime. */
async function confirmHidden(state: ChatState, profile?: string): Promise<void> {
  const result = await gatewayRequest('session.set_hidden', { session_id: state.sessionId, hidden: true, ...profileParam(profile) })

  if (result.hidden !== true || typeof result.session_key !== 'string' || !result.session_key.trim() || result.session_key.length > 512) {
    throw new Error(uiT('voice.session.identityUnconfirmed'))
  }

  state.hidden = true
  state.storedSessionId = result.session_key
  rememberRuntimeId(result.session_key, state.sessionId, profile)
}

export function bindChatEvents(): () => void {
  return onAnyGatewayEvent(event => {
    const sid = event.session_id

    if (!sid || !CHAT_EVENTS.has(event.type)) {
      return
    }

    const current = $chats.get()[sid]

    if (!current) {
      return
    }

    const next = reduceChatEvent(current, event)

    if (next !== current) {
      $chats.setKey(sid, next)
    }

    if (event.type === 'message.complete' && $activeChatId.get() !== sid && !quietChats.has(sid)) {
      notify({ title: next.title || 'Hermes', body: uiT("ui.d8ce869d0313"), level: 'info', surface: 'chat', category: 'toolCompletion' })
    }

    if (event.type === 'session.title') {
      void refreshSessions(next.profile)
    }
  })
}

/** A new chat; it becomes the one the Hermes window shows unless `activate` is false, and then its turns end without a notification. */
export async function createChat(options: { cwd?: string; title?: string; activate?: boolean; profile?: string; hidden?: boolean } = {}): Promise<ChatState> {
  const local = hermesReadsLocalFiles()
  // A Hermes that cannot read this computer's files works in its own folders, and knows the person's files are elsewhere.
  const cwd = options.cwd ?? (local ? ($prefs.get().defaultCwd ?? $env.get()?.homeDir ?? null) : null)
  const seed = local ? {} : { messages: [{ role: 'user', content: ELSEWHERE_NOTE, display_kind: 'hidden' }] }
  const result = await gatewayRequest('session.create', { source: SESSION_SOURCE, cwd, title: options.title ?? null, ...seed, ...profileParam(options.profile), ...(options.hidden ? { hidden: true } : {}) })
  if (options.hidden && (typeof result.stored_session_id !== 'string' || !result.stored_session_id.trim() || result.stored_session_id.length > 512)) {
    throw new Error(uiT('voice.session.identityUnconfirmed'))
  }
  const state = adopt(result, undefined, options.profile, !options.hidden)
  if (options.hidden) {
    pendingHiddenSessions.add(state.sessionId)
    // session.create only mints a live draft. set_hidden is the supported native confirmation that
    // the canonical lineage is hidden and resumable before its key is persisted by the client.
    // On failure keep the runtime suppressed until reconnect; it was requested as hidden and must
    // not leak events merely because the client refused to cache an unconfirmed native result.
    await confirmHidden(state, options.profile)
    pendingHiddenSessions.delete(state.sessionId)
  }
  $chats.setKey(state.sessionId, state)

  if (options.activate !== false && !options.hidden) {
    $activeChatId.set(state.sessionId)
  } else {
    quietChats.add(state.sessionId)
  }

  void refreshSessions(options.profile)

  return state
}

/** Reopen a stored session; a bot's needs its `profile`, since each profile keeps its own sessions. */
export async function openStoredSession(storedId: string, profile?: string, options: { activate?: boolean; requireExactId?: boolean; hidden?: boolean } = {}): Promise<ChatState> {
  const existing = Object.values($chats.get()).find(chat => chat.storedSessionId === storedId && sameProfile(chat.profile, profile))

  if (existing) {
    if (options.hidden && !existing.hidden) {
      throw new Error(uiT('voice.session.identityUnconfirmed'))
    }
    if (options.activate !== false && !options.hidden) $activeChatId.set(existing.sessionId)
    else quietChats.add(existing.sessionId)

    return $chats.get()[existing.sessionId]
  }

  const result = await gatewayRequest('session.resume', { session_id: storedId, source: SESSION_SOURCE, ...profileParam(profile) })
  // A live draft echoes its exact stored key. A persisted session may instead report its canonical
  // compression tip through session.set_hidden below, so an absent stored_session_id is not a mismatch.
  if (options.requireExactId && typeof result.stored_session_id === 'string' && result.stored_session_id !== storedId) {
    throw new Error(uiT('voice.session.identityUnconfirmed'))
  }
  const state = adopt(result, storedId, profile, !options.hidden)
  if (options.hidden) {
    pendingHiddenSessions.add(state.sessionId)
    await confirmHidden(state, profile)
    pendingHiddenSessions.delete(state.sessionId)
  }
  $chats.setKey(state.sessionId, state)
  if (options.activate !== false && !options.hidden) $activeChatId.set(state.sessionId)
  else quietChats.add(state.sessionId)

  return state
}

export interface SendPromptOptions {
  sessionId?: string
  /** Rechecked after async preparation, before the prompt is recorded or dispatched. Does not cancel an already submitted turn. */
  canSubmit?: () => boolean
  /** Called synchronously at the dispatch boundary so a voice owner can bind its target and event listeners before the ACK. */
  onDispatch?: () => void
  cwd?: string
  /**
   * Client surface the turn comes from. `voice-live` makes the backend prepend its spoken-reply
   * note (short, no markdown) and accept `voiceContext`; the default is the shell itself.
   */
  surface?: 'voice-live'
  /** Recent spoken exchange (newest last) so "yes" or "Thursday, not Friday" has its referent. */
  voiceContext?: string
  /** The user spoke over an in-flight reply; the backend notes the interruption for the model. */
  interrupted?: boolean
  /** Files on this computer (absolute paths) for Hermes to receive with the prompt; see store/attachments.ts. */
  attachments?: readonly string[]
}

/**
 * Send a prompt to the active chat, creating one when none exists for ordinary text input.
 * Voice must name an existing session and never falls back to the visible chat. Resolves with
 * the session used, or null if canceled/lost before dispatch. Attachment failure rejects.
 */
export async function sendPrompt(text: string, options: SendPromptOptions = {}): Promise<string | null> {
  const trimmed = text.trim()
  const files = options.attachments ?? []

  if ((!trimmed && files.length === 0) || options.canSubmit?.() === false) {
    return null
  }

  const voice = options.surface === 'voice-live'
  const epoch = $connectionEpoch.get()
  let sid = voice ? options.sessionId : options.sessionId ?? $activeChatId.get()

  if (!sid || !$chats.get()[sid]) {
    if (voice) return null
    sid = (await createChat({ cwd: options.cwd })).sessionId
  }

  const attached = await attachFiles(sid, files, $chats.get()[sid]?.info.desktop_contract)
  // Even preparation without files yields. Sleep, barge-in, a newer request or reconnect can
  // invalidate a voice turn in that gap; do not append a phantom prompt or create a fallback chat.
  if (options.canSubmit?.() === false || (voice && (!$chats.get()[sid] || epoch !== $connectionEpoch.get()))) {
    return null
  }
  const message = [trimmed, attached].filter(Boolean).join('\n')
  options.onDispatch?.()
  const before = $chats.get()[sid]

  if (before) {
    $chats.setKey(sid, appendUser(before, message))
  }

  try {
    await gatewayRequest('prompt.submit', {
      session_id: sid,
      text: message,
      surface: options.surface ?? SESSION_SOURCE,
      ...(options.surface && options.voiceContext ? { voice_context: options.voiceContext } : {}),
      ...(options.interrupted ? { interrupted: true } : {})
    })
  } catch (error) {
    const current = $chats.get()[sid]

    if (current) {
      $chats.setKey(sid, { ...appendSystem(current, error instanceof Error ? error.message : String(error), 'error'), streaming: false })
    }
  }

  return sid
}

export async function runSlash(command: string, sessionId?: string): Promise<void> {
  let sid = sessionId ?? $activeChatId.get()

  if (!sid || !$chats.get()[sid]) {
    sid = (await createChat()).sessionId
  }

  const chat = $chats.get()[sid]

  if (chat) {
    $chats.setKey(sid, appendUser(chat, command))
  }

  try {
    // Hermes answers a bare /model from the session's agent, which it builds once the session is
    // open, seconds later, and says "(unknown)" until then; model.options knows the model either way.
    const model = /^\/model\s*$/i.test(command.trim()) ? currentModelText(await gatewayRequest('model.options', { session_id: sid }).catch(() => null)) : null

    if (model) {
      const current = $chats.get()[sid]

      if (current) {
        $chats.setKey(sid, { ...appendSystem(current, model), streaming: false })
      }

      return
    }

    const result = await gatewayRequest('slash.exec', { session_id: sid, command })
    const current = $chats.get()[sid]

    if (!current) {
      return
    }

    if (result.type === 'send' || result.type === 'skill') {
      // The command resolved to a message the agent should receive.
      $chats.setKey(sid, { ...current, streaming: true })
      await gatewayRequest('prompt.submit', { session_id: sid, text: result.message ?? command, surface: SESSION_SOURCE })

      return
    }

    const text = [result.display ?? result.output ?? '', result.notice ?? '', result.warning ?? ''].filter(Boolean).join('\n\n')
    $chats.setKey(sid, { ...appendSystem(current, text || `${command} done`), streaming: false })
  } catch (error) {
    const current = $chats.get()[sid]

    if (current) {
      $chats.setKey(sid, { ...appendSystem(current, error instanceof Error ? error.message : String(error), 'error'), streaming: false })
    }
  }
}

export async function interruptChat(sessionId?: string): Promise<void> {
  const sid = sessionId ?? $activeChatId.get()

  if (!sid) {
    return
  }

  await gatewayRequest('session.interrupt', { session_id: sid })
}

export function forgetChat(sessionId: string): void {
  quietChats.delete(sessionId)
  pendingHiddenSessions.delete(sessionId)
  const next = { ...$chats.get() }
  delete next[sessionId]
  $chats.set(next)

  if ($activeChatId.get() === sessionId) {
    $activeChatId.set(null)
  }
}

export function resetChats(): void {
  quietChats.clear()
  pendingHiddenSessions.clear()
  $chats.set({})
  $activeChatId.set(null)
}
