import { beforeEach, describe, expect, it, vi } from 'vitest'
import { atom } from 'nanostores'
import { emptyChat } from '../lib/chat-model.ts'

// Hermes's socket, faked: each request is recorded and answered by `reply`.
const hermes = vi.hoisted(() => ({ requests: [] as string[], params: [] as unknown[], reply: (_method: string): unknown => ({}) }))
const files = vi.hoisted(() => ({ attach: vi.fn(async () => '') }))

vi.mock('./attachments.ts', () => ({ attachFiles: files.attach, hermesReadsLocalFiles: () => true }))

vi.mock('./gateway.ts', () => ({
  $connectionEpoch: atom(0),
  gatewayRequest: async (method: string, params: unknown) => {
    hermes.requests.push(method)
    hermes.params.push(params)

    return hermes.reply(method)
  },
  isGatewayOpen: () => false,
  onGatewayEvent: () => () => undefined,
  onAnyGatewayEvent: () => () => undefined
}))

const { $activeChatId, $chats, createChat, isHiddenChat, openStoredSession, runSlash, sendPrompt } = await import('./chat.ts')
const { $connectionEpoch } = await import('./gateway.ts')

it('refuses to relabel an existing visible session as the hidden operational session', async () => {
  const visible = emptyChat('visible-cached', 'stored-visible-cached')
  $chats.set({ [visible.sessionId]: visible })
  $activeChatId.set(visible.sessionId)
  hermes.requests.length = 0
  await expect(openStoredSession(visible.storedSessionId, undefined, { hidden: true, activate: false, requireExactId: true })).rejects.toThrow()
  expect($chats.get()[visible.sessionId]).toBe(visible)
  expect(visible.hidden).toBeUndefined()
  expect($activeChatId.get()).toBe(visible.sessionId)
  expect(hermes.requests).toEqual([])
})

describe('runSlash', () => {
  beforeEach(() => {
    hermes.requests.length = 0
    $chats.set({ s1: emptyChat('s1', 'stored-1') })
  })

  it('answers a bare /model from model.options, which knows the model before the agent is built', async () => {
    hermes.reply = method =>
      method === 'model.options' ? { model: 'qwen3-30b-a3b', provider: 'custom:qwen-flash', providers: [{ slug: 'qwen-flash', name: 'qwen-flash', aliases: ['custom:qwen-flash', 'qwen-flash'] }] } : { output: 'Current model: (unknown)' }

    await runSlash('/model', 's1')

    expect(hermes.requests).toEqual(['model.options'])
    expect($chats.get().s1.messages).toMatchObject([
      { role: 'user', text: '/model' },
      { role: 'system', text: 'Current model: qwen3-30b-a3b (qwen-flash)' }
    ])
  })

  it("leaves a switch, and a session model.options names no model for, to Hermes's slash commands", async () => {
    hermes.reply = method => (method === 'model.options' ? { model: '', providers: [] } : { output: 'Current model: (unknown)' })

    await runSlash('/model', 's1')
    await runSlash('/model gpt-5 --provider openai-api', 's1')

    expect(hermes.requests).toEqual(['model.options', 'slash.exec', 'slash.exec'])
  })
})

