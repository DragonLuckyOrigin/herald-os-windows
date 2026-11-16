import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceHost } from '../lib/voice/engine.ts'
import { VOICE_DEFAULTS } from '../../shared/voice-prefs.ts'
import { defineCommands, resetCommands } from './os-commands.ts'
import type { PendingRequest } from './requests.ts'
import { emptyChat } from '../lib/chat-model.ts'

const edges = vi.hoisted(() => {
  const hide = vi.fn(async () => undefined)
  const show = vi.fn(async () => undefined)
  Object.assign(globalThis, { window: { innerWidth: 1440, innerHeight: 900, heraldOS: { window: { hide, show } } }, document: { activeElement: null } })
  return {
    hide,
    show,
    host: null as VoiceHost | null,
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    liveStatus: vi.fn(async () => ({ mode: 'gpt-live', available: true, reason: null, model: 'test', voice: 'test' })),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    context: vi.fn(async () => ''),
    releaseListener: vi.fn(),
    resolveRequest: vi.fn(),
    gatewayEvents: new Map<string, (event: unknown) => void>(),
    interrupt: vi.fn(async (_session?: string) => {}),
    prepareLocalInterrupt: vi.fn(),
    create: vi.fn(),
    resumeSession: vi.fn(),
    savePrefs: vi.fn(),
    dispatch: (options: unknown) => (options as { onDispatch?: () => void }).onDispatch?.(),
    send: vi.fn(async (_text: string, options: unknown) => {
      const pending = options as { sessionId: string; onDispatch?: () => void }
      pending.onDispatch?.()
      return pending.sessionId as string | null
    })
  }
})
vi.mock('./backend.ts', () => {
  const prefs = atom({ voice: { ...VOICE_DEFAULTS, enabled: true, wakeWord: true } })
  return {
    $prefs: prefs,
    $prefsLoaded: atom(true), $env: atom({ platform: 'win32' }),
    $windowState: atom({ fullscreen: false, focused: true }),
    updatePrefs: async (patch: Record<string, unknown>) => { await edges.savePrefs(patch); prefs.set({ ...prefs.get(), ...patch }) }
  }
})
vi.mock('./gateway.ts', () => ({
  $gatewayReady: atom({ version: 'test' }), $connectionEpoch: atom(0), gatewayRequest: async () => ({}),
  onGatewayEvent: (name: string, callback: (event: unknown) => void) => {
    edges.gatewayEvents.set(name, callback)
    return () => { edges.releaseListener(name); edges.gatewayEvents.delete(name) }
  }
}))
vi.mock('./chat.ts', async () => {
  const { emptyChat: makeChat } = await import('../lib/chat-model.ts')
  const active = atom<string | null>('unrelated')
  const chats = atom<Record<string, ReturnType<typeof makeChat>>>({ unrelated: makeChat('unrelated', 'stored-unrelated') })

  return {
    $activeChatId: active,
    $chats: chats,
    createChat: edges.create,
    openStoredSession: edges.resumeSession,
    forgetChat: (sessionId: string) => {
      const next = { ...chats.get() }
      delete next[sessionId]
      chats.set(next)
      if (active.get() === sessionId) active.set(null)
    },
    interruptChat: edges.interrupt,
    sendPrompt: edges.send
  }
})
vi.mock('./on-screen.ts', () => ({ officeContextLine: edges.context, screenContextLine: () => '' }))
vi.mock('./notifications.ts', async importOriginal => ({ ...(await importOriginal<object>()), notify: vi.fn() }))
vi.mock('./requests.ts', async importOriginal => ({ ...(await importOriginal<object>()), resolveRequest: edges.resolveRequest }))
vi.mock('./wake.ts', () => {
  const wake = atom({ listening: true, paused: false, phrase: 'hey dragon', capture: 'client', error: null as string | null })
  return {
    $wake: wake,
    pauseWake: async () => {
      await edges.pause()
      wake.set({ ...wake.get(), paused: true })
    },
    resumeWake: async () => {
      await edges.resume()
      wake.set({ ...wake.get(), listening: true, paused: false, error: null })
    }
  }
})
vi.mock('./voice-live-status.ts', () => ({ fetchLiveStatus: edges.liveStatus }))
vi.mock('./shell.ts', () => ({ isMainSurface: true, onShellCommand: () => () => {} }))
vi.mock('../lib/voice/earcons.ts', () => ({ earcons: new Proxy({}, { get: () => () => {} }) }))
vi.mock('../lib/voice/chained-engine.ts', () => ({
  ChainedEngine: class {
    constructor(private readonly host: VoiceHost) { edges.host = host }
    start = edges.start
    stop = edges.stop
    interrupt = () => { void this.host.interrupt() }
    prepareLocalInterrupt = edges.prepareLocalInterrupt
  }
}))

const voice = await import('./voice.ts')
const { systemCommands } = await import('../commands/system.ts')
const { $activeChatId, $chats } = await import('./chat.ts')
const { $connectionEpoch } = await import('./gateway.ts')
const { $env, $prefs, $prefsLoaded } = await import('./backend.ts')
const { $pendingRequests } = await import('./requests.ts')
const { notify } = await import('./notifications.ts')
const { $wake } = await import('./wake.ts')
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  $env.set({ platform: 'win32', hermesHome: 'C:\\test\\.hermes', homeDir: 'C:\\test', version: 'test', isDev: false, shellMode: 'desktop' })
  edges.savePrefs.mockReset()
  edges.hide.mockReset().mockResolvedValue(undefined)
  edges.show.mockReset().mockResolvedValue(undefined)
  $prefsLoaded.set(true)
  edges.host = null
  edges.gatewayEvents.clear()
  $pendingRequests.set([])
  $wake.set({ listening: true, paused: false, phrase: 'hey dragon', capture: 'client', error: null })
  resetCommands()
  $prefs.set({ ...$prefs.get(), operationalVoiceSessionId: undefined, voice: { ...$prefs.get().voice, engine: 'chained' } })
  $connectionEpoch.set($connectionEpoch.get() + 1)
  $chats.set({ unrelated: emptyChat('unrelated', 'stored-unrelated') })
  edges.create.mockImplementation(async () => {
    const chat = emptyChat('voice-session', 'stored-voice')
    $chats.set({ ...$chats.get(), [chat.sessionId]: chat })
    return chat
  })
  edges.resumeSession.mockImplementation(async (storedId: string) => {
    const existing = Object.values($chats.get()).find(chat => chat.storedSessionId === storedId)
    const chat = existing ?? emptyChat('resumed-voice', storedId)
    $chats.set({ ...$chats.get(), [chat.sessionId]: chat })
    return chat
  })
  $activeChatId.set('unrelated')
})
afterEach(async () => { await voice.endConversation() })

