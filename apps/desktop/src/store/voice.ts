import { t as uiT } from './i18n.ts'
import type { VoiceEngine, VoicePrefs } from '../../shared/ipc.ts'
import { atom, computed } from 'nanostores'
import { acknowledgeCaptureNotice, $captureNotice, $micLevel, $micOpen, microphoneDenied, setCaptureConversing, setMicrophoneMuted } from '../lib/voice/audio-capture.ts'
import { privacyPaneActions } from '../lib/privacy-pane.ts'
import { earcons } from '../lib/voice/earcons.ts'
import type { ConversationEndReason, ConversationEngine, TurnHandlers, VoiceCaptions, VoiceHost, VoiceState } from '../lib/voice/engine.ts'
import { matchIntent } from '../lib/voice/intents.ts'
import { rememberFocusedEditable } from './edit-target.ts'
import { runCommand } from './os-commands.ts'
import { withProviderFallback } from '../lib/voice/provider-fallback.ts'
import { $speakLevel, speakOnce, stopFallbackAudio } from '../lib/voice/speak-stream.ts'
import { rest } from '../lib/rest.ts'
import { sanitizeForSpeech } from '../lib/voice/speech-text.ts'
import { type LocalSttConfig, sttTuningPatch } from '../lib/voice/stt-tuning.ts'
import { assistantTextSince, runningToolsSince, textDelta, toolsSince } from '../lib/voice/turn-text.ts'
import { decideVoiceApproval, voiceApprovalFor } from '../lib/voice/approval-answer.ts'
import { withScreenContext } from '../lib/screen-context.ts'
import type { ChatState, SystemMessage } from '../lib/chat-model.ts'
import { $env, $prefs, $prefsLoaded, updatePrefs } from './backend.ts'
import { presentationPlatform } from '../lib/platform-labels.ts'
import { $chats, createChat, forgetChat, interruptChat, openStoredSession, sendPrompt } from './chat.ts'
import { $connectionEpoch, $gatewayReady, onGatewayEvent } from './gateway.ts'
import { notify } from './notifications.ts'
import { officeContextLine, screenContextLine } from './on-screen.ts'
import { $pendingRequests, type PendingRequest, resolveRequest } from './requests.ts'
import { isMainSurface, onShellCommand } from './shell.ts'
import { fetchLiveStatus, type LiveStatus } from './voice-live-status.ts'
import { pauseWake, resumeWake } from './wake.ts'

export type VoiceStartReason = 'hotkey' | 'wake' | 'button' | 'command'

export interface VoiceSnapshot {
  state: VoiceState
  /** Engine running the current conversation (null when idle). */
  engine: VoiceEngine | null
  muted: boolean
  captions: VoiceCaptions
  startedBy: VoiceStartReason | null
  /** Last failure, shown on the orb until the next start. */
  error: string | null
  /** Live engine accounting: seconds in the open session and today's total. */
  live: { sessionSeconds: number; todaySeconds: number; status: LiveStatus | null }
}

const EMPTY_CAPTIONS: VoiceCaptions = { user: '', assistant: '' }

export const $voice = atom<VoiceSnapshot>({
  state: 'off',
  engine: null,
  muted: false,
  captions: EMPTY_CAPTIONS,
  startedBy: null,
  error: null,
  live: { sessionSeconds: 0, todaySeconds: 0, status: null }
})

/** True while a conversation is running (any state past armed). */
export const $voiceActive = computed($voice, voice => voice.state !== 'off' && voice.state !== 'armed')
/** The Hermes session the conversation's turns go to: its approval cards can be answered by voice. */
export const $voiceSessionId = atom<string | null>(null)
/** Session whose frontmost approval this active voice conversation may answer, including resume replay. */
export const $voiceApprovalSessionId = atom<string | null>(null)
/** Combined input/output level for the orb, 0..1. */
export const $voiceLevel = computed([$voice, $micLevel, $speakLevel], (voice, mic, speak) => (voice.state === 'speaking' ? speak : Math.min(1, mic * 4)))
export { $micOpen }

let engine: ConversationEngine | null = null
let starting = false
let ending: Promise<void> | null = null
/** Invalidates asynchronous startup when the user ends the conversation meanwhile. */
let conversationGeneration = 0

function patch(next: Partial<VoiceSnapshot>): void {
  $voice.set({ ...$voice.get(), ...next })
}

export const LIVE_RATE_PER_MINUTE = 0.05

export function todayKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** Seconds of Live session time already used today (resets when the day changes). */
export function liveSecondsToday(prefs: VoicePrefs = $prefs.get().voice, now = new Date()): number {
  return prefs.liveUsage.day === todayKey(now) ? prefs.liveUsage.seconds : 0
}

/** Seconds of Live time still allowed today; Infinity when uncapped. */
export function liveBudgetRemaining(prefs: VoicePrefs = $prefs.get().voice, now = new Date()): number {
  if (prefs.liveDailyCapMinutes <= 0) {
    return Number.POSITIVE_INFINITY
  }

  return Math.max(0, prefs.liveDailyCapMinutes * 60 - liveSecondsToday(prefs, now))
}