describe('voice prompt dispatch boundary', () => {
  beforeEach(() => {
    hermes.requests.length = 0
    hermes.params.length = 0
    hermes.reply = () => ({ session_id: 'unexpected-new-chat' })
    files.attach.mockReset().mockResolvedValue('')
    $chats.set({ voice: emptyChat('voice', 'stored-voice'), visible: emptyChat('visible', 'stored-visible') })
    $activeChatId.set('visible')
  })

  it.each([undefined, 'missing'])('never creates or selects a visible chat for a missing voice target: %s', async sessionId => {
    expect(await sendPrompt('private voice request', { surface: 'voice-live', sessionId })).toBeNull()
    expect(hermes.requests).toEqual([])
    expect(files.attach).not.toHaveBeenCalled()
    expect($activeChatId.get()).toBe('visible')
    expect($chats.get().visible.messages).toEqual([])
  })

  it('does not prepare or send a request already canceled by its voice owner', async () => {
    expect(await sendPrompt('canceled', { sessionId: 'voice', surface: 'voice-live', canSubmit: () => false })).toBeNull()
    expect(files.attach).not.toHaveBeenCalled()
    expect(hermes.requests).toEqual([])
    expect($chats.get().voice.messages).toEqual([])
  })

  it.each(['cancel', 'forget', 'reconnect'] as const)('revalidates after asynchronous preparation: %s', async action => {
    let release!: (text: string) => void
    let allowed = true
    const onDispatch = vi.fn()
    files.attach.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve }))
    const pending = sendPrompt('pending voice turn', { sessionId: 'voice', surface: 'voice-live', canSubmit: () => allowed, onDispatch })
    expect(files.attach).toHaveBeenCalledOnce()
    if (action === 'cancel') allowed = false
    else if (action === 'forget') $chats.set({ visible: $chats.get().visible })
    else $connectionEpoch.set($connectionEpoch.get() + 1)
    release('')
    expect(await pending).toBeNull()
    expect(hermes.requests).toEqual([])
    expect(onDispatch).not.toHaveBeenCalled()
    expect($chats.get().voice?.messages ?? []).toEqual([])
    expect($chats.get().visible.messages).toEqual([])
    expect($activeChatId.get()).toBe('visible')
  })

  it('submits the exact still-authorized voice target, independently of the visible chat', async () => {
    const onDispatch = vi.fn(() => expect(hermes.requests).toEqual([]))
    expect(await sendPrompt('spoken turn', { sessionId: 'voice', surface: 'voice-live', voiceContext: 'context', interrupted: true, canSubmit: () => true, onDispatch })).toBe('voice')
    expect(onDispatch).toHaveBeenCalledOnce()
    expect(hermes.requests).toEqual(['prompt.submit'])
    expect(hermes.params).toEqual([{ session_id: 'voice', text: 'spoken turn', surface: 'voice-live', voice_context: 'context', interrupted: true }])
    expect($chats.get().voice.messages).toMatchObject([{ role: 'user', text: 'spoken turn' }])
    expect($chats.get().visible.messages).toEqual([])
  })

  it('preserves ordinary text-chat creation when no target exists', async () => {
    $activeChatId.set(null)
    expect(await sendPrompt('ordinary text')).toBe('unexpected-new-chat')
    expect(hermes.requests).toEqual(['session.create', 'prompt.submit'])
    expect($activeChatId.get()).toBe('unexpected-new-chat')
  })

  it('does not record or submit a voice prompt when attachment preparation rejects', async () => {
    files.attach.mockRejectedValueOnce(new Error('Synthetic attachment refused'))
    await expect(sendPrompt('with attachment', { sessionId: 'voice', surface: 'voice-live', attachments: ['synthetic.txt'] })).rejects.toThrow('Synthetic attachment refused')
    expect(hermes.requests).toEqual([])
    expect($chats.get().voice.messages).toEqual([])
    expect($chats.get().visible.messages).toEqual([])
  })

  it.each(['forget', 'reconnect'] as const)('keeps the ordinary text path unchanged during %s', async action => {
    let release!: (text: string) => void
    files.attach.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve }))
    const pending = sendPrompt('ordinary pending text', { sessionId: 'visible' })
    if (action === 'forget') $chats.set({ voice: $chats.get().voice })
    else $connectionEpoch.set($connectionEpoch.get() + 1)
    release('')
    expect(await pending).toBe('visible')
    expect(hermes.requests).toEqual(['prompt.submit'])
    expect(hermes.params).toEqual([{ session_id: 'visible', text: 'ordinary pending text', surface: 'herald_os' }])
  })
})