describe('voice lifecycle stays within its own conversation', () => {
  it('creates and remembers only one hidden native target, independently of chat navigation', async () => {
    await voice.startVoice()
    await edges.host!.submit('first', {})
    $activeChatId.set('another-visible-chat')
    await edges.host!.submit('second', {})
    expect(edges.create).toHaveBeenCalledExactlyOnceWith({ hidden: true, activate: false })
    expect(edges.savePrefs).toHaveBeenCalledExactlyOnceWith({ operationalVoiceSessionId: 'stored-voice' })
    expect(edges.send.mock.calls.map(([, options]) => (options as { sessionId: string }).sessionId)).toEqual(['voice-session', 'voice-session'])
    expect($activeChatId.get()).toBe('another-visible-chat')
  })

  it('coalesces overlapping hidden creation and sends only the still-current request', async () => {
    await voice.startVoice()
    const wait = deferred()
    edges.create.mockImplementationOnce(async () => {
      await wait.promise
      const chat = emptyChat('voice-session', 'stored-voice')
      $chats.set({ ...$chats.get(), [chat.sessionId]: chat })
      return chat
    })
    const first = edges.host!.submit('older', {})
    const second = edges.host!.submit('newer', {})
    wait.resolve()
    expect(await first).toBeNull()
    expect(await second).toBe('voice-session')
    expect(edges.create).toHaveBeenCalledOnce()
    expect(edges.send).toHaveBeenCalledExactlyOnceWith('newer', expect.objectContaining({ sessionId: 'voice-session' }))
  })

  it('does not dispatch or activate a chat when conversation end overtakes native creation', async () => {
    await voice.startVoice()
    const wait = deferred()
    edges.create.mockImplementationOnce(async () => {
      await wait.promise
      const chat = emptyChat('voice-session', 'stored-voice')
      $chats.set({ ...$chats.get(), [chat.sessionId]: chat })
      return chat
    })
    const pending = edges.host!.submit('pending creation', {})
    await voice.endConversation()
    wait.resolve()
    expect(await pending).toBeNull()
    expect($activeChatId.get()).toBe('unrelated')
    expect(voice.$voiceSessionId.get()).toBeNull()
    expect(edges.send).not.toHaveBeenCalled()
    expect($prefs.get().operationalVoiceSessionId).toBe('stored-voice')
  })

  it('persists a create that resolves across an epoch change, discards its stale runtime and resumes the same key', async () => {
    await voice.startVoice()
    const wait = deferred()
    edges.create.mockImplementationOnce(async () => {
      await wait.promise
      const chat = emptyChat('old-runtime', 'stored-across-epoch')
      $chats.set({ ...$chats.get(), [chat.sessionId]: chat })
      return chat
    })
    const pending = edges.host!.submit('old transport', {})
    await vi.waitFor(() => expect(edges.create).toHaveBeenCalledOnce())
    $connectionEpoch.set($connectionEpoch.get() + 1)
    wait.resolve()
    await expect(pending).rejects.toThrow('operational voice session')
    expect($prefs.get().operationalVoiceSessionId).toBe('stored-across-epoch')
    expect($chats.get()['old-runtime']).toBeUndefined()
    expect(await edges.host!.submit('new transport', {})).toBe('resumed-voice')
    expect(edges.create).toHaveBeenCalledOnce()
    expect(edges.resumeSession).toHaveBeenCalledExactlyOnceWith('stored-across-epoch', undefined, { activate: false, requireExactId: true, hidden: true })
  })

  it('does not create an alternative when exact native resume fails', async () => {
    $prefs.set({ ...$prefs.get(), operationalVoiceSessionId: 'native-stored' })
    edges.resumeSession.mockRejectedValueOnce(new Error('Synthetic native session missing'))
    await voice.startVoice()
    for (const text of ['first', 'second']) {
      await expect(edges.host!.submit(text, {})).rejects.toThrow('operational voice session')
    }
    expect(edges.resumeSession).toHaveBeenCalledExactlyOnceWith('native-stored', undefined, { activate: false, requireExactId: true, hidden: true })
    expect(edges.create).not.toHaveBeenCalled()
    expect(edges.send).not.toHaveBeenCalled()
  })

  it('does not duplicate a native session or send when its reference cannot be saved', async () => {
    edges.savePrefs.mockRejectedValueOnce(new Error('Synthetic prefs write refused'))
    await voice.startVoice()
    for (const text of ['first', 'second']) {
      await expect(edges.host!.submit(text, {})).rejects.toThrow('operational voice session')
    }
    expect(edges.create).toHaveBeenCalledOnce()
    expect(edges.send).not.toHaveBeenCalled()
    expect($activeChatId.get()).toBe('unrelated')
    expect(voice.$voiceSessionId.get()).toBeNull()

    await voice.endConversation()
    await voice.startVoice()
    expect(await edges.host!.submit('recover exact confirmed id', {})).toBe('voice-session')
    expect(edges.create).toHaveBeenCalledOnce()
    expect(edges.resumeSession).toHaveBeenCalledExactlyOnceWith('stored-voice', undefined, { activate: false, requireExactId: true, hidden: true })
    expect($prefs.get().operationalVoiceSessionId).toBe('stored-voice')
  })

  it('never clears an exact stored reference or creates a replacement for an uncontracted error code', async () => {
    $prefs.set({ ...$prefs.get(), operationalVoiceSessionId: 'missing-native-id' })
    edges.resumeSession.mockRejectedValueOnce(Object.assign(new Error('Synthetic native error'), { code: 4007 }))
    await voice.startVoice()
    for (const text of ['first', 'second']) {
      await expect(edges.host!.submit(text, {})).rejects.toThrow('operational voice session')
    }
    expect(edges.resumeSession).toHaveBeenCalledOnce()
    expect(edges.create).not.toHaveBeenCalled()
    expect(edges.savePrefs).not.toHaveBeenCalled()
    expect($prefs.get().operationalVoiceSessionId).toBe('missing-native-id')
  })

  it('waits for the existing preferences load before creating any session', async () => {
    $prefsLoaded.set(false)
    await voice.startVoice()
    await expect(edges.host!.submit('too early', {})).rejects.toThrow('operational voice session')
    expect(edges.create).not.toHaveBeenCalled()
    expect(edges.resumeSession).not.toHaveBeenCalled()
  })

  it('rejects a malformed saved reference rather than choosing a different session', async () => {
    $prefs.set({ ...$prefs.get(), operationalVoiceSessionId: '' })
    await voice.startVoice()
    await expect(edges.host!.submit('invalid reference', {})).rejects.toThrow('exact stored session')
    expect(edges.create).not.toHaveBeenCalled()
    expect(edges.resumeSession).not.toHaveBeenCalled()
  })

  it('does not let a late explicit chat selection redirect a later conversation', async () => {
    const wait = deferred()
    defineCommands([{ id: 'chat.new', title: 'New chat', description: 'Fixture', tier: 'act', args: [], phrases: ['new chat'], run: async () => {
      await wait.promise
      $chats.set({ ...$chats.get(), chosen: emptyChat('chosen', 'stored-chosen') })
      return { ok: true, summary: 'New chat', data: { sessionId: 'chosen' } }
    } }])
    await voice.startVoice()
    const choosing = edges.host!.runIntent('new chat')
    await voice.endConversation()
    await voice.startVoice()
    wait.resolve()
    expect(await choosing).toMatchObject({ handled: true, ok: false })
    expect(await edges.host!.submit('new conversation', {})).toBe('voice-session')
    expect(edges.send).toHaveBeenCalledExactlyOnceWith('new conversation', expect.objectContaining({ sessionId: 'voice-session' }))
  })

  it('does not silently replace a lost explicitly selected chat with the operational session', async () => {
    defineCommands([{ id: 'chat.open', title: 'Open chat', description: 'Fixture', tier: 'read', args: [], phrases: ['open chosen chat'], run: () => {
      $chats.set({ ...$chats.get(), chosen: emptyChat('chosen', 'stored-chosen') })
      return { ok: true, summary: 'Opened', data: { sessionId: 'chosen' } }
    } }])
    await voice.startVoice()
    expect((await edges.host!.runIntent('open chosen chat')).ok).toBe(true)
    $chats.set({ unrelated: $chats.get().unrelated })
    await expect(edges.host!.submit('lost visible target', {})).rejects.toThrow('selected voice chat')
    expect(edges.create).not.toHaveBeenCalled()
    expect(edges.send).not.toHaveBeenCalled()
    expect(await voice.endVoiceChat()).toBe('ended')
    expect(await edges.host!.submit('operational again', {})).toBe('voice-session')
  })

  it('preserves the selected chat on screen when voice returns to its operational route', async () => {
    defineCommands([{ id: 'chat.open', title: 'Open chat', description: 'Fixture', tier: 'read', args: [], phrases: ['open chosen chat'], run: () => {
      const chosen = emptyChat('chosen', 'stored-chosen')
      $chats.set({ ...$chats.get(), chosen })
      $activeChatId.set(chosen.sessionId)
      return { ok: true, summary: 'Opened', data: { sessionId: chosen.sessionId } }
    } }])
    await voice.startVoice()
    expect((await edges.host!.runIntent('open chosen chat')).ok).toBe(true)
    expect(await voice.endVoiceChat()).toBe('ended')
    expect($activeChatId.get()).toBe('chosen')
  })

  it('keeps a selected route with a pending approval until the approval is answered', async () => {
    const run = vi.fn(() => {
      const chosen = emptyChat('chosen', 'stored-chosen')
      $chats.set({ ...$chats.get(), chosen })
      return { ok: true, summary: 'Opened', data: { sessionId: chosen.sessionId } }
    })
    defineCommands([
      { id: 'chat.open', title: 'Open chat', description: 'Fixture', tier: 'read', args: [], phrases: ['open chosen chat'], run },
      { id: 'chat.new', title: 'New chat', description: 'Fixture', tier: 'act', args: [], phrases: ['new chat'], run }
    ])
    await voice.startVoice()
    expect((await edges.host!.runIntent('open chosen chat')).ok).toBe(true)
    $pendingRequests.set([{ kind: 'approval', receivedAt: 0, request: { id: 'chosen-approval', method: 'approval', params: { session_id: 'chosen' } } } as unknown as PendingRequest])
    run.mockClear()

    expect(await edges.host!.runIntent('new chat')).toMatchObject({ handled: true, ok: false })
    expect(await voice.endVoiceChat()).toBe('approval-pending')
    expect(run).not.toHaveBeenCalled()
    expect(edges.interrupt).not.toHaveBeenCalled()
    expect(edges.prepareLocalInterrupt).not.toHaveBeenCalled()

    $pendingRequests.set([])
    expect(await voice.endVoiceChat()).toBe('ended')
  })

  it('does not let a visible route override explicit approval authority', async () => {
    defineCommands([{ id: 'chat.open', title: 'Open chat', description: 'Fixture', tier: 'read', args: [], phrases: ['open chosen chat'], run: () => {
      const chosen = emptyChat('chosen', 'stored-chosen')
      $chats.set({ ...$chats.get(), chosen })
      return { ok: true, summary: 'Opened', data: { sessionId: chosen.sessionId } }
    } }])
    await voice.startVoice()
    expect((await edges.host!.runIntent('open chosen chat')).ok).toBe(true)
    const authorized = emptyChat('authorized', 'stored-authorized')
    $chats.set({ ...$chats.get(), [authorized.sessionId]: authorized })
    voice.$voiceApprovalSessionId.set(authorized.sessionId)
    $pendingRequests.set([{ kind: 'approval', receivedAt: 0, request: { id: 'visible-approval', method: 'approval', params: { session_id: 'chosen' } } } as unknown as PendingRequest])

    expect(voice.voiceTargetSessionId()).toBe('chosen')
    expect(voice.$voiceAnswerableApprovalId.get()).toBeNull()
    expect(edges.host!.approvalPending()).toBe(false)
    expect(edges.host!.answerApproval('yes')).toBeNull()
    expect(edges.resolveRequest).not.toHaveBeenCalled()
  })

  it('keeps the old route when an approval arrives while a new chat command is still running', async () => {
    const wait = deferred()
    const run = vi.fn(async () => {
      await wait.promise
      const chosen = emptyChat('chosen', 'stored-chosen')
      $chats.set({ ...$chats.get(), chosen })
      return { ok: true, summary: 'Opened', data: { sessionId: chosen.sessionId } }
    })
    defineCommands([{ id: 'chat.open', title: 'Open chat', description: 'Fixture', tier: 'read', args: [], phrases: ['open chosen chat'], run }])
    await voice.startVoice()
    expect(await edges.host!.submit('operational work', {})).toBe('voice-session')
    $chats.set({ ...$chats.get(), 'voice-session': { ...$chats.get()['voice-session'], streaming: true } })

    const opening = edges.host!.runIntent('open chosen chat')
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    $pendingRequests.set([{ kind: 'approval', receivedAt: 0, request: { id: 'late-approval', method: 'approval', params: { session_id: 'voice-session' } } } as unknown as PendingRequest])
    wait.resolve()

    await expect(opening).resolves.toMatchObject({ handled: true, ok: false, spoken: expect.stringContaining('approval') })
    expect(edges.interrupt).not.toHaveBeenCalled()
    expect(edges.prepareLocalInterrupt).not.toHaveBeenCalled()
    expect(edges.host!.approvalPending()).toBe(true)
  })

  it('does not clear a visible route when an approval arrives during its interrupt', async () => {
    defineCommands([{ id: 'chat.open', title: 'Open chat', description: 'Fixture', tier: 'read', args: [], phrases: ['open chosen chat'], run: () => {
      const chosen = emptyChat('chosen', 'stored-chosen')
      $chats.set({ ...$chats.get(), chosen })
      return { ok: true, summary: 'Opened', data: { sessionId: chosen.sessionId } }
    } }])
    await voice.startVoice()
    expect((await edges.host!.runIntent('open chosen chat')).ok).toBe(true)
    $chats.set({ ...$chats.get(), chosen: { ...$chats.get().chosen, streaming: true } })
    const wait = deferred()
    edges.interrupt.mockImplementationOnce(async () => { await wait.promise })

    const ending = voice.endVoiceChat()
    await vi.waitFor(() => expect(edges.interrupt).toHaveBeenCalledExactlyOnceWith('chosen'))
    $pendingRequests.set([{ kind: 'approval', receivedAt: 0, request: { id: 'interrupt-approval', method: 'approval', params: { session_id: 'chosen' } } } as unknown as PendingRequest])
    wait.resolve()

    await expect(ending).resolves.toBe('approval-pending')
    expect(edges.host!.approvalPending()).toBe(true)
    $pendingRequests.set([])
    expect(await voice.endVoiceChat()).toBe('ended')
  })

  it('keeps a selected route when a newer submit overtakes its pending end interrupt', async () => {
    defineCommands([{ id: 'chat.open', title: 'Open chat', description: 'Fixture', tier: 'read', args: [], phrases: ['open chosen chat'], run: () => {
      const chosen = emptyChat('chosen', 'stored-chosen')
      $chats.set({ ...$chats.get(), chosen })
      return { ok: true, summary: 'Opened', data: { sessionId: chosen.sessionId } }
    } }])
    await voice.startVoice()
    expect((await edges.host!.runIntent('open chosen chat')).ok).toBe(true)
    $chats.set({ ...$chats.get(), chosen: { ...$chats.get().chosen, streaming: true } })
    const wait = deferred()
    edges.interrupt.mockImplementationOnce(async () => { await wait.promise })

    const ending = voice.endVoiceChat()
    await vi.waitFor(() => expect(edges.interrupt).toHaveBeenCalledExactlyOnceWith('chosen'))
    expect(await edges.host!.submit('newer selected-chat turn', {})).toBe('chosen')
    wait.resolve()

    await expect(ending).resolves.toBe('unavailable')
    expect(edges.prepareLocalInterrupt).not.toHaveBeenCalled()
    expect(await edges.host!.submit('route remains selected', {})).toBe('chosen')
  })

  it('binds a replayed operational approval before the first new prompt is dispatched', async () => {
    $prefs.set({ ...$prefs.get(), operationalVoiceSessionId: 'stored-replayed' })
    edges.resumeSession.mockImplementationOnce(async storedId => {
      const chat = emptyChat('replayed-runtime', storedId)
      $chats.set({ ...$chats.get(), [chat.sessionId]: chat })
      $pendingRequests.set([{ kind: 'approval', receivedAt: 0, request: { id: 'replayed-approval', method: 'approval', params: { session_id: chat.sessionId } } } as unknown as PendingRequest])
      return chat
    })
    await voice.startVoice()

    await expect(edges.host!.submit('must wait', {})).rejects.toThrow('pending Hermes approval')
    expect(edges.send).not.toHaveBeenCalled()
    expect(edges.host!.approvalPending()).toBe(true)
    expect(edges.host!.answerApproval('yes')).toBe('approve')
    expect(edges.resolveRequest).toHaveBeenCalledExactlyOnceWith('replayed-approval', { choice: 'once' })
  })

  it('answers only the globally frontmost pending approval', async () => {
    await voice.startVoice()
    const current = emptyChat('current-voice', 'stored-current-voice')
    $chats.set({ ...$chats.get(), [current.sessionId]: current })
    voice.$voiceSessionId.set(current.sessionId)
    voice.$voiceApprovalSessionId.set(current.sessionId)
    const other = { kind: 'approval', receivedAt: 0, request: { id: 'other-card', method: 'approval', params: { session_id: 'other-session' } } } as unknown as PendingRequest
    const own = { kind: 'approval', receivedAt: 1, request: { id: 'voice-card', method: 'approval', params: { session_id: current.sessionId } } } as unknown as PendingRequest
    $pendingRequests.set([other, own])

    expect(edges.host!.approvalPending()).toBe(false)
    expect(edges.host!.answerApproval('yes')).toBeNull()
    expect(edges.resolveRequest).not.toHaveBeenCalled()

    $pendingRequests.set([own, other])
    expect(edges.host!.approvalPending()).toBe(true)
    expect(edges.host!.answerApproval('yes')).toBe('approve')
    expect(edges.resolveRequest).toHaveBeenCalledExactlyOnceWith('voice-card', { choice: 'once' })
  })

  it('uses the current approval target when an older dispatch target survives an epoch change', async () => {
    await voice.startVoice()
    const old = emptyChat('old-runtime', 'stored-voice')
    const current = emptyChat('current-runtime', 'stored-voice')
    $chats.set({ ...$chats.get(), [old.sessionId]: old, [current.sessionId]: current })
    voice.$voiceSessionId.set(old.sessionId)
    voice.$voiceApprovalSessionId.set(current.sessionId)
    const own = { kind: 'approval', receivedAt: 0, request: { id: 'current-approval', method: 'approval', params: { session_id: current.sessionId } } } as unknown as PendingRequest
    $pendingRequests.set([own])

    expect(voice.$voiceAnswerableApprovalId.get()).toBe(own.request.id)
    expect(edges.host!.approvalPending()).toBe(true)
    expect(edges.host!.answerApproval('yes')).toBe('approve')
    expect(edges.resolveRequest).toHaveBeenCalledExactlyOnceWith('current-approval', { choice: 'once' })
  })

  it('blocks a route change against the current approval target when an older dispatch target remains', async () => {
    const run = vi.fn(() => ({ ok: true, summary: 'New chat', data: { sessionId: 'new-chat' } }))
    defineCommands([{ id: 'chat.new', title: 'New chat', description: 'Fixture', tier: 'act', args: [], phrases: ['new chat'], run }])
    await voice.startVoice()
    const old = emptyChat('old-runtime', 'stored-voice')
    const current = emptyChat('current-runtime', 'stored-voice')
    $chats.set({ ...$chats.get(), [old.sessionId]: old, [current.sessionId]: current })
    voice.$voiceSessionId.set(old.sessionId)
    voice.$voiceApprovalSessionId.set(current.sessionId)
    $pendingRequests.set([{ kind: 'approval', receivedAt: 0, request: { id: 'current-approval', method: 'approval', params: { session_id: current.sessionId } } } as unknown as PendingRequest])

    await expect(edges.host!.runIntent('new chat')).resolves.toMatchObject({ handled: true, ok: false, spoken: expect.stringContaining('approval') })
    expect(run).not.toHaveBeenCalled()
  })

  it('does not dispatch a prompt when an approval arrives during asynchronous context preparation', async () => {
    const wait = deferred()
    edges.context.mockImplementationOnce(async () => { await wait.promise; return '' })
    await voice.startVoice()

    const submitting = edges.host!.submit('must not overtake approval', {})
    await vi.waitFor(() => expect(edges.context).toHaveBeenCalledOnce())
    $pendingRequests.set([{ kind: 'approval', receivedAt: 0, request: { id: 'pre-dispatch-approval', method: 'approval', params: { session_id: 'voice-session' } } } as unknown as PendingRequest])
    wait.resolve()

    await expect(submitting).rejects.toThrow('pending Hermes approval')
    expect(edges.send).not.toHaveBeenCalled()
    expect(edges.host!.approvalPending()).toBe(true)
    expect(edges.host!.answerApproval('yes')).toBe('approve')
    expect(edges.resolveRequest).toHaveBeenCalledExactlyOnceWith('pre-dispatch-approval', { choice: 'once' })
  })

  it('does not release the observer or fall back to Hermes when chat.stop fails', async () => {
    defineCommands([{ id: 'chat.stop', title: 'Stop', description: 'Fixture', tier: 'act', args: [], phrases: ['cancel that'], run: () => ({ ok: false, summary: 'Could not stop', error: 'Could not stop' }) }])
    await voice.startVoice()
    expect(await edges.host!.submit('operational work', {})).toBe('voice-session')
    $chats.set({ ...$chats.get(), 'voice-session': { ...$chats.get()['voice-session'], streaming: true } })
    const sends = edges.send.mock.calls.length

    await expect(edges.host!.runIntent('cancel that')).resolves.toMatchObject({ handled: true, ok: false, spoken: 'Could not stop' })
    expect(edges.prepareLocalInterrupt).not.toHaveBeenCalled()
    expect(edges.send).toHaveBeenCalledTimes(sends)
  })

  it('does not fall back to Hermes when the reserved sleep lifecycle command throws', async () => {
    defineCommands([{ id: 'voice.sleep', title: 'Sleep', description: 'Fixture', tier: 'act', args: [], phrases: ['dragon sleep'], run: async () => { throw new Error('Window could not hide') } }])
    await voice.startVoice()
    const sends = edges.send.mock.calls.length

    await expect(edges.host!.runIntent('dragon sleep')).resolves.toEqual({ handled: true, ok: false, spoken: 'Window could not hide' })
    expect(edges.send).toHaveBeenCalledTimes(sends)
  })

  it('runs the real sleep command through the active host, stops it and awaits wake rearm', async () => {
    defineCommands(systemCommands.filter(command => command.id === 'voice.sleep'))
    await voice.startVoice()
    const host = edges.host!
    const sends = edges.send.mock.calls.length

    await expect(host.runIntent('dragon sleep')).resolves.toEqual({ handled: true, ok: true, spoken: 'Herald OS is sleeping' })

    expect(edges.hide).toHaveBeenCalledOnce()
    expect(edges.stop).toHaveBeenCalledOnce()
    expect(edges.resume).toHaveBeenCalledOnce()
    expect($wake.get()).toMatchObject({ listening: true, paused: false, error: null })
    expect(voice.$voice.get()).toMatchObject({ state: 'armed', engine: null })
    expect(edges.show).not.toHaveBeenCalled()
    expect(edges.send).toHaveBeenCalledTimes(sends)
  })

  it('cleans the old engine observer and interrupts only the previous streaming route after a new route succeeds', async () => {
    defineCommands([{ id: 'chat.open', title: 'Open chat', description: 'Fixture', tier: 'read', args: [], phrases: ['open chosen chat'], run: () => {
      const chosen = emptyChat('chosen', 'stored-chosen')
      $chats.set({ ...$chats.get(), chosen })
      return { ok: true, summary: 'Opened', data: { sessionId: chosen.sessionId } }
    } }])
    await voice.startVoice()
    expect(await edges.host!.submit('operational work', {})).toBe('voice-session')
    $chats.set({ ...$chats.get(), 'voice-session': { ...$chats.get()['voice-session'], streaming: true } })

    expect(await edges.host!.runIntent('open chosen chat')).toMatchObject({ handled: true, ok: true })
    expect(edges.prepareLocalInterrupt).toHaveBeenCalledOnce()
    expect(edges.interrupt).toHaveBeenCalledExactlyOnceWith('voice-session')
  })

  it('does not stop operational work when no visible voice chat was selected', async () => {
    await voice.startVoice()
    await edges.host!.submit('operational work', {})
    expect(await voice.endVoiceChat()).toBe('none')
    expect(edges.interrupt).not.toHaveBeenCalled()
    expect(voice.$voiceSessionId.get()).toBe('voice-session')
  })

  it('does not infer approval authority from a dispatch-only session', async () => {
    const run = vi.fn(() => ({ ok: true, summary: 'New chat', data: { sessionId: 'new-chat' } }))
    defineCommands([{ id: 'chat.new', title: 'New chat', description: 'Fixture', tier: 'act', args: [], phrases: ['new chat'], run }])
    await voice.startVoice()
    const current = emptyChat('current-voice', 'stored-current-voice')
    $chats.set({ ...$chats.get(), [current.sessionId]: current })
    voice.$voiceSessionId.set(current.sessionId)
    voice.$voiceApprovalSessionId.set(null)
    $pendingRequests.set([{ kind: 'approval', receivedAt: 0, request: { id: 'dispatch-only-approval', method: 'approval', params: { session_id: current.sessionId } } } as unknown as PendingRequest])

    expect(voice.$voiceAnswerableApprovalId.get()).toBeNull()
    expect(edges.host!.approvalPending()).toBe(false)
    expect(edges.host!.answerApproval('yes')).toBeNull()
    expect(edges.resolveRequest).not.toHaveBeenCalled()
    await expect(edges.host!.runIntent('new chat')).resolves.toMatchObject({ handled: true, ok: false, spoken: expect.stringContaining('approval') })
    expect(run).not.toHaveBeenCalled()
  })

  it('denies old engine intents, approvals, interrupts and observers while permitting the current engine', async () => {
    const run = vi.fn(async () => ({ ok: true, summary: 'Synthetic test only' }))
    defineCommands([{ id: 'test.safe', title: 'Safe fixture', description: 'In-memory test', tier: 'read', args: [], phrases: ['perform synthetic fixture'], run }])
    await voice.startVoice()
    const oldHost = edges.host!
    await voice.endConversation()
    await voice.startVoice()
    $chats.set({ ...$chats.get(), 'current-voice': emptyChat('current-voice', 'stored-current-voice') })
    voice.$voiceSessionId.set('current-voice')
    voice.$voiceApprovalSessionId.set('current-voice')
    $pendingRequests.set([{ kind: 'approval', receivedAt: 0, request: { id: 'test-approval', method: 'approval', params: { session_id: 'current-voice' } } } as unknown as PendingRequest])
    vi.mocked(notify).mockClear()
    expect(oldHost.approvalPending()).toBe(false)
    expect(oldHost.answerApproval('yes')).toBeNull()
    expect(await oldHost.runIntent('perform synthetic fixture')).toEqual({ handled: false, spoken: '', ok: false })
    oldHost.observeTurn('current-voice', { onDelta: vi.fn(), onComplete: vi.fn() })()
    await oldHost.interrupt()
    oldHost.notify('stale', 'ignored')
    expect(run).not.toHaveBeenCalled()
    expect(edges.resolveRequest).not.toHaveBeenCalled()
    expect(edges.interrupt).not.toHaveBeenCalled()
    expect(edges.gatewayEvents.size).toBe(0)
    expect(notify).not.toHaveBeenCalled()
    expect(edges.host!.approvalPending()).toBe(true)
    expect(edges.host!.answerApproval('yes')).toBe('approve')
    expect(edges.resolveRequest).toHaveBeenCalledExactlyOnceWith('test-approval', { choice: 'once' })
    expect((await edges.host!.runIntent('perform synthetic fixture')).handled).toBe(true)
    expect(run).toHaveBeenCalledOnce()
    oldHost.recordLiveSeconds(7)
    expect(voice.$voice.get().live.todaySeconds).toBe(7)
  })

  it('contains a wake failure after startup itself fails and preserves the startup error', async () => {
    edges.start.mockRejectedValueOnce(new Error('Synthetic start failure'))
    edges.resume.mockRejectedValueOnce(new Error('Synthetic wake failure'))
    await expect(voice.startVoice()).resolves.toBeUndefined()
    expect(voice.$voice.get()).toMatchObject({ state: 'armed', engine: null, error: 'Synthetic start failure' })
    expect(edges.resume).toHaveBeenCalledOnce()
    await voice.startVoice()
    expect(edges.start).toHaveBeenCalledTimes(2)
  })

  it('does not resume wake twice when ending before the wake pause was requested', async () => {
    const wait = deferred()
    edges.liveStatus.mockImplementationOnce(async () => { await wait.promise; return { mode: 'gpt-live', available: true, reason: null, model: 'test', voice: 'test' } })
    $prefs.set({ ...$prefs.get(), voice: { ...$prefs.get().voice, engine: 'live' } })
    const starting = voice.startVoice()
    await vi.waitFor(() => expect(edges.liveStatus).toHaveBeenCalledOnce())
    await voice.endConversation()
    wait.resolve()
    await starting
    expect(edges.pause).not.toHaveBeenCalled()
    expect(edges.resume).toHaveBeenCalledOnce()
  })

  it('preserves the original conversation error when wake rearm also fails', async () => {
    await voice.startVoice()
    edges.resume.mockRejectedValueOnce(new Error('synthetic wake failure'))
    await voice.endConversation('connection-lost', 'Synthetic connection lost')
    expect(voice.$voice.get().error).toBe('Synthetic connection lost')
  })

  it('follows a current acknowledged turn and releases both gateway listeners on completion', async () => {
    await voice.startVoice()
    expect(await edges.host!.submit('current request', {})).toBe('voice-session')
    expect(edges.send).toHaveBeenCalledExactlyOnceWith('current request', expect.objectContaining({
      sessionId: 'voice-session', surface: 'voice-live', canSubmit: expect.any(Function), onDispatch: expect.any(Function)
    }))
    expect(voice.$voiceSessionId.get()).toBe('voice-session')
    const onComplete = vi.fn()
    edges.host!.observeTurn('voice-session', { onDelta: vi.fn(), onComplete })
    edges.gatewayEvents.get('message.complete')!({ session_id: 'voice-session', payload: { status: 'complete' } })
    await Promise.resolve()
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('', 'complete', undefined, [])
    expect(edges.releaseListener.mock.calls).toEqual([['message.complete'], ['error']])
    expect(edges.gatewayEvents.size).toBe(0)
  })

  it('rejects a fresh submit from an ended engine, including after another conversation starts', async () => {
    await voice.startVoice()
    const oldHost = edges.host!
    await voice.endConversation()
    expect(await oldHost.submit('after end', {})).toBeNull()
    await voice.startVoice()
    const current = voice.$voice.get()
    oldHost.setState('speaking')
    oldHost.setCaptions({ assistant: 'stale' })
    oldHost.setLiveSeconds(123)
    oldHost.ended('idle')
    expect(await oldHost.submit('after restart', {})).toBeNull()
    expect(voice.$voice.get()).toEqual(current)
    expect(edges.send).not.toHaveBeenCalled()
    expect(edges.stop).toHaveBeenCalledOnce()
  })

  it('contains a wake rearm failure when an active conversation ends', async () => {
    await voice.startVoice()
    edges.resume.mockRejectedValueOnce(new Error('synthetic wake failure'))
    await expect(voice.endConversation()).resolves.toBeUndefined()
    expect(voice.$voice.get().error).toBe('Wake listening could not resume. Check Voice settings.')
  })

  it('reports a failed wake rearm after a canceled start and releases the startup guard', async () => {
    const wait = deferred()
    edges.pause.mockImplementationOnce(() => wait.promise)
    const starting = voice.startVoice('wake')
    await vi.waitFor(() => expect(edges.pause).toHaveBeenCalledOnce())
    await voice.endConversation()
    edges.resume.mockRejectedValueOnce(new Error('synthetic wake failure'))
    wait.resolve()
    await expect(starting).resolves.toBeUndefined()
    expect(voice.$voice.get().error).toBe('Wake listening could not resume. Check Voice settings.')
    await voice.startVoice()
    expect(edges.start).toHaveBeenCalledOnce()
  })

  it('cancels a voice request before submission without interrupting an unrelated chat', async () => {
    await voice.startVoice()
    const wait = deferred()
    edges.context.mockImplementationOnce(async () => { await wait.promise; return '' })
    const pending = edges.host!.submit('pending', {})
    await vi.waitFor(() => expect(edges.context).toHaveBeenCalledOnce())
    await edges.host!.interrupt()
    wait.resolve()
    expect(await pending).toBeNull()
    expect(edges.send).not.toHaveBeenCalled()
    expect(edges.interrupt).not.toHaveBeenCalled()
  })

  it('binds an outgoing voice turn before its ACK so barge-in has an exact target', async () => {
    await voice.startVoice()
    const wait = deferred()
    edges.send.mockImplementationOnce(async (_text, options) => { edges.dispatch(options); await wait.promise; return 'voice-session' })
    const pending = edges.host!.submit('a voice request', {})
    await vi.waitFor(() => expect(edges.send).toHaveBeenCalledOnce())
    $activeChatId.set('another-background-chat')
    await edges.host!.interrupt()
    expect(edges.interrupt).toHaveBeenCalledExactlyOnceWith('voice-session')
    wait.resolve()
    await pending
  })

  it.each(['interrupt', 'end', 'newer turn', 'reconnect'] as const)('revokes dispatch permission inside sendPrompt after %s', async action => {
    await voice.startVoice()
    const wait = deferred()
    let maySubmit: (() => boolean) | undefined
    edges.send.mockImplementationOnce(async (_text, options) => {
      maySubmit = (options as { canSubmit?: () => boolean }).canSubmit
      await wait.promise
      if (!maySubmit?.()) return null
      edges.dispatch(options)
      return 'voice-session'
    })
    const pending = edges.host!.submit('pending dispatch', {})
    await vi.waitFor(() => expect(edges.send).toHaveBeenCalledOnce())
    expect(maySubmit?.()).toBe(true)
    if (action === 'interrupt') await edges.host!.interrupt()
    else if (action === 'end') {
      await voice.endConversation()
      await voice.startVoice()
    } else if (action === 'newer turn') await edges.host!.submit('newer request', {})
    else $connectionEpoch.set($connectionEpoch.get() + 1)
    expect(maySubmit?.()).toBe(false)
    wait.resolve()
    expect(await pending).toBeNull()
  })

  it('does not dispatch an old request when the connection changes during context preparation', async () => {
    await voice.startVoice()
    const wait = deferred()
    edges.context.mockImplementationOnce(async () => { await wait.promise; return '' })
    const pending = edges.host!.submit('old connection', {})
    await vi.waitFor(() => expect(edges.context).toHaveBeenCalledOnce())
    $connectionEpoch.set($connectionEpoch.get() + 1)
    wait.resolve()
    expect(await pending).toBeNull()
    expect(edges.send).not.toHaveBeenCalled()
    expect(voice.$voiceSessionId.get()).toBeNull()
  })

  it('coalesces concurrent conversation ends into one engine stop', async () => {
    await voice.startVoice()
    const wait = deferred()
    edges.stop.mockImplementationOnce(() => wait.promise)
    const first = voice.endConversation()
    const second = voice.endConversation()
    expect(first).toBe(second)
    wait.resolve()
    await first
    expect(edges.stop).toHaveBeenCalledOnce()
  })

  it('waits for teardown before allowing another conversation to start', async () => {
    await voice.startVoice()
    const wait = deferred()
    edges.stop.mockImplementationOnce(() => wait.promise)
    const ending = voice.endConversation()
    await vi.waitFor(() => expect(edges.stop).toHaveBeenCalledOnce())
    await voice.startVoice()
    expect(edges.start).toHaveBeenCalledOnce()
    wait.resolve()
    await ending
    await voice.startVoice()
    expect(edges.start).toHaveBeenCalledTimes(2)
  })

  it('does not interrupt the active chat when no voice session is bound', async () => {
    await voice.startVoice()
    await edges.host!.interrupt()
    expect(edges.interrupt).not.toHaveBeenCalled()
  })

  it('interrupts only the voice session even after navigating to another chat', async () => {
    await voice.startVoice()
    voice.$voiceSessionId.set('voice-session')
    await edges.host!.interrupt()
    expect(edges.interrupt).toHaveBeenCalledExactlyOnceWith('voice-session')
  })

  it('does not start an engine after sleep while wake pause is still pending', async () => {
    const wait = deferred()
    edges.pause.mockImplementationOnce(() => wait.promise)
    const starting = voice.startVoice('wake')
    await vi.waitFor(() => expect(edges.pause).toHaveBeenCalledOnce())
    await voice.endConversation()
    wait.resolve()
    await starting
    expect(edges.start).not.toHaveBeenCalled()
    expect(voice.$voice.get()).toMatchObject({ state: 'armed', engine: null })
  })

  it('does not send a pending voice request after conversation end', async () => {
    await voice.startVoice()
    const wait = deferred()
    edges.context.mockImplementationOnce(async () => { await wait.promise; return '' })
    const pending = edges.host!.submit('a pending request', {})
    await vi.waitFor(() => expect(edges.context).toHaveBeenCalledOnce())
    await voice.endConversation()
    wait.resolve()
    expect(await pending).toBeNull()
    expect(edges.send).not.toHaveBeenCalled()
  })

  it.each(['voice-session', 'unrelated'])('does not rebind a late acknowledged turn after conversation end: %s', async session => {
    await voice.startVoice()
    const wait = deferred()
    edges.send.mockImplementationOnce(async (_text, options) => { edges.dispatch(options); await wait.promise; return session })
    const pending = edges.host!.submit('already sent', {})
    await vi.waitFor(() => expect(edges.send).toHaveBeenCalledOnce())
    await voice.endConversation()
    wait.resolve()
    expect(await pending).toBeNull()
    expect(voice.$voiceSessionId.get()).toBeNull()
    expect(edges.interrupt).not.toHaveBeenCalled()
    expect(edges.releaseListener.mock.calls).toEqual([['message.complete'], ['error']])
  })
})