function recordLiveSeconds(seconds: number): void {
  if (seconds <= 0) {
    return
  }

  const prefs = $prefs.get().voice
  const day = todayKey()
  const total = (prefs.liveUsage.day === day ? prefs.liveUsage.seconds : 0) + seconds
  void updatePrefs({ voice: { ...prefs, liveUsage: { day, seconds: Math.round(total) } } })
  patch({ live: { ...$voice.get().live, todaySeconds: Math.round(total) } })
}

/** The last Hermes turn of this conversation used its tools; cleared when a fast-path command runs. */
let hermesActed = false

/** How long a spoken request waits for the turn it interrupted (an Office call cannot stop halfway) to end. */
const SETTLE_MS = 15_000
/** How long a request queued behind an interrupted turn may take to start once that turn has ended. */
const QUEUED_START_MS = 3000

type TurnStatus = 'complete' | 'error' | 'interrupted'

interface TurnEnd {
  status: TurnStatus
  error?: string
}

/** A spoken request sent to Hermes: where its reply starts, and the ends its session reported before anyone followed it. */
interface SentTurn {
  /** Index of the request in the chat; the reply is everything after it. */
  from: number
  /** The session was still running an earlier turn, whose interrupted end comes first. */
  queued: boolean
  ends: TurnEnd[]
  onEnd: ((end: TurnEnd) => void) | null
  release: () => void
}

const sentTurns = new Map<string, SentTurn>()
let requests = 0

/** Collect a session's turn ends from before a request goes out: a refusal or a fast failure can beat the answer to the submit. */
function watchEnds(sessionId: string, queued: boolean): SentTurn {
  const turn: SentTurn = { from: -1, queued, ends: [], onEnd: null, release: () => undefined }
  // After the reducer has applied the event, so the reply includes the final text.
  const report = (end: TurnEnd) => queueMicrotask(() => (turn.onEnd ? turn.onEnd(end) : void turn.ends.push(end)))
  const offComplete = onGatewayEvent('message.complete', event => {
    if (event.session_id === sessionId) {
      const status = event.payload?.status
      const error = event.payload?.error ?? (status === 'error' ? event.payload?.text : undefined)
      report({ status: status === 'error' ? 'error' : status === 'interrupted' ? 'interrupted' : 'complete', error: typeof error === 'string' ? error : undefined })
    }
  })
  const offError = onGatewayEvent('error', event => {
    if (event.session_id === sessionId) {
      // The failure text arrives here before any assistant bubble exists; carry it to the engine.
      report({ status: 'error', error: (event.payload as { message?: string } | undefined)?.message })
    }
  })

  turn.release = () => {
    offComplete()
    offError()
  }

  return turn
}

/** Visible routing is an explicit voice choice, independent of ordinary chat navigation. */
let visibleVoiceSessionId: string | null = null
/** Commands spoken in this conversation must never inherit the chat merely shown in the UI. */
export function voiceTargetSessionId(): string | null {
  return engine && !ending ? visibleVoiceSessionId ?? $voiceSessionId.get() : null
}

function voiceApprovalTargetSessionId(): string | null {
  return $voiceApprovalSessionId.get()
}
/** Coalesce native opens. A failed create is retained for this connection: no blind retry after an uncertain side effect. */
interface OperationalOpening {
  epoch: number
  generation: number
  storedId: string | undefined
  creating: boolean
  promise: Promise<ChatState>
}
let operationalOpening: OperationalOpening | null = null
/** A confirmed native id whose prefs write failed; retry that id instead of creating another session. */
let unpersistedOperationalId: string | undefined

function knownVoiceSessionError(error: unknown): Error {
  if (error instanceof Error && [
    uiT('voice.session.identityUnconfirmed'),
    uiT('voice.session.unavailable'),
    uiT('voice.session.visibleUnavailable'),
    uiT('voice.session.approvalPending')
  ].includes(error.message)) {
    return error
  }

  return new Error(uiT('voice.session.unavailable'))
}

function hasVoiceApproval(sessionId: string | null): boolean {
  return Boolean(sessionId && $chats.get()[sessionId] && voiceApprovalFor($pendingRequests.get(), sessionId))
}

function frontVoiceApprovalFrom(pending: readonly PendingRequest[], chats: Record<string, ChatState>, sessionId: string | null) {
  if (!sessionId || !chats[sessionId]) return null
  const card = voiceApprovalFor(pending, sessionId)
  return card && pending[0]?.request.id === card.request.id ? card : null
}

/** Spoken yes/no may decide only the globally frontmost pending card on a live voice session. */
function frontVoiceApproval(sessionId: string | null) {
  return frontVoiceApprovalFrom($pendingRequests.get(), $chats.get(), sessionId)
}

