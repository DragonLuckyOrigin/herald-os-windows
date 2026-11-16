import { beforeEach, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { atom } = await import('nanostores')
  return { active: atom<{ sessionId: string } | null>(null), get: vi.fn(), post: vi.fn(), put: vi.fn(), request: vi.fn() }
})
vi.mock('../lib/rest.ts', () => ({ rest: { get: mocks.get, post: mocks.post, put: mocks.put } }))
vi.mock('./chat.ts', () => ({ $activeChat: mocks.active }))
vi.mock('./gateway.ts', () => ({ gatewayRequest: mocks.request }))
vi.mock('./hermes-auth.ts', () => ({ $hermesAuth: { get: () => ({ checked: true, providers: [] }) }, refreshHermesAuth: async () => undefined }))
vi.mock('./notifications.ts', () => ({ notify: vi.fn() }))
vi.mock('./i18n.ts', () => ({ t: (key: string) => key }))

const { useWithHermes } = await import('./catalog.ts')
const { confirmModelChange } = await import('./model-provider.ts')
const MODEL = 'exact-model:Q5'
// The Settings consumer explicitly handles all ModelChange outcomes. Older command callers
// still expect a rejected promise whenever the complete switch is not confirmed.
const choose = (kind: 'ollama' | 'lmstudio', model: string) => useWithHermes(kind, model, true)
const catalog = () => ({ provider: 'openai-codex', model: 'subscription-model', providers: [
  { slug: 'my-server', name: 'Personal', is_user_defined: true, authenticated: true, models: [MODEL] },
  { slug: 'remote', name: 'Ollama', is_user_defined: true, authenticated: true, models: [MODEL] }
] })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.active.set({ sessionId: 'original' })
  mocks.get.mockResolvedValue({ providers: { 'my-server': { base_url: 'http://127.0.0.1:11434/v1' }, remote: { base_url: 'https://remote.example/v1' } } })
  mocks.post.mockResolvedValue({ ok: true, provider: 'my-server', model: MODEL })
  mocks.request.mockImplementation(async (method: string) => method === 'model.options' ? catalog() : { key: 'model', value: MODEL })
})

it('uses the exact Hermes pair and confirmed session path, without direct config writes or slash execution', async () => {
  expect(await choose('ollama', MODEL)).toMatchObject({ ok: true, provider: 'my-server', model: MODEL, session: { status: 'switched', sessionId: 'original' } })
  expect(mocks.post).toHaveBeenCalledWith('/api/model/set', { scope: 'main', provider: 'my-server', model: MODEL, confirm_expensive_model: false })
  expect(mocks.put).not.toHaveBeenCalled()
  expect(mocks.request).not.toHaveBeenCalledWith('slash.exec', expect.anything())
})

it.each(['missing', 'ambiguous', 'unauthenticated', 'config-unavailable'])('refuses %s availability without a write or cloud fallback', async reason => {
  const options = catalog()
  if (reason === 'missing') options.providers[0].models = ['different']
  if (reason === 'unauthenticated') options.providers[0].authenticated = false
  if (reason === 'ambiguous') {
    options.providers.push({ ...options.providers[0], slug: 'other-local' })
    mocks.get.mockResolvedValue({ providers: { 'my-server': { base_url: 'http://localhost:11434/v1' }, 'other-local': { base_url: 'http://localhost:11434/v1' } } })
  }
  if (reason === 'config-unavailable') mocks.get.mockRejectedValue(new Error('offline'))
  mocks.request.mockResolvedValue(options)
  await expect(choose('ollama', MODEL)).rejects.toThrow()
  expect(mocks.post).not.toHaveBeenCalled()
  expect(mocks.put).not.toHaveBeenCalled()
})

it.each([[true, 'queued'], [false, 'failed']])('reports partial session outcome instead of unconditional success (%s)', async (queued, status) => {
  mocks.request.mockImplementation(async (method: string) => method === 'model.options' ? catalog() : queued ? { key: 'model', value: MODEL, deferred: true } : null)
  expect(await choose('ollama', MODEL)).toMatchObject({ ok: true, session: { status, sessionId: 'original' } })
})

it('retains the initiating chat through discovery and explicit price confirmation', async () => {
  let resolve!: (value: ReturnType<typeof catalog>) => void
  const pending = new Promise<ReturnType<typeof catalog>>(done => { resolve = done })
  mocks.request.mockImplementation((method: string) => method === 'model.options' ? pending : Promise.resolve({ key: 'model', value: MODEL }))
  mocks.post.mockResolvedValueOnce({ confirm_required: true, confirm_message: 'Confirm cost' })
  const switching = choose('ollama', MODEL)
  mocks.active.set({ sessionId: 'other' })
  resolve(catalog())
  const result = await switching
  expect(result).toMatchObject({ ok: false, provider: 'my-server', model: MODEL, sessionId: 'original' })
  expect(mocks.request.mock.calls.filter(([method]) => method === 'config.set')).toHaveLength(0)
  if (result.ok) throw new Error('Expected confirmation')
  expect(await confirmModelChange(result)).toMatchObject({ session: { status: 'switched', sessionId: 'original' } })
})

it.each(['confirm', 'failed', 'queued'])('prevents false success in an existing command consumer on %s', async state => {
  if (state === 'confirm') mocks.post.mockResolvedValue({ confirm_required: true })
  mocks.request.mockImplementation(async (method: string) => method === 'model.options' ? catalog() : state === 'queued' ? { key: 'model', value: MODEL, deferred: true } : null)
  await expect(useWithHermes('ollama', MODEL)).rejects.toThrow()
  expect(mocks.post).toHaveBeenCalledTimes(1)
})

it.each(['failed', 'queued'])('reports the saved default in legacy command failure on %s', async state => {
  mocks.request.mockImplementation(async method => method === 'model.options' ? catalog() : state === 'queued' ? { key: 'model', value: MODEL, deferred: true } : null)
  await expect(useWithHermes('ollama', MODEL)).rejects.toMatchObject({ reason: 'chat-' + state, message: 'settings.provider.partial.' + state })
})

it('refuses a remote override while a local confirmation is held', async () => {
  mocks.post.mockResolvedValue({ confirm_required: true })
  const held = await choose('ollama', MODEL)
  if (held.ok) throw new Error('Expected confirmation')
  mocks.get.mockResolvedValue({ providers: { 'my-server': { base_url: 'https://remote.example/v1' } } })
  await expect(confirmModelChange(held)).rejects.toThrow()
  expect(mocks.post).toHaveBeenCalledTimes(1)
})

it('requires a saved endpoint key when Hermes exposes that key requirement', async () => {
  mocks.get.mockImplementation(async path => path === '/api/env' ? { SERVER_KEY: { is_password: true, is_set: false } } : { providers: { 'my-server': { base_url: 'http://localhost:11434/v1', key_env: 'SERVER_KEY' } } })
  await expect(choose('ollama', MODEL)).rejects.toThrow()
  expect(mocks.post).not.toHaveBeenCalled()
})
it('accepts the native provider alias for the exact local acknowledgement', async () => {
  mocks.request.mockImplementation(async method => method === 'model.options' ? { ...catalog(), providers: [{ ...catalog().providers[0], aliases: ['custom:my-server'] }] } : { key: 'model', value: MODEL })
  mocks.post.mockResolvedValue({ ok: true, provider: 'custom:my-server', model: MODEL })
  expect(await choose('ollama', MODEL)).toMatchObject({ ok: true, provider: 'custom:my-server', model: MODEL, session: { status: 'switched' } })
})
