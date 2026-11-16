vi.mock('./i18n.ts', () => ({ t: (key: string) => key }))
import type { ModelOptionsResult } from '@herald-os/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store under test is the real one. Only what it talks to is replaced: the REST route
// (`rest.post`/`rest.get`), the gateway request (`gatewayRequest`), and the two stores it reads, the
// open chat and the sign-in refresh, which would otherwise load the whole shell.
const mocks = await vi.hoisted(async () => {
  const { atom } = await import('nanostores')

  return {
    activeChat: atom<{ sessionId: string } | null>(null),
    post: vi.fn(),
    put: vi.fn(),
    get: vi.fn(),
    request: vi.fn(),
    refresh: vi.fn()
  }
})

vi.mock('../lib/rest.ts', () => ({ rest: { get: mocks.get, post: mocks.post, put: mocks.put, del: vi.fn() } }))
vi.mock('./gateway.ts', () => ({ gatewayRequest: mocks.request }))
vi.mock('./chat.ts', () => ({ $activeChat: mocks.activeChat }))
vi.mock('./hermes-auth.ts', () => ({ $hermesAuth: { get: () => ({ checked: true, providers: [] }) }, refreshHermesAuth: mocks.refresh }))

const { $providerChanges, ModelSetRejected, setHermesModel, switchToProvider, selectLocalModel, selectPreferredModel, confirmModelChange, saveProviderKey } = await import('./model-provider.ts')

const SET = '/api/model/set'
const CHOSEN = ['openai-codex', 'gpt-5.1-codex'] as const

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

it('rejects a disabled native local runtime before any model mutation', async () => {
  mocks.request.mockResolvedValue({ provider: 'openai-codex', model: 'cloud', providers: [{ slug: 'llamacpp', name: 'Local', authenticated: true, models: ['imported.gguf'] }] })
  mocks.get.mockResolvedValue({ local_runtime: { enabled: false } })
  await expect(switchToProvider('llamacpp')).rejects.toMatchObject({ reason: 'runtime-disabled' })
  expect(mocks.post).not.toHaveBeenCalled()
})

it('selects only an offered local model and does not use a cloud recommendation', async () => {
  mocks.request.mockResolvedValue({ provider: 'llamacpp', model: 'stale-model', providers: [{ slug: 'llamacpp', name: 'Local', authenticated: true, is_current: true, models: ['imported.gguf'] }] })
  mocks.get.mockResolvedValue({ local_runtime: { enabled: true } })
  mocks.post.mockResolvedValue({ ok: true, provider: 'llamacpp', model: 'imported.gguf' })
  expect(await switchToProvider('llamacpp')).toMatchObject({ ok: true, model: 'imported.gguf' })
  expect(mocks.post).toHaveBeenCalledWith(SET, expect.objectContaining({ provider: 'llamacpp', model: 'imported.gguf' }))
  expect(mocks.get.mock.calls.some(([path]) => path === '/api/model/recommended-default')).toBe(false)
})

it('binds a provider switch to the initiating chat before catalog discovery', async () => {
  const pending = deferred<ModelOptionsResult>()
  mocks.activeChat.set({ sessionId: 'original' })
  mocks.request.mockImplementation((method: string) => method === 'model.options' ? pending.promise : Promise.resolve({ key: 'model', value: 'model-a' }))
  mocks.post.mockResolvedValue({ ok: true, provider: 'nous', model: 'model-a' })
  const switching = switchToProvider('nous')
  mocks.activeChat.set({ sessionId: 'other' })
  pending.resolve({ provider: 'nous', model: 'model-a', providers: [{ slug: 'nous', name: 'Nous', authenticated: true, is_current: true, models: ['model-a'] }] })
  expect(await switching).toMatchObject({ session: { status: 'switched', sessionId: 'original' } })
  expect(mocks.request).toHaveBeenCalledWith('config.set', expect.objectContaining({ session_id: 'original' }))
})