/** One shared truth for every UI hint: the exact card a spoken yes/no can decide right now. */
export const $voiceAnswerableApprovalId = computed(
  [$voiceActive, $voiceApprovalSessionId, $pendingRequests, $chats],
  (active, sessionId, pending, chats) => active ? frontVoiceApprovalFrom(pending, chats, sessionId)?.request.id ?? null : null
)

/** Hermes owns the history and visibility; prefs keep only its native stored reference. */
async function voiceSession(): Promise<string> {
  if (visibleVoiceSessionId) {
    if (!$chats.get()[visibleVoiceSessionId]) throw new Error(uiT('voice.session.visibleUnavailable'))
    return visibleVoiceSessionId
  }

  if (!$prefsLoaded.get()) throw new Error(uiT('voice.session.unavailable'))
  const savedId = $prefs.get().operationalVoiceSessionId
  if (savedId !== undefined && (typeof savedId !== 'string' || !savedId.trim() || savedId.length > 512)) {
    throw new Error(uiT('voice.session.identityUnconfirmed'))
  }
  const storedId = savedId ?? unpersistedOperationalId
  const epoch = $connectionEpoch.get()
  const generation = conversationGeneration
  // A resume has no create side effect: after a new conversation begins, a transient failure may be retried.
  // An uncertain create remains latched until an id is known or the connection state changes.
  const sameOpening = operationalOpening?.epoch === epoch && (operationalOpening.creating || operationalOpening.storedId === storedId)
  const retryResume = Boolean(sameOpening && storedId && !operationalOpening?.creating && operationalOpening?.generation !== generation)
  if (!sameOpening || retryResume) {
    const opening = {
      epoch,
      generation,
      storedId,
      creating: !storedId,
      promise: Promise.resolve(null as unknown as ChatState)
    } satisfies OperationalOpening
    opening.promise = (async () => {
      let chat: ChatState
      if (storedId) {
        // No generated native contract identifies a method-specific "stored session is gone" code.
        // Any resume/hidden-confirmation failure therefore keeps the exact reference and must not
        // clear it or create a replacement session speculatively.
        chat = await openStoredSession(storedId, undefined, { activate: false, requireExactId: true, hidden: true })
      } else {
        chat = await createChat({ hidden: true, activate: false })
      }

      // Capture the confirmed native identity before any epoch or preference check can fail. A later
      // conversation resumes this exact key instead of creating a second Hermes session.
      opening.creating = false
      opening.storedId = chat.storedSessionId
      unpersistedOperationalId = chat.storedSessionId
      try {
        if (savedId !== chat.storedSessionId) {
          const current = $prefs.get().operationalVoiceSessionId
          if (current !== undefined && current !== savedId && current !== chat.storedSessionId) throw new Error(uiT('voice.session.identityUnconfirmed'))
          await updatePrefs({ operationalVoiceSessionId: chat.storedSessionId })
          if ($prefs.get().operationalVoiceSessionId !== chat.storedSessionId) throw new Error(uiT('voice.session.identityUnconfirmed'))
        }
        unpersistedOperationalId = undefined
      } finally {
        // A reply from an old transport must not survive in the runtime cache and short-circuit the
        // exact native resume on the new connection. The stored key above remains available.
        if (epoch !== $connectionEpoch.get() && $chats.get()[chat.sessionId] === chat) forgetChat(chat.sessionId)
      }
      if (epoch !== $connectionEpoch.get()) throw new Error(uiT('voice.session.unavailable'))
      return chat
    })().catch(error => { throw knownVoiceSessionError(error) })
    operationalOpening = opening
  }
  const opening = operationalOpening!
  const chat = await opening.promise
  if (operationalOpening === opening) operationalOpening = null
  if (epoch !== $connectionEpoch.get() || !$chats.get()[chat.sessionId]) throw new Error(uiT('voice.session.unavailable'))

  return chat.sessionId
}

export type EndVoiceChatResult = 'ended' | 'none' | 'approval-pending' | 'unavailable'

/** End only the explicitly selected voice chat; preserve its history, UI selection and unrelated work. */
export async function endVoiceChat(): Promise<EndVoiceChatResult> {
  if (!visibleVoiceSessionId) return 'none'
  const target = visibleVoiceSessionId
  if (hasVoiceApproval(target)) return 'approval-pending'
  const request = ++requests
  const generation = conversationGeneration
  if ($chats.get()[target]?.streaming) {
    try {
      await interruptChat(target)
    } catch {
      return 'unavailable'
    }
    if (request !== requests || generation !== conversationGeneration || visibleVoiceSessionId !== target) return 'unavailable'
    engine?.prepareLocalInterrupt?.()
    if (hasVoiceApproval(target)) return 'approval-pending'
  }
  if (request !== requests || generation !== conversationGeneration || visibleVoiceSessionId !== target) return 'unavailable'
  visibleVoiceSessionId = null
  $voiceApprovalSessionId.set(null)
  $voiceSessionId.set(null)
  return 'ended'
}

