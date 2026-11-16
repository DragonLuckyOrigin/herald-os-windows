import type { ModelOptionsResult } from '@herald-os/client'
import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { preferredModelOptions } from '../../../lib/model-provider.ts'
import type { PreferredModelListState, PreferredModelPick } from './AgentsSection.tsx'

vi.hoisted(() => Object.assign(globalThis, { window: { heraldOS: {} }, document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } } }))

const { $prefs } = await import('../../../store/backend.ts')
const { PreferredModelList, preferredModelLabel, preferredModelListState } = await import('./AgentsSection.tsx')

/*
 * The picker's model list is rendered here as static markup, and its real component function is
 * called to reach the `onClick` of each model button, so what is checked is which provider and model
 * the list hands to its selection callback. That is not a pointer interaction in the window; the
 * installed application's model switch stays a separate live check.
 */

type ElementProps = { children?: ReactNode; onClick?: () => void; disabled?: boolean; 'data-os-target'?: string; 'aria-pressed'?: boolean }

function find(node: ReactNode, test: (element: ReactElement<ElementProps>) => boolean, found: ReactElement<ElementProps>[] = []): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) {
    node.forEach(child => find(child, test, found))
  } else if (node && typeof node === 'object' && 'props' in node) {
    const element = node as ReactElement<ElementProps>

    if (test(element)) {
      found.push(element)
    }

    find(element.props.children, test, found)
  }

  return found
}

const buttons = (node: ReactNode) => find(node, element => element.type === 'button')
const language = (setting: 'en' | 'de-DE') => $prefs.set({ ...$prefs.get(), language: setting })
const noPick = () => undefined

const SUBSCRIPTION: ModelOptionsResult = {
  model: 'gpt-5.1-codex',
  provider: 'openai-codex',
  providers: [
    { slug: 'nous', name: 'Nous Portal', is_current: true, authenticated: true, models: ['hermes-4-405b'] },
    { slug: 'openrouter', name: 'OpenRouter', is_current: false, authenticated: true, models: ['openai/gpt-5.1-codex', 'anthropic/claude-opus-4.6'] },
    { slug: 'openai-codex', name: 'ChatGPT or Codex Subscription', is_current: false, authenticated: true, models: ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'GPT-5-Pro'] }
  ]
}

const ENDPOINT: ModelOptionsResult = {
  model: 'qwen3-30b-a3b',
  provider: 'custom:qwen-flash',
  providers: [{ slug: 'qwen-flash', name: 'qwen-flash', is_current: true, authenticated: true, models: ['qwen3-30b-a3b', 'qwen3-8b'], aliases: ['custom:qwen-flash', 'qwen-flash'] }]
}

const ready = (options: ModelOptionsResult | null, filter = ''): PreferredModelListState => ({ kind: 'models', view: preferredModelOptions(options, filter) })
const render = (state: PreferredModelListState, pending: PreferredModelPick | null = null) => renderToStaticMarkup(createElement(PreferredModelList, { state, pending, onSelect: noPick }))

it('marks the active pair accessibly and never dispatches it or a busy selection', () => {
  const pick = vi.fn()
  const models = buttons(PreferredModelList({ state: ready(SUBSCRIPTION), pending: null, onSelect: pick }))
  expect(models[0].props['aria-pressed']).toBe(true)
  expect(models[0].props.disabled).toBe(true)
  models[0].props.onClick?.()
  expect(pick).not.toHaveBeenCalled()
  expect(models[1].props['aria-pressed']).toBe(false)
  models[1].props.onClick?.()
  expect(pick).toHaveBeenCalledWith({ provider: 'openai-codex', model: 'gpt-5.1-codex-mini' })
  pick.mockClear()
  const busy = buttons(PreferredModelList({ state: ready(SUBSCRIPTION), pending: { provider: 'openai-codex', model: 'gpt-5.1-codex-mini' }, onSelect: pick }))
  busy.forEach(button => button.props.onClick?.())
  expect(pick).not.toHaveBeenCalled()
})

