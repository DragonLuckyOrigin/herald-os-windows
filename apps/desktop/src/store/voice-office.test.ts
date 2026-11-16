import type { GatewayEvent, GatewayEventHub } from '@herald-os/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// A spoken request with Herald Slides in front, through the voice store, the chained engine, the
// matcher with the whole command registry, the chat store and the Office context line, all real.
// Fake: Hermes's socket (below, a session that queues a prompt sent while a turn runs, as Hermes's
// default busy mode does once that turn is told to stop), the microphone and the speakers.
const edges = vi.hoisted(() => {
  const presence: unknown[] = []
  const heraldOS = {
    shell: { surface: 'desktop', mode: 'desktop' },
    prefs: { get: async () => ({}), set: async (patch: Record<string, unknown>) => patch, onChanged: () => () => undefined },
    office: { presence: async () => presence },
    voice: { onHotkey: () => () => undefined, audioWsUrl: async () => 'ws://speech.invalid' },
    backend: { rest: async () => ({}) as unknown },
    notifications: { native: async () => undefined }
  }

  Object.assign(globalThis, { window: { innerWidth: 1440, innerHeight: 900, heraldOS }, document: { activeElement: null, documentElement: { dataset: {}, style: { removeProperty: () => {}, setProperty: () => {} } } } })

  return {
    heraldOS,
    presence,
    spoken: [] as string[],
    requests: [] as Array<{ method: string; params: Record<string, unknown> }>,
    microphone: null as null | ((frame: { pcm: Int16Array; level: number; ms: number }) => void),
    /** The speech socket closes before it says anything. */
    speechCloses: false,
    hermes: null as null | ((method: string, params: Record<string, unknown>) => unknown)
  }
})

vi.mock('./gateway.ts', async () => {
  const { atom } = await import('nanostores')
  const { GatewayEventHub } = await import('@herald-os/client')
  const hub = new GatewayEventHub()
  let sessions = 0

  return {
    hub,
    $connection: atom('open'),
    $gatewayReady: atom({ version: 'test' }),
    $connectionEpoch: atom(0),
    bindGatewayToBackend: () => () => undefined,
    isGatewayOpen: () => false,
    onServerRequest: () => () => undefined,
    onGatewayEvent: (type: string, handler: (event: GatewayEvent) => void) => hub.on(type as GatewayEvent['type'], handler),
    onAnyGatewayEvent: (handler: (event: GatewayEvent) => void) => hub.onAny(handler),
    gatewayRequest: async (method: string, params: Record<string, unknown>) => {
      edges.requests.push({ method, params })

      if (method === 'session.create') {
        sessions += 1

        return { session_id: `runtime-${sessions}`, stored_session_id: `stored-${sessions}`, info: {}, messages: [] }
      }

      if (method === 'session.resume') {
        return { session_id: `resumed-${params.session_id}`, stored_session_id: params.session_id, info: {}, messages: [] }
      }

      if (method === 'session.set_hidden') {
        const runtime = String(params.session_id)
        const stored = runtime.startsWith('resumed-') ? runtime.slice('resumed-'.length) : runtime.replace(/^runtime-/, 'stored-')

        return { hidden: true, session_key: stored }
      }

      return edges.hermes?.(method, params) ?? {}
    }
  }
})

vi.mock('../lib/voice/audio-capture.ts', async () => {
  const { atom } = await import('nanostores')

  return {
    $micOpen: atom(false),
    $micLevel: atom(0),
    $micDevice: atom(null),
    $inputDevices: atom({ devices: [], labelsAvailable: false }),
    $captureNotice: atom(null),
    refreshInputDevices: async () => ({ devices: [], labelsAvailable: false }),
    setCaptureConversing: () => undefined,
    acknowledgeCaptureNotice: () => undefined,
    preferredInputDevice: () => null,
    MicrophoneUnavailableError: class extends Error {},
    setMicrophoneMuted: () => undefined,
    isMicrophoneOpen: () => true,
    holdMicrophoneStream: async () => ({ stream: {}, release: () => undefined }),
    subscribeMicrophone: async (listener: (frame: { pcm: Int16Array; level: number; ms: number }) => void) => {
      edges.microphone = listener

      return () => {
        edges.microphone = null
      }
    }
  }
})