/** Wait for the turn still running in a session to end, for a while; true when it is still running. */
async function settle(sessionId: string): Promise<boolean> {
  const until = Date.now() + SETTLE_MS

  while ($chats.get()[sessionId]?.streaming && Date.now() < until) {
    await new Promise(done => setTimeout(done, 100))
  }

  return Boolean($chats.get()[sessionId]?.streaming)
}

/** Follow a turn's assistant text through the chat store until it ends; unsubscribes then. */
function observeTurn(sessionId: string, handlers: TurnHandlers): () => void {
  const sent = sentTurns.get(sessionId)
  sentTurns.delete(sessionId)
  const turn = sent ?? watchEnds(sessionId, false)
  const chat = $chats.get()[sessionId]
  // A turn sent some other way: its request is the chat's last message.
  const fromIndex = sent ? sent.from : chat ? chat.messages.length - 1 : -1
  let seen = ''
  let seenTools = new Set<string>()
  let done = false
  let skipped = false
  let starting: ReturnType<typeof setTimeout> | null = null
  hermesActed = false

  /** Stop following; the tools the turn ran, or null when it was over already. */
  const stop = (): string[] | null => {
    if (done) {
      return null
    }

    done = true

    if (starting) {
      clearTimeout(starting)
    }

    offChats()
    turn.release()
    const current = $chats.get()[sessionId]
    const tools = current ? toolsSince(current.messages, fromIndex) : []
    hermesActed = tools.length > 0

    return tools
  }

  const finish = (status: TurnStatus, error?: string) => {
    const tools = stop()

    if (tools) {
      handlers.onComplete(seen, status, error, tools)
    }
  }

  const follow = (current: ChatState) => {
    for (const name of runningToolsSince(current.messages, fromIndex)) {
      if (!seenTools.has(name)) {
        seenTools = new Set([...seenTools, name])
        handlers.onTool?.(name)
      }
    }

    const full = assistantTextSince(current.messages, fromIndex)
    const delta = textDelta(seen, full)

    if (delta) {
      seen = full
      handlers.onDelta(delta, full)
    } else if (full !== seen && full.length > 0) {
      // Authoritative final text replaced the stream (partial payload): re-sync without re-speaking.
      seen = full
    }
  }

  const offChats = $chats.subscribe(chats => {
    const current = chats[sessionId]

    if (!current || done) {
      return
    }

    if (starting && current.streaming) {
      clearTimeout(starting)
      starting = null
    }

    follow(current)
  })

  const onEnd = (end: TurnEnd) => {
    if (done) {
      return
    }

    const current = $chats.get()[sessionId]

    if (current) {
      follow(current)
    }

    if (end.status === 'interrupted' && turn.queued && !skipped) {
      // The turn this request waited behind has ended; the request's own turn starts next, unless the
      // session folded the request into that turn and dropped it with it.
      skipped = true
      starting = setTimeout(() => {
        starting = null

        if (!$chats.get()[sessionId]?.streaming) {
          finish('interrupted')
        }
      }, QUEUED_START_MS)

      return
    }

    finish(end.status, end.error)
  }

  turn.onEnd = onEnd

  for (const end of turn.ends.splice(0)) {
    onEnd(end)
  }

  // A request the gateway refused never starts a turn; sendPrompt leaves the refusal right after it.
  const current = $chats.get()[sessionId]
  const refusal = current && !current.streaming && fromIndex >= 0 ? current.messages.slice(fromIndex + 1).find((message): message is SystemMessage => message.role === 'system' && message.level === 'error') : undefined

  if (refusal) {
    finish('error', refusal.text)
  }

  // The engine has moved on (barge-in, a newer request, the end of the conversation): no end to report.
  return () => void stop()
}