describe('preferred model selection', () => {
  const local = (): ModelOptionsResult => ({ provider: 'llamacpp', model: 'one.gguf', providers: [{ slug: 'llamacpp', name: 'Local', authenticated: true, models: ['one.gguf', 'two.gguf'] }] })

  it.each(['disabled', 'unknown', 'removed', 'signed-out', 'ambiguous'])('blocks local %s before any write', async reason => {
    const options = local()
    if (reason === 'removed') options.providers[0].models = ['one.gguf']
    if (reason === 'signed-out') options.providers[0].authenticated = false
    if (reason === 'ambiguous') options.providers.push({ ...options.providers[0] })
    mocks.request.mockResolvedValue(options)
    mocks.get.mockResolvedValue(reason === 'unknown' ? null : { local_runtime: { enabled: reason !== 'disabled' } })
    await expect(selectPreferredModel('llamacpp', 'two.gguf')).rejects.toMatchObject({ reason: reason === 'disabled' ? 'runtime-disabled' : reason === 'ambiguous' ? 'provider-unavailable' : 'not-offered' })
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('binds local discovery and held confirmation to the initiating session', async () => {
    const discovery = deferred<ModelOptionsResult>()
    mocks.activeChat.set({ sessionId: 'original' })
    mocks.get.mockResolvedValue({ local_runtime: { enabled: true } })
    mocks.request.mockImplementation(async method => method === 'model.options' ? local() : { key: 'model', value: 'two.gguf' })
    mocks.request.mockImplementationOnce(() => discovery.promise)
    mocks.post.mockResolvedValueOnce({ confirm_required: true }).mockResolvedValue({ ok: true, provider: 'llamacpp', model: 'two.gguf' })
    const pending = selectPreferredModel('llamacpp', 'two.gguf')
    mocks.activeChat.set({ sessionId: 'other' })
    discovery.resolve(local())
    const held = await pending
    expect(held).toMatchObject({ ok: false, sessionId: 'original', local: 'hermes' })
    if (held.ok) throw new Error('Expected confirmation')
    expect(await selectPreferredModel(held.provider, held.model, held)).toMatchObject({ session: { status: 'switched', sessionId: 'original' } })
    expect(mocks.post).toHaveBeenLastCalledWith(SET, expect.objectContaining({ provider: 'llamacpp', model: 'two.gguf', confirm_expensive_model: true }))
    expect(mocks.request).toHaveBeenCalledWith('config.set', expect.objectContaining({ session_id: 'original' }))
  })

  it('revalidates a held local confirmation after the runtime is disabled', async () => {
    mocks.get.mockResolvedValue({ local_runtime: { enabled: true } })
    mocks.request.mockResolvedValue(local())
    mocks.post.mockResolvedValue({ confirm_required: true })
    const held = await selectPreferredModel('llamacpp', 'two.gguf')
    if (held.ok) throw new Error('Expected confirmation')
    mocks.get.mockResolvedValue({ local_runtime: { enabled: false } })
    await expect(selectPreferredModel(held.provider, held.model, held)).rejects.toMatchObject({ reason: 'runtime-disabled' })
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })

  it('preserves a null target session across a subscription price confirmation', async () => {
    mocks.request.mockResolvedValue({ provider: CHOSEN[0], model: 'old', providers: [{ slug: CHOSEN[0], name: 'Subscription', authenticated: true, models: [CHOSEN[1]] }] })
    mocks.post.mockResolvedValueOnce({ confirm_required: true }).mockResolvedValue({ ok: true, provider: CHOSEN[0], model: CHOSEN[1] })
    const held = await selectPreferredModel(...CHOSEN)
    if (held.ok) throw new Error('Expected confirmation')
    mocks.activeChat.set({ sessionId: 'unrelated' })
    expect(await selectPreferredModel(...CHOSEN, held)).toMatchObject({ ok: true, session: { status: 'none' } })
    expect(mocks.request.mock.calls.some(([method]) => method === 'config.set')).toBe(false)
  })

  it.each(['model', 'provider'] as const)('refuses a mismatched confirmation %s without reads or writes', async field => {
    await expect(selectPreferredModel(...CHOSEN, { ok: false, provider: CHOSEN[0], model: CHOSEN[1], confirm: 'price', sessionId: null, [field]: 'other' })).rejects.toMatchObject({ reason: 'provider-unavailable' })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it.each(['config-unavailable', 'key-missing'])('does not treat a custom local endpoint as authorized when %s', async reason => {
    mocks.request.mockResolvedValue({ provider: 'lab', model: 'old', providers: [{ slug: 'lab', name: 'Lab', is_user_defined: true, authenticated: true, models: ['m'] }] })
    mocks.get.mockImplementation(async path => path === '/api/config' && reason !== 'config-unavailable' ? { providers: { lab: { base_url: 'http://127.0.0.1:11434/v1', key_env: 'LAB_KEY' } } } : null)
    await expect(selectPreferredModel('lab', 'm')).rejects.toMatchObject({ reason: reason === 'config-unavailable' ? 'provider-unavailable' : 'not-offered' })
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('accepts an offered keyless local alias without changing the exact model ID', async () => {
    const model = 'org/Größe:Q4_K_M'
    mocks.request.mockResolvedValue({ provider: 'custom:lab', model: 'old', providers: [{ slug: 'lab', aliases: ['custom:lab'], name: 'Lab', is_user_defined: true, authenticated: true, models: [model] }] })
    mocks.get.mockImplementation(async path => path === '/api/config' ? { providers: { lab: { base_url: 'http://127.0.0.1:11434/v1' } } } : {})
    mocks.post.mockResolvedValue({ ok: true, provider: 'custom:lab', model })
    expect(await selectPreferredModel('custom:lab', model)).toMatchObject({ ok: true, provider: 'custom:lab', model, local: 'ollama' })
    expect(mocks.post).toHaveBeenCalledWith(SET, expect.objectContaining({ provider: 'lab', model }))
  })

  it.each(['model', 'provider'] as const)('rejects a subscription ACK with an unexpected %s without switching any chat', async field => {
    mocks.activeChat.set({ sessionId: 'original' })
    mocks.request.mockResolvedValue({ provider: CHOSEN[0], model: 'old', providers: [{ slug: CHOSEN[0], name: 'Subscription', authenticated: true, models: [CHOSEN[1]] }] })
    mocks.post.mockResolvedValue({ ok: true, provider: CHOSEN[0], model: CHOSEN[1], [field]: 'other' })
    await expect(selectPreferredModel(...CHOSEN)).rejects.toBeInstanceOf(ModelSetRejected)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.request.mock.calls.some(([method]) => method === 'config.set')).toBe(false)
    expect($providerChanges.get()).toBe(1)
  })

  it.each(['model-removed', 'signed-out'])('rechecks a held subscription confirmation after %s', async reason => {
    const options: ModelOptionsResult = { provider: CHOSEN[0], model: 'old', providers: [{ slug: CHOSEN[0], name: 'Subscription', authenticated: true, models: [CHOSEN[1]] }] }
    mocks.request.mockResolvedValue(options)
    mocks.post.mockResolvedValue({ confirm_required: true })
    const held = await selectPreferredModel(...CHOSEN)
    if (held.ok) throw new Error('Expected confirmation')
    if (reason === 'model-removed') options.providers[0].models = []
    else options.providers[0].authenticated = false
    await expect(selectPreferredModel(...CHOSEN, held)).rejects.toMatchObject({ reason: 'provider-unavailable' })
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })

  it('keeps the non-null subscription confirmation target after switching chats', async () => {
    mocks.activeChat.set({ sessionId: 'original' })
    mocks.request.mockImplementation(async method => method === 'model.options' ? { provider: CHOSEN[0], model: 'old', providers: [{ slug: CHOSEN[0], name: 'Subscription', authenticated: true, models: [CHOSEN[1]] }] } : { key: 'model', value: CHOSEN[1] })
    mocks.post.mockResolvedValueOnce({ confirm_required: true }).mockResolvedValue({ ok: true, provider: CHOSEN[0], model: CHOSEN[1] })
    const held = await selectPreferredModel(...CHOSEN)
    if (held.ok) throw new Error('Expected confirmation')
    mocks.activeChat.set({ sessionId: 'other' })
    expect(await selectPreferredModel(...CHOSEN, held)).toMatchObject({ session: { status: 'switched', sessionId: 'original' } })
    expect(mocks.request).toHaveBeenCalledWith('config.set', expect.objectContaining({ session_id: 'original' }))
  })
})

beforeEach(() => {
  mocks.put.mockReset().mockResolvedValue(undefined)
  mocks.post.mockReset()
  mocks.get.mockReset().mockResolvedValue(null)
  mocks.request.mockReset()
  mocks.refresh.mockReset()
  mocks.refresh.mockResolvedValue(undefined)
  mocks.activeChat.set(null)
  $providerChanges.set(0)
})

describe('setHermesModel', () => {
  it.each([null, {}, { ok: true }, { ok: true, provider: '', model: CHOSEN[1] }])('requires an explicit default acknowledgement: %j', async ack => {
    mocks.post.mockResolvedValue(ack)
    mocks.activeChat.set({ sessionId: 's1' })
    await expect(setHermesModel(...CHOSEN)).rejects.toBeInstanceOf(ModelSetRejected)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it.each([
    [{ key: 'model', value: CHOSEN[1], deferred: true, confirm_required: false }, 'queued'],
    [{ key: 'model', value: CHOSEN[1], confirm_required: true }, 'failed'],
    [{}, 'failed'],
    [null, 'failed'],
    [{ key: 'other', value: CHOSEN[1] }, 'failed'],
    [{ key: 'model', value: 'different-model', confirm_required: false }, 'failed'],
    [{ key: 'model', value: 'different-model', deferred: true }, 'failed']
  ])('distinguishes the native session response %j from immediate success', async (ack, status) => {
    mocks.post.mockResolvedValue({ ok: true, provider: CHOSEN[0], model: CHOSEN[1] })
    mocks.activeChat.set({ sessionId: 's1' })
    mocks.request.mockResolvedValue(ack)
    expect(await setHermesModel(...CHOSEN)).toMatchObject({ ok: true, session: { status, sessionId: 's1' } })
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })
  it('saves the default in the native request shape and reports that no chat was open', async () => {
    mocks.post.mockResolvedValue({ ok: true, provider: 'openai-codex', model: 'gpt-5.1-codex' })

    const change = await setHermesModel(...CHOSEN)

    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.post).toHaveBeenCalledWith(SET, { scope: 'main', provider: 'openai-codex', model: 'gpt-5.1-codex', confirm_expensive_model: false })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(change).toEqual({ ok: true, provider: 'openai-codex', model: 'gpt-5.1-codex', session: { status: 'none' } })
    expect($providerChanges.get()).toBe(1)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it('moves the open chat too, and reports that it moved', async () => {
    mocks.activeChat.set({ sessionId: 's1' })
    mocks.post.mockResolvedValue({ ok: true, provider: 'openai-codex', model: 'gpt-5.1-codex' })
    mocks.request.mockResolvedValue({ key: 'model', value: CHOSEN[1], confirm_required: false })

    const change = await setHermesModel(...CHOSEN)

    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.request).toHaveBeenCalledWith('config.set', { session_id: 's1', key: 'model', value: 'gpt-5.1-codex --provider openai-codex', confirm_expensive_model: true })
    expect(change).toEqual({ ok: true, provider: 'openai-codex', model: 'gpt-5.1-codex', session: { status: 'switched', sessionId: 's1' } })
  })

  it('reports an unconfirmed chat switch, keeps the saved default, and neither retries nor rolls back', async () => {
    mocks.activeChat.set({ sessionId: 's1' })
    mocks.post.mockResolvedValue({ ok: true, provider: 'openai-codex', model: 'gpt-5.1-codex' })
    mocks.request.mockRejectedValue(new Error('session s1 is gone: raw-backend-detail'))

    const change = await setHermesModel(...CHOSEN)

    expect(change).toEqual({ ok: true, provider: 'openai-codex', model: 'gpt-5.1-codex', session: { status: 'failed', sessionId: 's1' } })
    // The reason stays with the backend; the result carries only that the switch was not confirmed.
    expect(JSON.stringify(change)).not.toContain('raw-backend-detail')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    // The default was saved, so the lists and sign-in state still read again.
    expect($providerChanges.get()).toBe(1)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it('does not report a result before the chat switch has answered', async () => {
    mocks.activeChat.set({ sessionId: 's1' })
    mocks.post.mockResolvedValue({ ok: true, provider: CHOSEN[0], model: CHOSEN[1] })
    const gate = deferred<unknown>()
    mocks.request.mockReturnValue(gate.promise)
    let settled = false
    const pending = setHermesModel(...CHOSEN).then(change => {
      settled = true

      return change
    })

    await flush()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    expect($providerChanges.get()).toBe(0)

    gate.resolve({ key: 'model', value: CHOSEN[1], confirm_required: false })
    expect(await pending).toMatchObject({ ok: true, session: { status: 'switched', sessionId: 's1' } })
    expect($providerChanges.get()).toBe(1)
  })

  it('reports a failure that arrives late as a failure', async () => {
    mocks.activeChat.set({ sessionId: 's1' })
    mocks.post.mockResolvedValue({ ok: true, provider: CHOSEN[0], model: CHOSEN[1] })
    const gate = deferred<unknown>()
    mocks.request.mockReturnValue(gate.promise)
    const pending = setHermesModel(...CHOSEN)

    await flush()
    gate.reject(new Error('timed out'))

    expect(await pending).toMatchObject({ ok: true, session: { status: 'failed', sessionId: 's1' } })
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })

  it('moves the chat that was open when the model was chosen, not the one open when Hermes answered', async () => {
    mocks.activeChat.set({ sessionId: 's1' })
    const gate = deferred<{ ok: boolean; provider: string; model: string }>()
    mocks.post.mockReturnValue(gate.promise)
    mocks.request.mockResolvedValue({ key: 'model', value: CHOSEN[1], confirm_required: false })
    const pending = setHermesModel(...CHOSEN)

    mocks.activeChat.set({ sessionId: 's2' })
    gate.resolve({ ok: true, provider: CHOSEN[0], model: CHOSEN[1] })
    const change = await pending

    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.request).toHaveBeenCalledWith('config.set', expect.objectContaining({ session_id: 's1' }))
    // The result names the chat it concerns, so the caller can tell it is no longer the one open.
    expect(change).toMatchObject({ ok: true, session: { status: 'switched', sessionId: 's1' } })
  })

  it('leaves a chat opened while Hermes answered on the new default, and says no chat was moved', async () => {
    const gate = deferred<{ ok: boolean; provider: string; model: string }>()
    mocks.post.mockReturnValue(gate.promise)
    const pending = setHermesModel(...CHOSEN)

    mocks.activeChat.set({ sessionId: 's2' })
    gate.resolve({ ok: true, provider: CHOSEN[0], model: CHOSEN[1] })

    expect(await pending).toMatchObject({ ok: true, session: { status: 'none' } })
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('names what Hermes saved when it differs from what was asked', async () => {
    mocks.activeChat.set({ sessionId: 's1' })
    mocks.post.mockResolvedValue({ ok: true, provider: 'openai-codex', model: 'gpt-5.1-codex-max' })
    mocks.request.mockResolvedValue({ key: 'model', value: 'gpt-5.1-codex-max', confirm_required: false })

    const change = await setHermesModel(...CHOSEN)

    expect(change).toMatchObject({ ok: true, provider: 'openai-codex', model: 'gpt-5.1-codex-max', session: { status: 'switched', sessionId: 's1' } })
    expect(mocks.request).toHaveBeenCalledWith('config.set', expect.objectContaining({ value: 'gpt-5.1-codex-max --provider openai-codex' }))

    mocks.post.mockResolvedValue(null)
    await expect(setHermesModel(...CHOSEN)).rejects.toBeInstanceOf(ModelSetRejected)
  })

  it('holds a price warning for the person, changing nothing and touching no chat', async () => {
    mocks.activeChat.set({ sessionId: 's1' })
    mocks.post.mockResolvedValue({ confirm_required: true, confirm_message: '  This model costs 40x the usual.  ' })

    const change = await setHermesModel(...CHOSEN)

    expect(change).toEqual({ ok: false, provider: 'openai-codex', model: 'gpt-5.1-codex', confirm: 'This model costs 40x the usual.', sessionId: 's1' })
    expect(mocks.request).not.toHaveBeenCalled()
    expect($providerChanges.get()).toBe(0)
    expect(mocks.refresh).not.toHaveBeenCalled()

    mocks.post.mockResolvedValue({ confirm_required: true, confirm_message: '   ' })
    expect(await setHermesModel(...CHOSEN)).toMatchObject({ ok: false, confirm: 'gpt-5.1-codex costs far more than most models.' })
  })

  it('sends the confirmation only when the person gave it, then changes as usual', async () => {
    mocks.activeChat.set({ sessionId: 's1' })
    mocks.post.mockResolvedValue({ ok: true, provider: CHOSEN[0], model: CHOSEN[1] })
    mocks.request.mockResolvedValue({ key: 'model', value: CHOSEN[1], confirm_required: false })

    const change = await setHermesModel(...CHOSEN, true)

    expect(mocks.post).toHaveBeenCalledWith(SET, { scope: 'main', provider: 'openai-codex', model: 'gpt-5.1-codex', confirm_expensive_model: true })
    expect(change).toMatchObject({ ok: true, session: { status: 'switched', sessionId: 's1' } })
  })

  it('passes a backend rejection on, once, without touching the chat or reading the lists again', async () => {
    mocks.activeChat.set({ sessionId: 's1' })
    mocks.post.mockRejectedValue(new Error('HTTP 400: Unknown model'))

    await expect(setHermesModel(...CHOSEN)).rejects.toThrow('HTTP 400: Unknown model')

    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.request).not.toHaveBeenCalled()
    expect($providerChanges.get()).toBe(0)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('does not call it a success when Hermes answers that it did not take the model', async () => {
    mocks.activeChat.set({ sessionId: 's1' })
    mocks.post.mockResolvedValue({ ok: false })

    const failure = await setHermesModel(...CHOSEN).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ModelSetRejected)
    expect(failure).toMatchObject({ provider: 'openai-codex', model: 'gpt-5.1-codex' })
    expect(mocks.request).not.toHaveBeenCalled()
    expect($providerChanges.get()).toBe(0)
  })

  it('keeps a saved change a saved change when only the read-again fails', async () => {
    mocks.post.mockResolvedValue({ ok: true, provider: CHOSEN[0], model: CHOSEN[1] })
    mocks.refresh.mockRejectedValue(new Error('offline'))

    expect(await setHermesModel(...CHOSEN)).toMatchObject({ ok: true, session: { status: 'none' } })
  })
})

describe('switchToProvider', () => {
  const OPTIONS: ModelOptionsResult = {
    model: 'hermes-4-405b',
    provider: 'nous',
    providers: [
      { slug: 'nous', name: 'Nous Portal', is_current: true, authenticated: true, models: ['hermes-4-405b'] },
      { slug: 'openai-codex', name: 'ChatGPT or Codex Subscription', is_current: false, authenticated: true, models: ['gpt-5.1-codex', 'gpt-5.1-codex-mini'] },
      { slug: 'anthropic', name: 'Anthropic', is_current: false, authenticated: false, models: [] }
    ]
  }

  it('switches to the recommended model of that provider and reports what became of the open chat', async () => {
    mocks.activeChat.set({ sessionId: 's1' })
    mocks.request.mockImplementation(async (method: string) => {
      if (method === 'model.options') {
        return OPTIONS
      }

      throw new Error('chat busy')
    })
    mocks.get.mockResolvedValue({ model: 'gpt-5.1-codex' })
    mocks.post.mockResolvedValue({ ok: true, provider: 'openai-codex', model: 'gpt-5.1-codex' })

    const change = await switchToProvider('openai-codex')

    expect(mocks.get).toHaveBeenCalledWith('/api/model/recommended-default', { provider: 'openai-codex' })
    expect(mocks.post).toHaveBeenCalledWith(SET, { scope: 'main', provider: 'openai-codex', model: 'gpt-5.1-codex', confirm_expensive_model: false })
    expect(change).toEqual({ ok: true, provider: 'openai-codex', model: 'gpt-5.1-codex', session: { status: 'failed', sessionId: 's1' } })
  })

  it('refuses a provider that is not set up, without a request to change anything', async () => {
    mocks.request.mockResolvedValue(OPTIONS)

    await expect(switchToProvider('anthropic')).rejects.toMatchObject({ reason: 'provider-unavailable' })

    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('passes a price warning on for the person to confirm', async () => {
    mocks.request.mockResolvedValue(OPTIONS)
    mocks.get.mockResolvedValue({ model: 'gpt-5.1-codex' })
    mocks.post.mockResolvedValue({ confirm_required: true, confirm_message: 'Pricey' })

    expect(await switchToProvider('openai-codex')).toEqual({ ok: false, provider: 'openai-codex', model: 'gpt-5.1-codex', confirm: 'Pricey', sessionId: null })
  })
})

describe('review regressions: exact local pair', () => {
  const local = (models = ['one.gguf', 'two.gguf']) => ({ provider: 'openai-codex', model: 'cloud', providers: [{ slug: 'llamacpp', name: 'Local', authenticated: true, models }] })
  it('rejects unknown runtime evidence and ambiguous implicit selection without a write', async () => {
    mocks.request.mockResolvedValue(local())
    await expect(switchToProvider('llamacpp')).rejects.toMatchObject({ reason: 'not-offered' })
    mocks.get.mockResolvedValue({ local_runtime: { enabled: true } })
    await expect(switchToProvider('llamacpp')).rejects.toMatchObject({ reason: 'ambiguous-model' })
    expect(mocks.post).not.toHaveBeenCalled()
  })
  it('selects the explicit second local model and binds the initiating session', async () => {
    mocks.activeChat.set({ sessionId: 'original' })
    mocks.get.mockResolvedValue({ local_runtime: { enabled: true } })
    mocks.request.mockImplementation(async method => method === 'model.options' ? local() : { key: 'model', value: 'two.gguf' })
    mocks.post.mockResolvedValue({ ok: true, provider: 'llamacpp', model: 'two.gguf' })
    expect(await selectLocalModel('llamacpp', 'two.gguf')).toMatchObject({ ok: true, model: 'two.gguf', session: { status: 'switched', sessionId: 'original' } })
    expect(mocks.post).toHaveBeenCalledWith(SET, expect.objectContaining({ model: 'two.gguf' }))
  })
  it.each(['disabled', 'removed', 'signed-out', 'duplicate'])('rechecks a held local confirmation after %s', async reason => {
    mocks.get.mockResolvedValue({ local_runtime: { enabled: true } })
    mocks.request.mockResolvedValue(local())
    mocks.post.mockResolvedValue({ confirm_required: true })
    const held = await selectLocalModel('llamacpp', 'two.gguf')
    if (held.ok) throw new Error('Expected confirmation')
    const next = local()
    if (reason === 'disabled') mocks.get.mockResolvedValue({ local_runtime: { enabled: false } })
    if (reason === 'removed') next.providers[0].models = ['one.gguf']
    if (reason === 'signed-out') next.providers[0].authenticated = false
    if (reason === 'duplicate') next.providers.push({ ...next.providers[0] })
    mocks.request.mockResolvedValue(next)
    await expect(confirmModelChange(held)).rejects.toThrow()
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })
  it.each([{ provider: 'other', model: 'two.gguf' }, { provider: 'llamacpp', model: 'other.gguf' }])('does not move a chat after an unexpected native local acknowledgement %j', async saved => {
    mocks.activeChat.set({ sessionId: 'original' })
    mocks.get.mockResolvedValue({ local_runtime: { enabled: true } })
    mocks.request.mockResolvedValue(local())
    mocks.post.mockResolvedValue({ ok: true, ...saved })
    await expect(selectLocalModel('llamacpp', 'two.gguf')).rejects.toBeInstanceOf(ModelSetRejected)
    expect(mocks.request.mock.calls.some(([method]) => method === 'config.set')).toBe(false)
  })
  it('binds key setup to the original chat and reports a saved key on follow-up failure', async () => {
    const keyWrite = deferred<undefined>()
    mocks.put.mockReturnValue(keyWrite.promise)
    mocks.activeChat.set({ sessionId: 'original' })
    mocks.request.mockImplementation(async method => method === 'model.options' ? { provider: 'p', model: 'm', providers: [{ slug: 'p', name: 'P', authenticated: true, is_current: true, models: ['m'] }] } : { key: 'model', value: 'm' })
    mocks.post.mockResolvedValue({ ok: true, provider: 'p', model: 'm' })
    const choice = { slug: 'p', name: 'P', current: true, ready: false, setup: 'key' as const, keyEnv: 'P_KEY', helpUrl: null, command: null, models: ['m'] }
    const pending = saveProviderKey(choice, 'fixture-key')
    mocks.activeChat.set({ sessionId: 'other' })
    keyWrite.resolve(undefined)
    expect(await pending).toMatchObject({ session: { sessionId: 'original' } })
    mocks.post.mockRejectedValue(new Error('secret backend detail'))
    const before = $providerChanges.get()
    await expect(saveProviderKey(choice, 'fixture-key')).rejects.toMatchObject({ reason: 'key-saved' })
    expect($providerChanges.get()).toBe(before + 1)
  })
})

it('refuses overlapping writes and releases the client guard after completion', async () => {
  const gate = deferred<{ ok: boolean; provider: string; model: string }>()
  mocks.post.mockReturnValue(gate.promise)
  const first = setHermesModel(...CHOSEN)
  const second = setHermesModel(...CHOSEN).catch(error => error)
  gate.resolve({ ok: true, provider: CHOSEN[0], model: CHOSEN[1] })
  await first
  expect(await second).toMatchObject({ reason: 'in-progress' })
  expect(mocks.post).toHaveBeenCalledTimes(1)
  expect(await setHermesModel(...CHOSEN)).toMatchObject({ ok: true })
})

it('identifies a disabled runtime even when the native row is unauthenticated', async () => {
  mocks.get.mockResolvedValue({ local_runtime: { enabled: false } })
  mocks.request.mockResolvedValue({ providers: [{ slug: 'llamacpp', name: 'Local', authenticated: false, models: ['m'] }] })
  await expect(switchToProvider('llamacpp')).rejects.toMatchObject({ reason: 'runtime-disabled' })
  expect(mocks.post).not.toHaveBeenCalled()
})

describe('low review regressions', () => {
  const row = (aliases: string[]) => ({ slug: 'lab', name: 'Lab', is_user_defined: true, authenticated: true, models: ['m'], aliases })
  it('rejects a removed alias even after a previous catalog populated the display cache', async () => {
    const { loadModelOptions, providerSlug, providerName } = await import('./model-provider.ts')
    mocks.request.mockResolvedValue({ providers: [row(['old-lab'])] })
    await loadModelOptions()
    mocks.request.mockResolvedValue({ providers: [row([])] })
    mocks.get.mockResolvedValue({ providers: { lab: { base_url: 'http://localhost:11434/v1' } } })
    mocks.post.mockResolvedValue({ ok: true, provider: 'old-lab', model: 'm' })
    await expect(selectLocalModel('lab', 'm')).rejects.toBeInstanceOf(ModelSetRejected)
    expect(providerSlug('old-lab')).toBe('old-lab')
    expect(providerName('old-lab')).toBeNull()
    expect(mocks.request.mock.calls.some(([method]) => method === 'config.set')).toBe(false)
  })
  it('validates the acknowledgement against the selected catalog snapshot during concurrent catalog refresh', async () => {
    const { loadModelOptions } = await import('./model-provider.ts')
    mocks.request.mockResolvedValue({ providers: [row(['custom:Lab'])] })
    mocks.get.mockResolvedValue({ providers: { lab: { base_url: 'http://localhost:11434/v1' } } })
    const gate = deferred<unknown>()
    mocks.post.mockReturnValue(gate.promise)
    const pending = selectLocalModel('lab', 'm')
    await flush()
    mocks.request.mockResolvedValue({ providers: [{ ...row(['custom:Lab']), slug: 'other' }] })
    await loadModelOptions()
    gate.resolve({ ok: true, provider: 'custom:Lab', model: 'm' })
    expect(await pending).toMatchObject({ ok: true, local: 'ollama' })
  })
  it.each(['missing', 'failed'])('does not write to a key-requiring endpoint with %s key metadata', async state => {
    mocks.request.mockResolvedValue({ providers: [row([])] })
    mocks.get.mockImplementation(async path => {
      if (path === '/api/config') return { providers: { lab: { base_url: 'http://localhost:11434/v1', key_env: 'LAB_KEY' } } }
      if (state === 'failed') throw new Error('private detail')
      return {}
    })
    await expect(selectLocalModel('lab', 'm')).rejects.toMatchObject({ reason: 'not-offered' })
    expect(mocks.post).not.toHaveBeenCalled()
  })
  it('permits implicit selection of one deduplicated keyed model only with saved key evidence', async () => {
    mocks.request.mockResolvedValue({ providers: [{ ...row([]), models: ['m', 'm'] }] })
    mocks.get.mockImplementation(async path => path === '/api/config' ? { providers: { lab: { base_url: 'http://localhost:11434/v1', key_env: 'LAB_KEY' } } } : { LAB_KEY: { is_set: true } })
    mocks.post.mockResolvedValue({ ok: true, provider: 'lab', model: 'm' })
    expect(await switchToProvider('lab')).toMatchObject({ ok: true, local: 'ollama' })
  })
  it('releases the write guard after a rejected acknowledgement', async () => {
    mocks.post.mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true, provider: CHOSEN[0], model: CHOSEN[1] })
    await expect(setHermesModel(...CHOSEN)).rejects.toBeInstanceOf(ModelSetRejected)
    expect(await setHermesModel(...CHOSEN)).toMatchObject({ ok: true })
    expect(mocks.post).toHaveBeenCalledTimes(2)
  })
  it('keeps the guard until the bounded auth refresh settles to avoid overlapping write-triggered refreshes', async () => {
    const gate = deferred<unknown>()
    mocks.refresh.mockReturnValue(gate.promise)
    mocks.post.mockResolvedValue({ ok: true, provider: CHOSEN[0], model: CHOSEN[1] })
    let settled = false
    const pending = setHermesModel(...CHOSEN).then(change => { settled = true; return change })
    await flush()
    const completedBeforeRefresh = settled
    await expect(setHermesModel(...CHOSEN)).rejects.toMatchObject({ reason: 'in-progress' })
    expect(mocks.post).toHaveBeenCalledTimes(1)
    gate.resolve(undefined)
    await pending
    expect(completedBeforeRefresh).toBe(false)
    expect(await setHermesModel(...CHOSEN)).toMatchObject({ ok: true })
  })
})

it.each(['missing-provider', 'unauthenticated', 'empty-catalog'])('identifies a pre-write refusal: %s', async state => {
  const row = { slug: 'cloud', name: 'Cloud', authenticated: state !== 'unauthenticated', models: state === 'empty-catalog' ? [] : ['m'] }
  mocks.request.mockResolvedValue({ providers: state === 'missing-provider' ? [] : [row] })
  mocks.get.mockResolvedValue({})
  await expect(switchToProvider('cloud')).rejects.toMatchObject({ reason: state === 'empty-catalog' ? 'no-models' : 'provider-unavailable' })
  expect(mocks.post).not.toHaveBeenCalled()
})
it('identifies a missing key before any env write', async () => {
  const choice = { slug: 'p', name: 'P', current: false, ready: false, setup: 'key' as const, keyEnv: 'P_KEY', helpUrl: null, command: null, models: [] }
  await expect(saveProviderKey(choice, '  ')).rejects.toMatchObject({ reason: 'key-required' })
  expect(mocks.put).not.toHaveBeenCalled()
})