it("renders only the current provider's models under a label naming that provider", () => {
  language('en')
  const html = render(ready(SUBSCRIPTION))

  expect(html).toContain('Models from ChatGPT or Codex Subscription')
  expect(html).toContain('change it under Model provider')

  for (const model of ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'GPT-5-Pro']) {
    expect(html).toContain(model)
  }

  // Not the flagged-current row, and not a model named like the current one.
  for (const other of ['Nous Portal', 'hermes-4-405b', 'OpenRouter', 'openai/gpt-5.1-codex', 'claude-opus']) {
    expect(html).not.toContain(other)
  }
})

it('renders the same list in German without translating provider or model names', () => {
  language('de-DE')
  const html = render(ready(SUBSCRIPTION))

  expect(html).toContain('Modelle von ChatGPT or Codex Subscription')
  expect(html).toContain('Modellanbieter')
  expect(html).toContain('gpt-5.1-codex-mini')
  language('en')
})

it("hands the selection callback the listed provider's slug and the model exactly as listed", () => {
  language('en')
  const picks: PreferredModelPick[] = []
  const list = PreferredModelList({ state: ready(SUBSCRIPTION), pending: null, onSelect: pick => picks.push(pick) })
  const models = buttons(list)

  expect(models.map(button => button.props['data-os-target'])).toEqual(['model:gpt-5.1-codex', 'model:gpt-5.1-codex-mini', 'model:GPT-5-Pro'])

  models[1].props.onClick?.()
  models[2].props.onClick?.()

  expect(picks).toEqual([
    { provider: 'openai-codex', model: 'gpt-5.1-codex-mini' },
    { provider: 'openai-codex', model: 'GPT-5-Pro' }
  ])
})

it('sends the endpoint row\'s own slug, not the alias Hermes reports it under', () => {
  const picks: PreferredModelPick[] = []
  const list = PreferredModelList({ state: ready(ENDPOINT), pending: null, onSelect: pick => picks.push(pick) })

  buttons(list)[1].props.onClick?.()

  expect(picks).toEqual([{ provider: 'qwen-flash', model: 'qwen3-8b' }])
})

it('lists only the models that match the filter, with the same payloads', () => {
  const picks: PreferredModelPick[] = []
  const list = PreferredModelList({ state: ready(SUBSCRIPTION, 'MINI'), pending: null, onSelect: pick => picks.push(pick) })
  const models = buttons(list)

  expect(models).toHaveLength(1)
  models[0].props.onClick?.()
  expect(picks).toEqual([{ provider: 'openai-codex', model: 'gpt-5.1-codex-mini' }])
})

it('disables every model while a change is under way and marks the one being switched to', () => {
  language('en')
  const pending = { provider: 'openai-codex', model: 'gpt-5.1-codex-mini' }
  const list = PreferredModelList({ state: ready(SUBSCRIPTION), pending, onSelect: noPick })

  expect(buttons(list).every(button => button.props.disabled === true)).toBe(true)
  expect(render(ready(SUBSCRIPTION), pending)).toContain('Switching…')
  expect(render(ready(SUBSCRIPTION))).not.toContain('Switching…')
})

it('shows the first forty models and counts the rest', () => {
  const many = Array.from({ length: 45 }, (_, index) => `model-${index}`)
  const row = { slug: 'big', name: 'Big', is_current: true, authenticated: true, models: many, total_models: 60 }
  const list = PreferredModelList({ state: ready({ model: 'model-0', provider: 'big', providers: [row] }), pending: null, onSelect: noPick })

  expect(buttons(list)).toHaveLength(40)
  expect(find(list, element => element.type === 'span' && Array.isArray(element.props.children) && element.props.children[1] === 20)).toHaveLength(1)
})