vi.mock('../lib/voice/speak-stream.ts', async () => {
  const { atom } = await import('nanostores')

  class SpeakStream {
    private text = ''
    private started = false
    private ended = false

    constructor(private readonly handlers: { onStart?: () => void; onEnd?: (reason: string, error?: string) => void } = {}) {
      if (edges.speechCloses) {
        queueMicrotask(() => this.finish('drained'))
      }
    }

    get speaking() {
      return this.started && !this.ended
    }

    feed(text: string) {
      if (!this.ended) {
        this.text += text
      }
    }

    done() {
      queueMicrotask(() => {
        if (!this.ended && this.text.trim()) {
          this.started = true
          this.handlers.onStart?.()
          edges.spoken.push(this.text.trim())
        }

        this.finish('drained')
      })
    }

    stop() {
      this.finish('stopped')
    }

    private finish(reason: string) {
      if (!this.ended) {
        this.ended = true
        this.handlers.onEnd?.(reason)
      }
    }
  }

  return {
    $speakLevel: atom(0),
    SpeakStream,
    stopFallbackAudio: () => undefined,
    speakOnce: async (text: string) => {
      if (text.trim()) {
        edges.spoken.push(text.trim())
      }
    }
  }
})

vi.mock('../lib/voice/earcons.ts', () => ({ earcons: new Proxy({}, { get: () => () => undefined }) }))

const { registerOsCommands } = await import('../commands/index.ts')
const { $prefs, $prefsLoaded, $env } = await import('./backend.ts')
const { $activeChatId, $chats, bindChatEvents, createChat, resetChats, sendPrompt } = await import('./chat.ts')
const { $sessions } = await import('./sessions.ts')
const { $missions } = await import('./missions.ts')
const { $connectionEpoch } = await import('./gateway.ts')
const { hub } = (await import('./gateway.ts')) as unknown as { hub: GatewayEventHub }
const { $notifications } = await import('./notifications.ts')
const { $voice, $voiceSessionId, bindVoice, resolveEngine, todayKey, endConversation, runVoiceIntent, startVoice, submitVoiceTranscript } = await import('./voice.ts')

const REQUEST = 'Add speaker notes to every slide.'
const REPLY = 'I added speaker notes to all six slides.'
const DECK = { app: 'slides', at: 1, active: 'deck-1', documents: [{ key: 'deck-1', path: '/Users/demo/Pitch.pptx', name: 'Pitch.pptx', format: 'pptx', modified: false, detail: 'slide 1 of 6' }] }

/** One Hermes session: a prompt sent while a turn runs waits behind it ("queue") or joins it and goes down with it ("fold"). */
const hermes = {
  running: new Set<string>(),
  waiting: new Map<string, string>(),
  busy: 'queue' as 'queue' | 'fold',
  /** How long a running Office call takes to stop once Hermes is told to stop. */
  stopMs: 40,
  refuse: '',
  /** Answer before the submit's own answer arrives. */
  early: false,
  /** What a turn does once it runs; one that never ends is a long Office call. */
  turn: (sessionId: string, _text: string): void => notesTurn(sessionId)
}

function emit(sessionId: string, type: string, payload?: Record<string, unknown>): void {
  if (type === 'message.complete') {
    hermes.running.delete(sessionId)
  }

  hub.dispatch({ type, session_id: sessionId, payload } as GatewayEvent)

  const next = type === 'message.complete' ? hermes.waiting.get(sessionId) : undefined

  if (next !== undefined) {
    hermes.waiting.delete(sessionId)
    run(sessionId, next)
  }
}

function run(sessionId: string, text: string): void {
  hermes.running.add(sessionId)

  if (hermes.early) {
    hermes.turn(sessionId, text)
  } else {
    setTimeout(() => hermes.turn(sessionId, text), 5)
  }
}

function stopTurn(sessionId: string): void {
  setTimeout(() => {
    if (hermes.running.has(sessionId)) {
      emit(sessionId, 'message.complete', { text: '', status: 'interrupted' })
    }
  }, hermes.stopMs)
}