describe('native hidden session ownership', () => {
  beforeEach(() => {
    hermes.requests.length = 0
    hermes.params.length = 0
    $chats.set({ visible: emptyChat('visible', 'stored-visible') })
    $activeChatId.set('visible')
    hermes.reply = method => method === 'session.set_hidden'
      ? { hidden: true, session_key: 'native-hidden' }
      : { session_id: 'voice-runtime', stored_session_id: 'native-hidden', info: {}, messages: [] }
  })

  it('creates a native hidden session without changing the visible chat or source', async () => {
    const chat = await createChat({ hidden: true })
    expect(chat.storedSessionId).toBe('native-hidden')
    expect(hermes.requests).toEqual(['session.create', 'session.set_hidden'])
    expect(hermes.params[0]).toMatchObject({ source: 'herald_os', hidden: true })
    expect(hermes.params[1]).toEqual({ session_id: 'voice-runtime', hidden: true })
    expect($activeChatId.get()).toBe('visible')
  })

  it('marks a resumed runtime hidden while native confirmation is still pending', async () => {
    let confirm!: () => void
    const hiddenAck = new Promise(resolve => { confirm = () => resolve({ hidden: true, session_key: 'native-hidden' }) })
    hermes.reply = method => method === 'session.set_hidden'
      ? hiddenAck
      : { session_id: 'pending-runtime', stored_session_id: 'native-hidden', info: {}, messages: [] }

    const opening = openStoredSession('native-hidden', undefined, { activate: false, requireExactId: true, hidden: true })
    await vi.waitFor(() => expect(hermes.requests).toEqual(['session.resume', 'session.set_hidden']))
    expect(isHiddenChat('pending-runtime')).toBe(true)
    expect($chats.get()['pending-runtime']).toBeUndefined()

    confirm()
    await expect(opening).resolves.toMatchObject({ sessionId: 'pending-runtime', hidden: true })
    expect(isHiddenChat('pending-runtime')).toBe(true)
  })

  it('resumes the exact stored session without selecting it or changing its visibility', async () => {
    await openStoredSession('native-hidden', undefined, { activate: false, requireExactId: true })
    expect(hermes.requests).toEqual(['session.resume'])
    expect(hermes.params).toEqual([{ session_id: 'native-hidden', source: 'herald_os' }])
    expect($activeChatId.get()).toBe('visible')
    expect($chats.get()['voice-runtime'].storedSessionId).toBe('native-hidden')
  })

  it('keeps a hidden resumed session quiet even when no activate option was supplied', async () => {
    const state = await openStoredSession('native-hidden', undefined, { hidden: true })
    expect(state.hidden).toBe(true)
    expect($activeChatId.get()).toBe('visible')
    await openStoredSession('native-hidden', undefined, { hidden: true })
    expect(hermes.requests).toEqual(['session.resume', 'session.set_hidden'])
    expect(hermes.params[1]).toEqual({ session_id: 'voice-runtime', hidden: true })
    expect($activeChatId.get()).toBe('visible')
  })

  it('does not adopt a conflicting live-draft identity', async () => {
    hermes.reply = () => ({ session_id: 'wrong-runtime', stored_session_id: 'other-stored-session', info: {}, messages: [] })
    await expect(openStoredSession('native-hidden', undefined, { activate: false, requireExactId: true })).rejects.toThrow('session')
    expect($chats.get()['wrong-runtime']).toBeUndefined()
    expect($activeChatId.get()).toBe('visible')
    expect(hermes.requests).toEqual(['session.resume'])
  })

  it('adopts the canonical compression tip only after Hermes confirms hidden ownership', async () => {
    hermes.reply = method => method === 'session.set_hidden'
      ? { hidden: true, session_key: 'canonical-tip' }
      : { session_id: 'tip-runtime', session_key: 'canonical-tip', resumed: 'canonical-tip', info: {}, messages: [] }
    const state = await openStoredSession('native-hidden', undefined, { activate: false, requireExactId: true, hidden: true })
    expect(state).toMatchObject({ sessionId: 'tip-runtime', storedSessionId: 'canonical-tip', hidden: true })
    expect(hermes.requests).toEqual(['session.resume', 'session.set_hidden'])
    expect($activeChatId.get()).toBe('visible')
  })

  it('does not cache a resumed session when Hermes cannot confirm native hidden ownership', async () => {
    hermes.reply = method => method === 'session.set_hidden'
      ? { hidden: false, session_key: 'native-hidden' }
      : { session_id: 'unconfirmed-runtime', session_key: 'native-hidden', info: {}, messages: [] }
    await expect(openStoredSession('native-hidden', undefined, { hidden: true })).rejects.toThrow('session')
    expect($chats.get()['unconfirmed-runtime']).toBeUndefined()
    expect(isHiddenChat('unconfirmed-runtime')).toBe(true)
    expect(hermes.requests).toEqual(['session.resume', 'session.set_hidden'])
  })

  it('rejects hidden creation without a native stored identity', async () => {
    hermes.reply = () => ({ session_id: 'runtime-only', info: {}, messages: [] })
    await expect(createChat({ hidden: true })).rejects.toThrow('session')
    expect($chats.get()['runtime-only']).toBeUndefined()
    expect($activeChatId.get()).toBe('visible')
  })
})