/** Voice fast path: a matching registry command runs immediately; a failed run falls back to Hermes. */
export async function runVoiceIntent(text: string): Promise<{ handled: boolean; spoken: string; ok: boolean }> {
  // Right after Hermes moved or changed something, "undo that" is about its change, not the text field.
  const intent = matchIntent(text, undefined, { afterHermesAction: hermesActed })

  if (!intent) {
    return { handled: false, spoken: '', ok: false }
  }

  const selectsChat = intent.command === 'chat.new' || intent.command === 'chat.open'
  const routesChat = selectsChat || intent.command === 'voice.chat.end'
  // Reserved lifecycle commands are terminal even when their local side effect reports a failure.
  // Forwarding their utterance to Hermes would turn control words into an unintended prompt.
  const terminalLifecycle = routesChat || intent.command === 'chat.stop' || intent.command === 'voice.sleep'
  const generation = conversationGeneration
  const selection = selectsChat ? ++requests : requests
  const previousTarget = voiceTargetSessionId()
  const previousApprovalTarget = voiceApprovalTargetSessionId() ?? previousTarget
  const stopsStreamingTarget = intent.command === 'chat.stop' && Boolean(previousTarget && $chats.get()[previousTarget]?.streaming)
  if (selectsChat && hasVoiceApproval(previousApprovalTarget)) {
    return { handled: true, spoken: uiT('voice.session.approvalPending'), ok: false }
  }
  const result = await runCommand(intent.command, intent.args, { source: 'voice' })

  if (!result.ok) {
    if (terminalLifecycle) return { handled: true, spoken: result.error ?? result.summary, ok: false }
    // The words matched but the OS could not do it (unknown name, nothing selected): let Hermes reason.
    return { handled: false, spoken: result.error ?? result.summary, ok: false }
  }
  if (stopsStreamingTarget && generation === conversationGeneration && selection === requests) engine?.prepareLocalInterrupt?.()

  if (selectsChat) {
    if (generation !== conversationGeneration || !engine || ending || selection !== requests) {
      return { handled: true, spoken: uiT('voice.session.visibleUnavailable'), ok: false }
    }
    const target = result.data?.sessionId
    if (typeof target !== 'string' || !$chats.get()[target]) {
      return { handled: true, spoken: uiT('voice.session.visibleUnavailable'), ok: false }
    }
    // A request may arrive while the asynchronous new/open command is running. Do not orphan it by
    // clearing the route it belongs to merely because the command itself already succeeded.
    if (hasVoiceApproval(previousApprovalTarget)) {
      return { handled: true, spoken: uiT('voice.session.approvalPending'), ok: false }
    }
    if (previousTarget && previousTarget !== target && $chats.get()[previousTarget]?.streaming) {
      try {
        await interruptChat(previousTarget)
      } catch {
        return { handled: true, spoken: uiT('voice.session.unavailable'), ok: false }
      }
      if (generation !== conversationGeneration || !engine || ending || selection !== requests) {
        return { handled: true, spoken: uiT('voice.session.visibleUnavailable'), ok: false }
      }
      engine.prepareLocalInterrupt?.()
      if (hasVoiceApproval(previousApprovalTarget)) {
        return { handled: true, spoken: uiT('voice.session.approvalPending'), ok: false }
      }
    }
    if (generation !== conversationGeneration || !engine || ending || selection !== requests) {
      return { handled: true, spoken: uiT('voice.session.visibleUnavailable'), ok: false }
    }
    visibleVoiceSessionId = target
    $voiceApprovalSessionId.set(target)
    $voiceSessionId.set(null)
  }
  hermesActed = false

  return { handled: true, spoken: result.spoken ?? result.summary, ok: true }
}