edges.hermes = (method, params) => {
  const sessionId = String(params.session_id)

  if (method === 'session.interrupt') {
    stopTurn(sessionId)

    return {}
  }

  if (method !== 'prompt.submit') {
    return {}
  }

  if (hermes.refuse) {
    throw new Error(hermes.refuse)
  }

  if (hermes.running.has(sessionId)) {
    if (hermes.busy === 'queue') {
      hermes.waiting.set(sessionId, String(params.text))
    }

    stopTurn(sessionId)

    return { status: hermes.busy === 'queue' ? 'queued' : 'redirected' }
  }

  run(sessionId, String(params.text))

  return { status: 'streaming' }
}

/** Hermes reads the deck, writes the notes and says so. */
function notesTurn(sessionId: string, reply = REPLY): void {
  emit(sessionId, 'message.start')
  emit(sessionId, 'tool.start', { tool_id: 'read', name: 'slides', args: { action: 'read' } })
  emit(sessionId, 'tool.complete', { tool_id: 'read', name: 'slides', args: { action: 'read' } })
  emit(sessionId, 'tool.start', { tool_id: 'notes', name: 'slides', args: { action: 'edit' } })
  emit(sessionId, 'tool.complete', { tool_id: 'notes', name: 'slides', args: { action: 'edit' } })

  if (reply) {
    emit(sessionId, 'message.delta', { text: reply })
  }

  emit(sessionId, 'message.complete', { text: reply, status: 'complete' })
}

/** Slides from a document: an Office call still running. */
function officeCall(sessionId: string): void {
  emit(sessionId, 'message.start')
  emit(sessionId, 'tool.start', { tool_id: 'deck', name: 'slides', args: { action: 'from_document' } })
}

const prompts = () => edges.requests.filter(request => request.method === 'prompt.submit').map(request => request.params.text)
const officeCallRunning = () => Object.values($chats.get())[0]?.messages.some(message => message.role === 'tool' && message.toolId === 'deck' && message.running) ?? false
const toasts = () => $notifications.get().map(notification => `${notification.title}: ${notification.body ?? ''}`)
const frame = (level: number) => ({ pcm: new Int16Array(1600), level, ms: 100 })

beforeAll(() => {
  registerOsCommands()
  bindChatEvents()
})

beforeEach(() => {
  $env.set(null)
  edges.presence.splice(0, edges.presence.length, DECK)
  edges.spoken.length = 0
  edges.requests.length = 0
  edges.speechCloses = false
  Object.assign(hermes, { busy: 'queue', stopMs: 40, refuse: '', early: false, turn: (sessionId: string) => notesTurn(sessionId) })
  hermes.running.clear()
  hermes.waiting.clear()
  resetChats()
  $sessions.set([])
  $connectionEpoch.set($connectionEpoch.get() + 1)
  $prefsLoaded.set(true)
  edges.heraldOS.prefs.set = async patch => ({ ...$prefs.get(), ...patch })
  $notifications.set([])
  $prefs.set({ ...$prefs.get(), operationalVoiceSessionId: undefined, doNotDisturb: false, voice: { ...$prefs.get().voice, enabled: true, engine: 'chained', wakeWord: false, followUpSeconds: 8 } })
})

afterEach(async () => {
  vi.useRealTimers()
  await endConversation('user')
})

describe('Windows voice ownership', () => {
  it('rejects unavailable Live without selecting the chained engine', async () => {
    $env.set({ platform: 'win32' } as NonNullable<ReturnType<typeof $env.get>>)
    await expect(resolveEngine({ ...$prefs.get().voice, engine: 'live', liveDailyCapMinutes: 10 })).rejects.toThrow()
    await expect(resolveEngine({ ...$prefs.get().voice, engine: 'chained' })).resolves.toEqual({ engine: 'chained', fallbackReason: null })
  })

  it('rejects the exhausted Live budget without another engine', async () => {
    $env.set({ platform: 'win32' } as NonNullable<ReturnType<typeof $env.get>>)
    await expect(resolveEngine({ ...$prefs.get().voice, engine: 'live', liveDailyCapMinutes: 1, liveUsage: { day: todayKey(), seconds: 60 } })).rejects.toThrow(/cap|Tageslimit/)
  })

  it('does not read or tune Core speech configuration from either subscription', async () => {
    $env.set({ platform: 'win32' } as NonNullable<ReturnType<typeof $env.get>>)
    $prefs.set({ ...$prefs.get(), voice: { ...$prefs.get().voice, enabled: true, sttTuned: false } })
    const calls = vi.spyOn(edges.heraldOS.backend, 'rest')
    const off = bindVoice()
    $prefs.set({ ...$prefs.get(), voice: { ...$prefs.get().voice, hotkey: 'Ctrl+Shift+V' } })
    await Promise.resolve()
    expect(calls).not.toHaveBeenCalled()
    expect($prefs.get().voice.sttTuned).toBe(false)
    off()
    calls.mockRestore()
  })

  it('retains non-Windows explicit Live fallback behavior', async () => {
    $env.set({ platform: 'darwin' } as NonNullable<ReturnType<typeof $env.get>>)
    await expect(resolveEngine({ ...$prefs.get().voice, engine: 'live', liveDailyCapMinutes: 0 })).resolves.toMatchObject({ engine: 'chained' })
  })
})

