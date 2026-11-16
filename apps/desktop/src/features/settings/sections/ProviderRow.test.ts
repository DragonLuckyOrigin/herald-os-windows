import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => Object.assign(globalThis, { window: { heraldOS: { office: { onChanged() { return () => {} } } } }, document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } } }))
const { $env, $prefs } = await import('../../../store/backend.ts')
const { $bots } = await import('../../../store/bots.ts')
const { Conversation } = await import('../../hermes/Conversation.tsx')
const { ModelProviderRow, ModelConfirm, ProviderOption, modelChangeNotice, modelErrorText, localProviderText } = await import('./ProviderRow.tsx')
const { providerChoices, providerContext } = await import('../../../lib/model-provider.ts')
const { ModelSetRejected, ModelChangeIncomplete, ModelChangeNotStarted } = await import('../../../store/model-provider.ts')
const { SettingsFilterContext } = await import('./shared.tsx')

it('renders the offline provider chooser in German without altering provider state', () => {
  $prefs.set({ ...$prefs.get(), language: 'de-DE' })
  const html = renderToStaticMarkup(createElement(ModelProviderRow))
  expect(html.includes('Modellanbieter')).toBe(true)
  expect(html.includes('Warten auf Hermes.')).toBe(true)
  expect(html.includes('Anbieter aktualisieren')).toBe(true)
})

const saved = (session: Parameters<typeof modelChangeNotice>[0]['session']) => ({ ok: true as const, provider: 'openai-codex', model: 'gpt-5.1-codex', session })
const NAME = 'ChatGPT or Codex Subscription'

it('tells the person who a saved model reaches, and warns when the chat switch is unconfirmed', () => {
  $prefs.set({ ...$prefs.get(), language: 'en' })

  expect(modelChangeNotice(saved({ status: 'switched', sessionId: 's1' }), NAME, 's1')).toMatchObject({ body: `${NAME} · gpt-5.1-codex: this chat and new conversations now use it.`, level: 'success' })
  expect(modelChangeNotice(saved({ status: 'none' }), NAME, null)).toMatchObject({ level: 'success', body: `${NAME} · gpt-5.1-codex: new conversations use it. No chat was open.` })
  // The chat it was chosen in is no longer the one open: it is not called "this chat".
  expect(modelChangeNotice(saved({ status: 'switched', sessionId: 's1' }), NAME, 's2').body).toBe(`${NAME} · gpt-5.1-codex: the chat you chose it in and new conversations now use it.`)

  const failed = modelChangeNotice(saved({ status: 'failed', sessionId: 's1' }), NAME, 's1')

  expect(failed).toMatchObject({ level: 'warn', title: 'Model saved, chat switch unconfirmed' })
  expect(failed.body).toContain('saved for new conversations')
  expect(failed.body).toContain('was not confirmed')
  expect(failed.body).not.toContain('this chat')
})

it.each([
  ['en', 'Model saved, chat switch queued', 'queued the switch for the next turn'],
  ['de-DE', 'Modell gespeichert, Chat-Wechsel vorgemerkt', 'für den nächsten Chat-Turn']
])('does not present a queued switch as already applied in %s', (language, title, wording) => {
  $prefs.set({ ...$prefs.get(), language: language as 'en' | 'de-DE' })
  const notice = modelChangeNotice(saved({ status: 'queued', sessionId: 's1' }), NAME, 's2')
  expect(notice).toMatchObject({ level: 'warn', title })
  expect(notice.body).toContain(wording)
  expect(notice.body).toContain('gpt-5.1-codex')
  expect(notice.body).not.toMatch(/this chat and new conversations now use|Dieser Chat und neue Unterhaltungen verwenden/)
})

it('says the same in German', () => {
  $prefs.set({ ...$prefs.get(), language: 'de-DE' })

  const failed = modelChangeNotice(saved({ status: 'failed', sessionId: 's1' }), NAME, 's1')

  expect(failed).toMatchObject({ level: 'warn', title: 'Modell gespeichert, Chat-Wechsel unbestätigt' })
  expect(failed.body).toBe(`${NAME} · gpt-5.1-codex ist für neue Unterhaltungen gespeichert. Der Wechsel im zuvor geöffneten Chat wurde nicht bestätigt.`)
  expect(modelChangeNotice(saved({ status: 'switched', sessionId: 's1' }), NAME, 's1').body).toContain('Dieser Chat und neue Unterhaltungen')
})

it("localizes refusals without exposing raw backend errors or guessing a runtime cause", () => {
  $prefs.set({ ...$prefs.get(), language: 'de-DE' })
  expect(modelErrorText(new ModelSetRejected('openai-codex', 'gpt-5.1-codex'))).toBe('Hermes hat das Speichern von gpt-5.1-codex nicht bestätigt. Prüfe die aktuelle Auswahl vor einem weiteren Versuch.')
  const unknown = modelErrorText(new Error('SC1 backend HTTP 400: C:/private/token secret-test-key'))
  expect(unknown).not.toMatch(/private|secret-test-key|Runtime.*ausgeschaltet/)
  expect(unknown).toContain('nicht bestätigt')
  $prefs.set({ ...$prefs.get(), language: 'en' })
  expect(modelErrorText(new ModelSetRejected('openai-codex', 'gpt-5.1-codex'))).toBe('Hermes did not confirm saving gpt-5.1-codex. Check the current selection before trying again.')
})

it('translates confirmation controls while preserving the supplied model warning', () => {
  $prefs.set({ ...$prefs.get(), language: 'de-DE' })
  const html = renderToStaticMarkup(createElement(ModelConfirm, { message: 'Provider-specific warning', busy: false, onCancel() {}, onConfirm() {} }))
  expect(html.includes('Provider-specific warning')).toBe(true)
  expect(html.includes('Abbrechen')).toBe(true)
  expect(html.includes('Trotzdem verwenden')).toBe(true)
})