function createHost(generation: number): VoiceHost {
  const current = () => generation === conversationGeneration && engine !== null && !ending
  return {
    prefs: () => $prefs.get().voice,
    setState: state => { if (current()) patch({ state }) },
    setCaptions: captions => { if (current()) patch({ captions: { ...$voice.get().captions, ...captions } }) },
    // The Office and screen lines ride with the spoken context (model input only), so "this folder",
    // "this file" and "this sheet" mean what is open and shown while the person's words stay exactly as said.
    submit: async (text, options) => {
      if (!current()) return null
      const request = ++requests
      const epoch = $connectionEpoch.get()
      const requestCurrent = () => current() && request === requests && epoch === $connectionEpoch.get()
      const target = await voiceSession()
      if (!requestCurrent()) return null
      // Resume may replay an open request before a spoken turn reaches sendPrompt's dispatch boundary.
      // Remember only its exact session for approval matching; $voiceSessionId remains dispatch-owned.
      $voiceApprovalSessionId.set(target)
      if (hasVoiceApproval(target)) throw new Error(uiT('voice.session.approvalPending'))
      const dispatchAllowed = () => requestCurrent() && !hasVoiceApproval(target)
      // Sent while the turn it interrupted still runs, the request would wait behind that turn or be dropped with it.
      const queued = options.interrupted ? await settle(target) : Boolean($chats.get()[target]?.streaming)

      if (!requestCurrent()) {
        return null
      }
      if (hasVoiceApproval(target)) throw new Error(uiT('voice.session.approvalPending'))

      const office = await officeContextLine()
      if (!requestCurrent()) {
        return null
      }
      if (hasVoiceApproval(target)) throw new Error(uiT('voice.session.approvalPending'))
      // Bind only when dispatch actually begins, before the native ACK. Async preparation may be canceled.
      const binding: { turn?: SentTurn } = {}
      let sessionId: string | null = null

      try {
        sessionId = await sendPrompt(text, {
          sessionId: target,
          surface: 'voice-live',
          // Hermes retains each session's own history. The engine-provided voice context deliberately
          // stays engine-local: copying it would leak operational history across route changes.
          voiceContext: withScreenContext(undefined, screenContextLine(), office),
          interrupted: options.interrupted,
          // Rechecked by sendPrompt after attachment preparation, immediately before it appends the
          // user bubble and dispatches. A newly arrived approval must win that boundary.
          canSubmit: dispatchAllowed,
          onDispatch: () => {
            $voiceSessionId.set(target)
            $voiceApprovalSessionId.set(target)
            binding.turn = watchEnds(target, queued)
          }
        })
      } finally {
        // A canceled/lost target must not retain listeners or create another chat.
        if (sessionId !== target || !requestCurrent()) {
          binding.turn?.release()
        }
      }

      if (!requestCurrent()) {
        return null
      }
      if (!sessionId && hasVoiceApproval(target)) throw new Error(uiT('voice.session.approvalPending'))

      if (sessionId && binding.turn) {
        const sent = binding.turn
        const words = text.trim()
        sent.from = $chats.get()[sessionId]?.messages.findLastIndex(message => message.role === 'user' && message.text === words) ?? -1
        sentTurns.get(sessionId)?.release()
        sentTurns.set(sessionId, sent)
        $voiceSessionId.set(sessionId)
      }

      return sessionId
    },
    runIntent: text => current() ? runVoiceIntent(text) : Promise.resolve({ handled: false, spoken: '', ok: false }),
    interrupt: async () => {
      if (!current()) return
      requests++
      const sessionId = $voiceSessionId.get()
      // No voice target means no work to cancel, never the unrelated chat currently on screen.
      if (sessionId) {
        await interruptChat(sessionId).catch(() => undefined)
      }
    },
    approvalPending: () => current() && frontVoiceApproval(voiceApprovalTargetSessionId()) !== null,
    answerApproval: text => {
      if (!current()) return null
      const target = voiceApprovalTargetSessionId()
      const card = frontVoiceApproval(target)
      const decision = card ? decideVoiceApproval([card], target, text) : null

      if (!decision) {
        return null
      }

      resolveRequest(decision.requestId, { choice: decision.choice })

      return decision.answer
    },
    observeTurn: (sessionId, handlers) => current() ? observeTurn(sessionId, {
      onDelta: (delta, full) => { if (current()) handlers.onDelta(delta, full) },
      onTool: name => { if (current()) handlers.onTool?.(name) },
      onComplete: (...args) => { if (current()) handlers.onComplete(...args) }
    }) : () => undefined,
    ended: (reason, detail) => { if (current()) void endConversation(reason, detail) },
    notify: (title, body, level = 'info') => {
      if (current()) notify({ title, body, level, surface: 'chat' })
    },
    // Closing a stale transport must still settle its own usage; it cannot update the new session meter.
    recordLiveSeconds,
    setLiveSeconds: seconds => { if (current()) setLiveSessionSeconds(seconds) }
  }
}

async function loadEngine(kind: VoiceEngine, generation: number): Promise<ConversationEngine> {
  const host = createHost(generation)
  if (kind === 'live') {
    const { LiveEngine } = await import('../lib/voice/live-engine.ts')

    return new LiveEngine(host)
  }

  const { ChainedEngine } = await import('../lib/voice/chained-engine.ts')

  return new ChainedEngine(host)
}

/** Which engine a new conversation would use right now, and why not Live when it was asked for. */
export async function resolveEngine(prefs: VoicePrefs = $prefs.get().voice): Promise<{ engine: VoiceEngine; fallbackReason: string | null }> {
  if (prefs.engine !== 'live') {
    return { engine: 'chained', fallbackReason: null }
  }

  if (liveBudgetRemaining(prefs) <= 0) {
    if (presentationPlatform($env.get()?.platform) === 'win32') {
      throw new Error(uiT('voice.engine.capReached', { minutes: prefs.liveDailyCapMinutes }))
    }
    return { engine: 'chained', fallbackReason: `Live daily cap of ${prefs.liveDailyCapMinutes} min reached; using the free engine.` }
  }

  const status = await fetchLiveStatus()
  patch({ live: { ...$voice.get().live, status } })

  if (!status.available) {
    if (presentationPlatform($env.get()?.platform) === 'win32') {
      throw new Error(status.reason ?? uiT('voice.engine.unavailable'))
    }
    return { engine: 'chained', fallbackReason: status.reason ?? 'GPT-Live is not available; using the free engine.' }
  }

  return { engine: 'live', fallbackReason: null }
}