describe('a spoken request with Herald Slides in front', () => {
  it('reaches Hermes with the deck in its context and speaks the reply', async () => {
    await startVoice('button')
    await submitVoiceTranscript(REQUEST)
    await vi.waitFor(() => expect(edges.spoken).toEqual([REPLY]))

    const submit = edges.requests.find(request => request.method === 'prompt.submit')
    expect(submit?.params).toMatchObject({ text: REQUEST, surface: 'voice-live' })
    expect(String(submit?.params.voice_context)).toContain('Office: in front is Pitch.pptx in Herald Slides')
    await vi.waitFor(() => expect($voice.get().state).toBe('listening'))
  })

  it('says it is done when Hermes edits the deck without a word', async () => {
    hermes.turn = sessionId => notesTurn(sessionId, '')

    await startVoice('button')
    await submitVoiceTranscript(REQUEST)
    await vi.waitFor(() => expect(edges.spoken).toEqual(['Done.']))
    expect($voice.get().captions.assistant).toBe('Done.')
    expect(toasts()).toEqual([])
  })

  it('stops the Office call it is spoken over and answers once that call has ended', async () => {
    hermes.turn = (sessionId, text) => (text === REQUEST ? notesTurn(sessionId) : officeCall(sessionId))

    await startVoice('button')
    await submitVoiceTranscript('Turn my report into slides.')
    await vi.waitFor(() => expect(Object.values($chats.get())[0]?.streaming).toBe(true))
    await submitVoiceTranscript(REQUEST)
    await vi.waitFor(() => expect(edges.spoken).toEqual([REPLY]))

    const methods = edges.requests.map(request => request.method).filter(method => method !== 'session.create' && method !== 'session.set_hidden')
    expect(methods).toEqual(['prompt.submit', 'session.interrupt', 'prompt.submit'])
    expect(hermes.waiting.size).toBe(0)
  })

  it('follows a request queued behind a turn still running in the chat', async () => {
    hermes.turn = (sessionId, text) => (text === REQUEST ? notesTurn(sessionId) : officeCall(sessionId))
    const selected = await createChat()
    await sendPrompt('Turn my report into slides.')
    await vi.waitFor(() => expect(Object.values($chats.get())[0]?.streaming).toBe(true))

    await startVoice('button')
    $sessions.set([{ id: selected.storedSessionId, title: 'Existing' }])
    await runVoiceIntent('open the chat about Existing')
    await submitVoiceTranscript(REQUEST)
    await vi.waitFor(() => expect(edges.spoken).toEqual([REPLY]))
    expect(prompts()).toEqual(['Turn my report into slides.', REQUEST])
  })

  it('says Hermes stopped when the request goes down with the turn it joined', async () => {
    hermes.busy = 'fold'
    hermes.turn = (sessionId, text) => (text === REQUEST ? notesTurn(sessionId) : officeCall(sessionId))
    const selected = await createChat()
    await sendPrompt('Turn my report into slides.')
    // The chat shows busy as soon as the prompt is sent, but the Office call starts on the real clock: it
    // must be running before the fake clock takes over, or it can begin after Hermes has stopped it.
    await vi.waitFor(() => expect(officeCallRunning()).toBe(true))

    await startVoice('button')
    $sessions.set([{ id: selected.storedSessionId, title: 'Existing' }])
    await runVoiceIntent('open the chat about Existing')
    vi.useFakeTimers()
    await submitVoiceTranscript(REQUEST)
    await vi.advanceTimersByTimeAsync(100)
    expect(edges.spoken).toEqual([])
    await vi.advanceTimersByTimeAsync(3000)

    expect(edges.spoken).toEqual(['Hermes stopped before it finished. Please ask again.'])
    expect(toasts()).toEqual(['Hermes: Hermes stopped before it finished. Please ask again.'])
  })

  it('says what went wrong when Hermes refuses the request', async () => {
    hermes.refuse = 'session busy'

    await startVoice('button')
    await submitVoiceTranscript(REQUEST)
    await vi.waitFor(() => expect(edges.spoken).toEqual(['Sorry, that request failed.']))
    expect(toasts()).toEqual(['Hermes turn failed: session busy'])
    await vi.waitFor(() => expect($voice.get().state).toBe('listening'))
  })

  it('speaks a reply whose turn ended before the submit was answered', async () => {
    hermes.early = true

    await startVoice('button')
    await submitVoiceTranscript(REQUEST)
    await vi.waitFor(() => expect(edges.spoken).toEqual([REPLY]))
  })

  it('says the reply in one go when the speech stream closes before it speaks', async () => {
    edges.speechCloses = true

    await startVoice('button')
    await submitVoiceTranscript(REQUEST)
    await vi.waitFor(() => expect(edges.spoken).toEqual([REPLY]))
  })

  it('says it could not make the words out when transcription fails', async () => {
    edges.heraldOS.backend.rest = async () => {
      throw new Error('The transcription timed out')
    }

    try {
      await startVoice('button')

      for (const level of [0.2, 0.2, 0.2, 0, 0, 0, 0, 0, 0, 0, 0]) {
        edges.microphone?.(frame(level))
      }

      await vi.waitFor(() => expect(edges.spoken).toEqual(['Sorry, I could not make that out. Please say it again.']))
      expect(toasts()).toEqual(['Transcription failed: The transcription timed out'])
      expect(prompts()).toEqual([])
    } finally {
      edges.heraldOS.backend.rest = async () => ({})
    }
  })
})