it('distinguishes disabled runtime, unknown state and catalogue evidence in German', () => {
  $prefs.set({ ...$prefs.get(), language: 'de-DE' })
  const options = { provider: 'llamacpp', model: 'imported.gguf', providers: [{ slug: 'llamacpp', name: 'Local', authenticated: true, is_current: true, models: ['imported.gguf'] }] }
  const describe = (enabled?: boolean) => localProviderText(providerChoices(options, [], {}, {}, providerContext({ local_runtime: { enabled } }))[0])
  expect(describe(false)).toContain('ausgeschaltet')
  expect(describe()).toContain('unbekannt')
  expect(describe(true)).toContain('nicht verifiziert')
  expect(describe(true)).not.toContain('ausgeschaltet')
})

// The repository discovers .test.ts files; include the approved TSX picker suite here.
await import('./AgentsSection.test.tsx')

it('shows Hermes in the Windows default-profile landing and keeps named bot identity', () => {
  const environment = $env.get(), prefs = $prefs.get(), bots = $bots.get()
  try {
    $env.set({ ...environment!, platform: 'win32' })
    $prefs.set({ ...prefs, language: 'de-DE', conversationBot: 'default' })
    const landing = renderToStaticMarkup(createElement(Conversation, { chat: null, online: false }))
    expect(landing).toContain('hermes-avatar.jpg')
    expect(landing).toMatch(/>Hermes<\/div>/)
    expect(landing).not.toMatch(/>DRAGON OS<\/div>/)
    $bots.set([...bots, { profile: 'research', name: 'Researcher', description: '', hasAvatar: false }])
    $prefs.set({ ...$prefs.get(), conversationBot: 'research' })
    const named = renderToStaticMarkup(createElement(Conversation, { chat: null, online: false }))
    expect(named).toContain('>Researcher</div>')
    expect(named).not.toContain('dragon-mark.png')
    $env.set({ ...environment!, platform: 'linux' })
    $prefs.set({ ...prefs, language: 'de-DE', conversationBot: 'default' })
    expect(renderToStaticMarkup(createElement(Conversation, { chat: null, online: false }))).toContain('>Hermes</div>')
  } finally {
    $env.set(environment); $prefs.set(prefs); $bots.set(bots)
  }
})

it('describes completed writes separately from incomplete follow-up actions', () => {
  $prefs.set({ ...$prefs.get(), language: 'de-DE' })
  expect(modelErrorText(new ModelChangeIncomplete('key-saved', 'secret raw error'))).toContain('Schlüssel wurde gespeichert')
  expect(modelErrorText(new ModelChangeIncomplete('chat-failed'))).toContain('für neue Unterhaltungen gespeichert')
  expect(modelErrorText(new ModelChangeIncomplete('chat-queued'))).toContain('vorgemerkt')
  expect(modelErrorText(new ModelChangeIncomplete('key-saved', 'secret raw error'))).not.toContain('secret')
})

it('marks only the exact current local model visually and accessibly', () => {
  const choice = providerChoices({ providers: [{ slug: 'llamacpp', name: 'Local', authenticated: true, is_current: true, models: ['a.gguf', 'b.gguf'] }] }, [], {}, {}, providerContext({ local_runtime: { enabled: true } }))[0]
  const html = choice.models.map(model => renderToStaticMarkup(createElement(ProviderOption, { choice, model, currentModel: 'b.gguf', onPick() {} }))).join('')
  expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
  expect(html.match(/bg-accent-soft/g)).toHaveLength(1)
  expect(html.match(/text-accent-strong/g)).toHaveLength(1)
  expect(html).toContain('provider:llamacpp:a.gguf')
  expect(html).toContain('provider:llamacpp:b.gguf')
})

it.each(['ollama', 'lm studio', 'llamacpp', 'gguf', 'lokale modelle'])('keeps the provider row searchable for %s', query => {
  $prefs.set({ ...$prefs.get(), language: 'de-DE' })
  const html = renderToStaticMarkup(createElement(SettingsFilterContext.Provider, { value: query }, createElement(ModelProviderRow)))
  expect(html).toContain('Modellanbieter')
})
it.each(['en', 'de-DE'] as const)('qualifies local success as unverified inference in %s', language => {
  $prefs.set({ ...$prefs.get(), language })
  const notice = modelChangeNotice({ ...saved({ status: 'switched', sessionId: 's' }), local: 'ollama' }, 'Ollama', 's')
  expect(notice.body).toContain(language === 'en' ? 'No local response has been verified yet.' : 'Eine lokale Antwort wurde noch nicht verifiziert.')
})

it.each(['en', 'de-DE'] as const)('distinguishes pre-write errors from unconfirmed writes in %s', language => {
  $prefs.set({ ...$prefs.get(), language })
  for (const reason of ['provider-unavailable', 'no-models', 'key-required'] as const) {
    const text = modelErrorText(new ModelChangeNotStarted(reason))
    expect(text).toMatch(language === 'en' ? /no model change was attempted\./i : /kein Modellwechsel versucht\./)
    expect(text).not.toContain(reason)
  }
})

it('keeps the visible provider description searchable', () => {
  $prefs.set({ ...$prefs.get(), language: 'de-DE' })
  const html = renderToStaticMarkup(createElement(SettingsFilterContext.Provider, { value: 'warten auf hermes' }, createElement(ModelProviderRow)))
  expect(html).toContain('Modellanbieter')
  expect(html).toContain('Warten auf Hermes.')
})