it('says why there is no list instead of offering another provider\'s models', () => {
  language('en')
  const cases: [PreferredModelListState, string][] = [
    [ready({ ...SUBSCRIPTION, provider: '' }), 'Hermes reports no current model provider'],
    [ready({ ...SUBSCRIPTION, provider: 'anthropic' }), 'Hermes lists no entry for the current provider (anthropic)'],
    [ready({ model: 'a', provider: 'both', providers: ['a', 'b'].map(slug => ({ slug, name: slug.toUpperCase(), is_current: false, authenticated: true, models: [`${slug}-model`], aliases: ['both'] })) }), 'More than one entry matches the current provider (both)'],
    [ready({ ...SUBSCRIPTION, providers: [{ ...SUBSCRIPTION.providers[2], authenticated: false }] }), 'ChatGPT or Codex Subscription is not signed in or set up'],
    [ready({ ...SUBSCRIPTION, providers: [{ ...SUBSCRIPTION.providers[2], models: [] }] }), 'Hermes lists no models for ChatGPT or Codex Subscription yet.'],
    [ready(SUBSCRIPTION, 'zzz'), 'No ChatGPT or Codex Subscription model matches the filter.'],
    [{ kind: 'error', error: 'boom' }, 'Could not read the models: boom']
  ]

  for (const [state, message] of cases) {
    const html = render(state)

    expect(html, message).toContain(message)
    expect(html, message).not.toContain('<button')
    expect(html, message).not.toContain('hermes-4-405b')
    expect(html, message).not.toContain('openai/gpt-5.1-codex')
  }

  expect(render({ kind: 'loading' })).not.toContain('<button')
})

it('says so in German when the provider is not set up', () => {
  language('de-DE')
  const html = render(ready({ ...SUBSCRIPTION, providers: [{ ...SUBSCRIPTION.providers[2], authenticated: false }] }))

  expect(html).toContain('ChatGPT or Codex Subscription ist nicht angemeldet oder eingerichtet')
  expect(html).not.toContain('<button')
  language('en')
})

it('flags a current model that the provider does not list, and still offers only its own', () => {
  language('en')
  const html = render(ready({ ...SUBSCRIPTION, model: 'hermes-4-405b' }))

  expect(html).toContain('The current model (hermes-4-405b) is not in the list Hermes gives for ChatGPT or Codex Subscription.')
  expect(html).toContain('gpt-5.1-codex-mini')
  expect(html).not.toContain('Nous Portal')
  expect(buttons(PreferredModelList({ state: ready({ ...SUBSCRIPTION, model: 'hermes-4-405b' }), pending: null, onSelect: noPick }))).toHaveLength(3)
})

it('offers models only from an answer read since the last provider change', () => {
  const answered = { changes: 1, result: SUBSCRIPTION }

  expect(preferredModelListState({ data: answered, loading: false, error: null }, 1, '')).toMatchObject({ kind: 'models', view: { status: 'ready', slug: 'openai-codex' } })
  expect(preferredModelListState({ data: answered, loading: false, error: null }, 1, 'mini')).toMatchObject({ kind: 'models', view: { models: ['gpt-5.1-codex-mini'] } })
  // A provider change happened: the answer is about the provider before it, even before a new read has begun.
  expect(preferredModelListState({ data: answered, loading: false, error: null }, 2, '')).toEqual({ kind: 'loading' })
  expect(preferredModelListState({ data: answered, loading: true, error: null }, 1, '')).toEqual({ kind: 'loading' })
  expect(preferredModelListState({ data: null, loading: false, error: null }, 0, '')).toEqual({ kind: 'loading' })
  // A failed read says so, and does not fall back to the older answer.
  expect(preferredModelListState({ data: answered, loading: false, error: 'offline' }, 1, '')).toEqual({ kind: 'error', error: 'offline' })
})

it('names the current provider and model on the button, or why it cannot', () => {
  language('en')
  expect(preferredModelLabel(ready(SUBSCRIPTION))).toBe('ChatGPT or Codex Subscription · gpt-5.1-codex')
  expect(preferredModelLabel(ready({ ...SUBSCRIPTION, model: 'hermes-4-405b' }))).toBe('ChatGPT or Codex Subscription · hermes-4-405b')
  expect(preferredModelLabel(ready({ ...SUBSCRIPTION, provider: 'anthropic' }))).toBe('anthropic · gpt-5.1-codex')
  expect(preferredModelLabel(ready({ ...SUBSCRIPTION, provider: '' }))).toBe('gpt-5.1-codex')
  expect(preferredModelLabel({ kind: 'error', error: 'offline' })).toBe('Models unavailable')
  language('de-DE')
  expect(preferredModelLabel({ kind: 'error', error: 'offline' })).toBe('Modelle nicht verfügbar')
  language('en')
})