describe('native voice session routing through the real client stores and engine', () => {
  const say = async (text: string) => {
    expect(await submitVoiceTranscript(text)).toBe(true)
    await vi.waitFor(() => expect($voice.get().state).toBe('listening'))
  }
  const lastPrompt = () => edges.requests.filter(request => request.method === 'prompt.submit').at(-1)!.params

  it('routes spoken cancellation only to the voice session while an unrelated visible chat runs', async () => {
    const unrelated = await createChat({ title: 'Independent task' })
    await startVoice('button')
    await say('Operational voice turn.')
    const operational = $voiceSessionId.get()!
    for (const session of [unrelated.sessionId, operational]) {
      hermes.running.add(session)
      emit(session, 'message.start')
    }
    expect(await runVoiceIntent('cancel that')).toMatchObject({ handled: true, ok: true })
    expect(edges.requests.filter(request => request.method === 'session.interrupt')).toEqual([
      { method: 'session.interrupt', params: { session_id: operational } }
    ])
    expect($chats.get()[unrelated.sessionId].streaming).toBe(true)
  })

  it('does not cancel the visible chat when voice has no native target yet', async () => {
    const unrelated = await createChat({ title: 'Independent task' })
    emit(unrelated.sessionId, 'message.start')
    await startVoice('button')
    expect(await runVoiceIntent('cancel that')).toMatchObject({ handled: true, ok: true })
    expect(edges.requests.filter(request => request.method === 'session.interrupt')).toEqual([])
    expect($chats.get()[unrelated.sessionId].streaming).toBe(true)
  })

  it('holds a confirmed create when the real prefs IPC does not retain its stored reference', async () => {
    edges.heraldOS.prefs.set = async () => $prefs.get() as unknown as Record<string, unknown>
    await startVoice('button')
    await say('First operational request.')
    await say('Second operational request.')
    expect(prompts()).toEqual([])
    expect(edges.requests.filter(request => request.method === 'session.create' && request.params.hidden === true)).toHaveLength(1)
    expect($prefs.get().operationalVoiceSessionId).toBeUndefined()

    // Once persistence is healthy, a new conversation recovers the confirmed key without another create.
    edges.heraldOS.prefs.set = async patch => ({ ...$prefs.get(), ...patch }) as Record<string, unknown>
    await endConversation()
    await startVoice('button')
    await say('Recovered operational request.')
    expect(edges.requests.filter(request => request.method === 'session.create' && request.params.hidden === true)).toHaveLength(1)
    expect($prefs.get().operationalVoiceSessionId).toBeTruthy()
  })

  it('keeps operational voice hidden, opts into a new visible chat, and returns without copying history', async () => {
    const unrelated = await createChat({ title: 'Unrelated visible chat' })
    await startVoice('button')
    await say('Private operational note: violet lantern 37.')
    const operational = $voiceSessionId.get()!
    expect(operational).not.toBe(unrelated.sessionId)
    expect($activeChatId.get()).toBe(unrelated.sessionId)
    expect($prefs.get().operationalVoiceSessionId).toBe($chats.get()[operational].storedSessionId)
    expect(edges.requests.filter(request => request.method === 'session.create' && request.params.hidden === true)).toHaveLength(1)
    expect($chats.get()[unrelated.sessionId].messages).toEqual([])
    expect($missions.get().some(mission => mission.runtimeId === operational)).toBe(false)
    expect($missions.get().some(mission => mission.runtimeId === unrelated.sessionId)).toBe(true)

    await say('Neuer Chat')
    const visible = $activeChatId.get()!
    expect(visible).not.toBe(operational)
    expect(visible).not.toBe(unrelated.sessionId)
    expect($chats.get()[visible].messages).toEqual([])
    const visibleCreate = edges.requests.filter(request => request.method === 'session.create').at(-1)!.params
    expect(visibleCreate.hidden).toBeUndefined()
    expect(visibleCreate.messages).toBeUndefined()
    await say('Visible note: silver compass 42.')
    expect(lastPrompt().session_id).toBe(visible)
    expect(String(lastPrompt().voice_context ?? '')).not.toContain('violet lantern')

    $activeChatId.set(unrelated.sessionId)
    await say('Continue the selected voice chat.')
    expect(lastPrompt().session_id).toBe(visible)
    await say('Beende den Sprachchat')
    expect($activeChatId.get()).toBe(unrelated.sessionId)
    await say('Continue operational voice.')
    expect(lastPrompt().session_id).toBe(operational)
    expect(String(lastPrompt().voice_context ?? '')).not.toContain('silver compass')
    expect($chats.get()[visible].messages.some(message => message.role === 'user' && message.text.includes('silver compass'))).toBe(true)
    expect($chats.get()[unrelated.sessionId].messages).toEqual([])
    expect(edges.requests.filter(request => request.method === 'session.set_hidden')).toEqual([{ method: 'session.set_hidden', params: { session_id: operational, hidden: true } }])
    expect(edges.requests.some(request => request.method === 'session.delete')).toBe(false)

    await endConversation()
    await startVoice('button')
    await say('After sleep, continue operational voice.')
    expect(lastPrompt().session_id).toBe(operational)
    expect(edges.requests.filter(request => request.method === 'session.create' && request.params.hidden === true)).toHaveLength(1)
  })

  it('resumes the persisted native operational reference after the renderer chat cache is lost', async () => {
    await startVoice('button')
    await say('Before reconnect.')
    const storedId = $prefs.get().operationalVoiceSessionId!
    await endConversation()
    resetChats()
    $connectionEpoch.set($connectionEpoch.get() + 1)
    const unrelated = await createChat({ title: 'Another visible chat' })
    await startVoice('button')
    await say('After reconnect.')
    expect(edges.requests.filter(request => request.method === 'session.resume')).toEqual([{ method: 'session.resume', params: { session_id: storedId, source: 'herald_os' } }])
    expect(edges.requests.filter(request => request.method === 'session.set_hidden').at(-1)).toEqual({ method: 'session.set_hidden', params: { session_id: `resumed-${storedId}`, hidden: true } })
    expect(lastPrompt().session_id).toBe(`resumed-${storedId}`)
    expect($chats.get()[`resumed-${storedId}`].hidden).toBe(true)
    expect($missions.get().some(mission => mission.runtimeId === `resumed-${storedId}`)).toBe(false)
    expect($activeChatId.get()).toBe(unrelated.sessionId)
    expect(edges.requests.filter(request => request.method === 'session.create' && request.params.hidden === true)).toHaveLength(1)
  })
})
