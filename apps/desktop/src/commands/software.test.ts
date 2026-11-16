import { beforeEach, expect, it, vi } from 'vitest'
import { translate } from '../../shared/i18n.ts'
const mocks = vi.hoisted(() => ({ use: vi.fn(), models: vi.fn() }))
vi.mock('../store/i18n.ts', () => ({ t: (key: Parameters<typeof translate>[1], values?: never) => Reflect.apply(translate, undefined, ['de-DE', key, values]) }))
vi.mock('../store/catalog.ts', () => ({ useWithHermes: mocks.use, $catalog: {}, catalogEntries: vi.fn(), findCatalogEntry: vi.fn(), loadCatalog: vi.fn(), runCatalog: vi.fn() }))
vi.mock('../store/os-commands.ts', () => ({ ok: (summary: string) => ({ ok: true, summary }), fail: (summary: string) => ({ ok: false, summary }) }))
vi.mock('../store/terminal.ts', () => ({ openTerminalProgram: vi.fn() }))
vi.mock('../store/chat.ts', () => ({ $activeChat: { get: () => null } }))
vi.mock('../store/gateway.ts', () => ({ gatewayRequest: vi.fn() }))
vi.mock('../store/hermes-auth.ts', () => ({ $hermesAuth: { get: () => ({ checked: true, providers: [] }) }, refreshHermesAuth: vi.fn() }))
const { softwareCommands } = await import('./software.ts')
const { LocalModelUnavailable, ModelChangeIncomplete } = await import('../store/model-provider.ts')
const command = softwareCommands.find(c => c.id === 'software.localModel')!
const run = (model: string) => command.run({ server: 'ollama', model }, { source: 'ui' })
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { window: { heraldOS: { catalog: { localModels: mocks.models } } } })
  mocks.models.mockResolvedValue(['llama3:8b', 'llama3:70b'])
  mocks.use.mockResolvedValue({ ok: true, session: { status: 'none' } })
})
it('refuses an ambiguous model prefix without choosing the first hosted model', async () => {
  expect(await run('llama3')).toMatchObject({ ok: false })
  expect(mocks.use).not.toHaveBeenCalled()
})
it.each(['llama3:70b', 'LLAMA3:70B', 'llama3:70'])('resolves only an exact or unique model selection: %s', async model => {
  expect(await run(model)).toMatchObject({ ok: true })
  expect(mocks.use).toHaveBeenCalledWith('ollama', 'llama3:70b')
})
it.each([new LocalModelUnavailable('not-offered'), new Error('secret backend detail')])('returns a localized safe failure for %s', async error => {
  mocks.use.mockRejectedValue(error)
  const result = await run('llama3:8b')
  expect(result.ok).toBe(false)
  expect(result.summary).not.toMatch(/not-offered|secret backend detail/)
  expect(result.summary).toMatch(/Hermes|bestätigt/)
})
it('reports the already saved default when the chat switch failed', async () => {
  mocks.use.mockRejectedValue(new ModelChangeIncomplete('chat-failed'))
  expect(await run('llama3:8b')).toMatchObject({ ok: false, summary: expect.stringContaining('für neue Unterhaltungen gespeichert') })
})

it('distinguishes an unreadable inventory from an unconfirmed write', async () => {
  mocks.models.mockRejectedValue(new Error('private detail'))
  expect(await run('llama3')).toMatchObject({ ok: false, summary: 'Die lokale Modellliste konnte nicht gelesen werden. Prüfe den ausgewählten Server und aktualisiere die Liste.' })
  expect(mocks.use).not.toHaveBeenCalled()
})
it('asks for an exact name when several hosted models match', async () => {
  expect(await run('llama3')).toMatchObject({ ok: false, summary: 'Mehrere Modelle passen zu „llama3“. Wähle den genauen Namen: llama3:8b, llama3:70b.' })
  expect(mocks.use).not.toHaveBeenCalled()
})

it('reports selection without claiming a verified local response', async () => {
  expect(await run('llama3:8b')).toMatchObject({ ok: true, summary: expect.stringContaining('nicht verifiziert') })
})
it('deduplicates exact inventory names without collapsing case-distinct models', async () => {
  mocks.models.mockResolvedValue(['Llama3', 'Llama3', 'llama3'])
  expect((await run('Llama3')).ok).toBe(true)
  expect(mocks.use).toHaveBeenLastCalledWith('ollama', 'Llama3')
  mocks.use.mockClear()
  expect((await run('LLAMA3')).ok).toBe(false)
  expect(mocks.use).not.toHaveBeenCalled()
})