export async function startVoice(reason: VoiceStartReason = 'button'): Promise<void> {
  const prefs = $prefs.get().voice

  if (engine || starting || ending) {
    return
  }

  if (!$gatewayReady.get()) {
    notify({ title: uiT("ui.87bf2bc08589"), body: uiT("ui.b6b5808a1191"), level: 'warn' })

    return
  }

  starting = true
  const generation = ++conversationGeneration
  let wakePausePending = false
  // "Type …" should land in the field the user was in before the mic took focus.
  rememberFocusedEditable()

  // Turning voice on by using it: the first conversation flips the master switch.
  if (!prefs.enabled) {
    void updatePrefs({ voice: { ...prefs, enabled: true } })
  }

  patch({ state: 'connecting', startedBy: reason, error: null, captions: EMPTY_CAPTIONS, muted: false, live: { ...$voice.get().live, sessionSeconds: 0, todaySeconds: liveSecondsToday(prefs) } })

  try {
    const resolved = await resolveEngine(prefs)
    if (generation !== conversationGeneration) {
      return
    }

    if (resolved.fallbackReason) {
      notify({ title: uiT("ui.87bf2bc08589"), body: resolved.fallbackReason, level: 'info' })
    }

    wakePausePending = true
    await pauseWake()
    if (generation !== conversationGeneration) {
      return
    }
    wakePausePending = false
    const next = await loadEngine(resolved.engine, generation)
    if (generation !== conversationGeneration) {
      return
    }
    engine = next
    patch({ engine: resolved.engine })
    await next.start()
    if (generation !== conversationGeneration) {
      await next.stop()
    }
  } catch (error) {
    if (generation !== conversationGeneration) {
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    engine = null
    patch({ state: idleState(), engine: null, error: message })
    earcons.error()
    notify({ title: uiT("ui.8b047aa5ac78"), body: message, level: 'error', actions: microphoneDenied(error) ? privacyPaneActions('microphone') : undefined })
    await resumeWakeSafely()
  } finally {
    try {
      // An outstanding native pause can settle after endConversation's resume.
      if (generation !== conversationGeneration && wakePausePending) {
        await resumeWakeSafely()
      }
    } finally {
      starting = false
    }
  }
}

function idleState(): VoiceState {
  const prefs = $prefs.get().voice

  return prefs.enabled && prefs.wakeWord ? 'armed' : 'off'
}

async function resumeWakeSafely(): Promise<void> {
  const generation = conversationGeneration
  try {
    await resumeWake()
  } catch {
    if (generation !== conversationGeneration) return
    const message = uiT('voice.wake.resumeFailed')
    // Keep diagnostics useful without logging backend details or overwriting the original failure.
    console.warn('[voice] Wake rearm failed')
    if (!$voice.get().error) patch({ error: message })
    notify({ title: uiT('ui.030a96f380e3'), body: message, level: 'warn' })
  }
}

export function endConversation(reason: ConversationEndReason = 'user', detail?: string): Promise<void> {
  if (!ending) {
    ending = finishConversation(reason, detail).finally(() => { ending = null })
  }
  return ending
}

async function finishConversation(reason: ConversationEndReason, detail?: string): Promise<void> {
  conversationGeneration++
  requests++
  const current = engine
  engine = null
  hermesActed = false
  visibleVoiceSessionId = null
  $voiceApprovalSessionId.set(null)
  $voiceSessionId.set(null)
  stopFallbackAudio()

  for (const turn of sentTurns.values()) {
    turn.release()
  }

  sentTurns.clear()

  if (current) {
    try {
      await current.stop()
    } catch {
      // Teardown is best effort.
    }
  }

  const error = reason === 'error' || reason === 'connection-lost' ? (detail ?? 'The conversation ended unexpectedly.') : null
  // The wake word keeps the microphone open after a conversation, and must not inherit its mute.
  setMicrophoneMuted(false)
  patch({ state: idleState(), engine: null, muted: false, error, startedBy: null })

  if (error) {
    earcons.error()
    notify({ title: uiT("ui.7305bce63f34"), body: error, level: 'warn' })
  } else if (reason === 'cap') {
    earcons.end()
    notify({ title: uiT("ui.8e14cc951719"), body: detail ?? 'The Live daily cap was reached; the free engine still works.', level: 'info' })
  } else if (reason !== 'silence') {
    earcons.end()
  }

  await resumeWakeSafely()
}

export function stopVoice(): Promise<void> {
  return endConversation('user')
}

/**
 * Hand a final transcript to the running conversation, exactly where the microphone path hands its
 * own (typed fallback, tests). False when no conversation runs or its engine hears only by itself.
 */
export async function submitVoiceTranscript(text: string): Promise<boolean> {
  if (!engine?.submitTranscript) {
    return false
  }

  await engine.submitTranscript(text)

  return true
}

export function toggleVoice(reason: VoiceStartReason = 'button'): Promise<void> {
  return engine || starting ? endConversation('user') : startVoice(reason)
}

export function toggleMute(): void {
  const muted = !$voice.get().muted
  setMicrophoneMuted(muted)
  engine?.setMuted(muted)
  patch({ muted })
}

/** The orb's "stop talking" button: cut speech, keep the conversation. */
export function interruptSpeech(): void {
  engine?.interrupt()
}

/** Live engine progress: seconds in the current paid session. */
export function setLiveSessionSeconds(seconds: number): void {
  patch({ live: { ...$voice.get().live, sessionSeconds: seconds } })
}

/** Speak a line, switching the Hermes TTS provider to the free one when the configured one cannot run. */
export function speakWithFreeFallback(text: string, signal?: { stopped: boolean }): Promise<void> {
  return withProviderFallback(
    'tts',
    () => speakOnce(text, signal),
    (from, to) => notify({ title: uiT("ui.0dbd73161aa8"), body: uiT("ui.e3bbf0fd3ec4", { value1: String(from ?? 'The configured provider'), value2: String(to) }), level: 'info' })
  )
}

let announcing: { stopped: boolean } | null = null

/** Speak a notification body when the user opted in and nothing else is talking. */
async function announce(text: string): Promise<void> {
  const prefs = $prefs.get().voice

  if (!prefs.enabled || !prefs.announceNotifications || $prefs.get().doNotDisturb || engine || announcing) {
    return
  }

  const spoken = sanitizeForSpeech(text).slice(0, 600)

  if (!spoken) {
    return
  }

  announcing = { stopped: false }

  try {
    await speakWithFreeFallback(spoken, announcing)
  } catch {
    // Announcements are optional; the toast already showed the text.
  } finally {
    announcing = null
  }
}

/** Handle a voice command from the CLI, another surface, or the global hotkey. */
export function handleVoiceCommand(action: string, reason: VoiceStartReason): void {
  switch (action) {
    case 'toggle':
      void toggleVoice(reason)
      break
    case 'start':
      void startVoice(reason)
      break
    case 'stop':
      void endConversation('user')
      break
    case 'mute':
      toggleMute()
      break
    default:
      break
  }
}

let bound = false

let tuningStt = false

/** Once per install: switch local transcription to the accurate model and teach it Herald OS words. */
async function tuneLocalStt(): Promise<void> {
  if (presentationPlatform($env.get()?.platform) === 'win32') {
    return
  }
  const voice = $prefs.get().voice

  if (tuningStt || voice.sttTuned || !voice.enabled) {
    return
  }

  tuningStt = true

  try {
    const patch = sttTuningPatch(await rest.get<LocalSttConfig>('/api/config'))

    if (patch) {
      await rest.put('/api/config', { config: patch })
    }

    await updatePrefs({ voice: { ...$prefs.get().voice, sttTuned: true } })
  } catch (error) {
    console.warn('[voice] could not tune local speech recognition', error)
  } finally {
    tuningStt = false
  }
}

/** Wire the voice layer once per renderer window; only the Hermes window runs conversations. */
export function bindVoice(): () => void {
  if (bound || !isMainSurface) {
    return () => undefined
  }

  bound = true
  patch({ state: idleState(), live: { ...$voice.get().live, todaySeconds: liveSecondsToday() } })

  const offPrefs = $prefs.subscribe(prefs => {
    if (!engine && !starting) {
      const next = prefs.voice.enabled && prefs.voice.wakeWord ? 'armed' : 'off'

      if ($voice.get().state !== next) {
        patch({ state: next })
      }
    }

    if (!prefs.voice.enabled && engine) {
      void endConversation('user')
    }

    if (prefs.voice.enabled && !prefs.voice.sttTuned && $gatewayReady.get()) {
      void tuneLocalStt()
    }
  })
  const offHotkey = window.heraldOS.voice?.onHotkey?.(() => handleVoiceCommand('toggle', 'hotkey')) ?? (() => undefined)
  const offCommand = onShellCommand(command => {
    if (command.type === 'voice') {
      handleVoiceCommand(command.args?.[0] ?? 'toggle', 'command')
    } else if (command.type.startsWith('voice-')) {
      handleVoiceCommand(command.type.slice('voice-'.length), 'command')
    }
  })
  const offNotify = onGatewayEvent('notification.show', event => {
    const text = event.payload?.text

    if (text) {
      void announce(text)
    }
  })
  const offReady = $gatewayReady.subscribe(ready => {
    if (!ready && engine) {
      void endConversation('connection-lost', 'Lost the connection to Hermes.')
    }

    if (ready) {
      void tuneLocalStt()
    }
  })
  // A change of device caused by the system waits for a conversation to end; the graph needs to know
  // when one is listening. A change the person made in the picker applies at once and does not wait.
  const offActive = $voiceActive.subscribe(active => setCaptureConversing(active))
  const offMicrophone = $captureNotice.listen(notice => {
    if (notice) {
      const prefix = 'The microphone could not be reopened: '
      const body = notice.key === 'voice.input-flapping' ? uiT('ui.e2143ff64352')
        : notice.key === 'voice.input-retry-paused' ? uiT('ui.732bd0d33f2d')
          : notice.key === 'voice.input-reopen-failed' && notice.message.startsWith(prefix)
            ? uiT('ui.a2decc9066d4', { value1: notice.message.slice(prefix.length) }) : notice.message
      notify({ title: uiT("ui.186352a881d0"), body, level: 'info', surface: 'chat', key: notice.key })
      acknowledgeCaptureNotice()
    }
  })

  return () => {
    offPrefs()
    offHotkey()
    offCommand()
    offNotify()
    offReady()
    offActive()
    offMicrophone()
    bound = false
  }
}
