import { t } from './i18n.ts'
import type { ModelOptionsResult } from '@herald-os/client'
import { atom } from 'nanostores'
import { type ChatSwitch, type EndpointKeys, endpointKeys, type KeyCatalog, type LocalProvider, pickModel, type ProviderChoice, providerChoices, providerContext } from '../lib/model-provider.ts'
import { rest } from '../lib/rest.ts'
import { $activeChat } from './chat.ts'
import { gatewayRequest } from './gateway.ts'
import { $hermesAuth, refreshHermesAuth } from './hermes-auth.ts'

/*
 * The model provider and model Hermes thinks with, changed from the OS. The choice is written where
 * `hermes model` writes it (`/api/model/set`, config.yaml), so new conversations and the Hermes CLI
 * use it too, and the open chat moves along through `config.set model`. API keys go where Hermes
 * keeps them (`/api/env`, its .env file); signing in to an account runs on the OS card (hermes-auth.ts).
 */

/** Bumped after every change, so whatever lists providers or models reads them again. */
export const $providerChanges = atom(0)

/** The provider and model lists read again, as after a sign-in that finished on the card. */
export function providersChanged(): void {
  $providerChanges.set($providerChanges.get() + 1)
}

/** A request to show the provider chooser (Settings, first-run setup), at one provider's setup when `slug` is set. */
export const $providerFocus = atom<{ slug?: string; ts: number } | null>(null)

export function focusProvider(slug?: string): void {
  $providerFocus.set({ slug, ts: Date.now() })
}

const names = new Map<string, string>()
const rowSlugs = new Map<string, string>()

/** A provider's display name, once a list of providers has been read. */
export function providerName(slug: string | null | undefined): string | null {
  return slug ? (names.get(slug) ?? null) : null
}

/** The slug of the row a provider id names, once a list has been read: config.yaml calls a custom endpoint `custom:<name>`, its row has the bare name. */
export function providerSlug(id: string): string {
  return rowSlugs.get(id) ?? id
}

/** Every provider Hermes knows, set up or not: what `hermes model` offers. */
export async function loadModelOptions(): Promise<ModelOptionsResult> {
  const options = await gatewayRequest('model.options', { include_unconfigured: true })
  const rows = options.providers ?? []
  const own = new Set(rows.map(row => row.slug))
  names.clear()
  rowSlugs.clear()

  for (const row of rows) {
    names.set(row.slug, row.name)

    // An endpoint named after a provider does not take that provider's id.
    for (const alias of (row.aliases ?? []).filter(alias => !own.has(alias))) {
      names.set(alias, row.name)
      rowSlugs.set(alias, row.slug)
    }
  }

  return options
}

/**
 * Hermes's key catalog: which variable each provider's API key goes in, where to get one, and
 * whether one is saved. Empty when the runtime has none. The route also previews the saved keys;
 * those are dropped here.
 */
export function loadKeyCatalog(): Promise<KeyCatalog> {
  return rest
    .get<KeyCatalog | null>('/api/env')
    .then(keys => Object.fromEntries(Object.entries(keys ?? {}).map(([name, { provider, is_password, is_set, url }]) => [name, { provider, is_password, is_set, url }])))
    .catch(() => ({}))
}

/** The variable each custom endpoint's API key goes in, as its entry in config.yaml names it. */
export function loadEndpointKeys(): Promise<EndpointKeys> {
  return loadProviderConfig().then(config => config.keys)
}

/** Reuse the native config read; discard keys/URLs and leave unavailable runtime evidence unknown. */
export function loadProviderConfig() {
  return rest.get<Parameters<typeof providerContext>[0]>('/api/config', { include_defaults: false })
    .then(config => ({ keys: endpointKeys(config), context: providerContext(config) }))
    .catch(() => ({ keys: {}, context: providerContext(null) }))
}

/** The providers as Settings lists them, read now. */
export async function readProviderChoices(): Promise<ProviderChoice[]> {
  const [options, keys, config, auth] = await Promise.all([loadModelOptions(), loadKeyCatalog(), loadProviderConfig(), $hermesAuth.get().checked ? $hermesAuth.get() : refreshHermesAuth()])

  return providerChoices(options, auth.providers, keys, config.keys, config.context)
}

interface ModelSetResponse {
  ok?: boolean
  provider?: string
  model?: string
  confirm_required?: boolean
  confirm_message?: string
}

/**
 * A change Hermes made, or one it holds until the person confirms the warning (a model far pricier
 * than most). A change that was made saved the default; `session` says whether the chat that was
 * open when it was chosen moved along too.
 */
export type ModelChange = { ok: true; provider: string; model: string; session: ChatSwitch; local?: LocalProvider } | { ok: false; provider: string; model: string; confirm: string; sessionId: string | null; local?: LocalProvider }

export class LocalModelUnavailable extends Error {
  constructor(readonly reason: 'runtime-disabled' | 'not-offered' | 'ambiguous-model') {
    super(reason)
  }
}

/** A prerequisite failed before any model or key write was attempted. */
export class ModelChangeNotStarted extends Error {
  constructor(readonly reason: 'provider-unavailable' | 'no-models' | 'key-required') { super(reason) }
}

/** A known write succeeded, but the subsequent action remains incomplete. */
export class ModelChangeIncomplete extends Error {
  constructor(readonly reason: 'key-saved' | 'chat-failed' | 'chat-queued' | 'in-progress', message: string = reason) { super(message) }
}

/** The default change was not acknowledged; do not infer whether a write happened. */
export class ModelSetRejected extends Error {
  readonly provider: string
  readonly model: string

  constructor(provider: string, model: string) {
    super(`Hermes did not confirm saving ${model}. Check the current selection before trying again.`)
    this.name = 'ModelSetRejected'
    this.provider = provider
    this.model = model
  }
}

/**
 * Make `provider` and `model` Hermes's default and move the open chat to them; `confirmed` accepts a
 * price warning. Neither step is retried or undone: a default that was saved stays saved when the
 * chat switch is unconfirmed, and the result says so (`session.status === 'failed'`), without the reason.
 * The chat moved is the one open when this was called, not one opened while Hermes answered.
 */
let modelChangeInFlight = false

export async function setHermesModel(provider: string, model: string, confirmed = false, sessionId: string | null = $activeChat.get()?.sessionId ?? null, exactProviders?: readonly string[]): Promise<ModelChange> {
  if (modelChangeInFlight) throw new ModelChangeIncomplete('in-progress')
  modelChangeInFlight = true
  try { return await applyHermesModel(provider, model, confirmed, sessionId, exactProviders) }
  finally { modelChangeInFlight = false }
}

async function applyHermesModel(provider: string, model: string, confirmed: boolean, sessionId: string | null, exactProviders?: readonly string[]): Promise<ModelChange> {
  const result = await rest.post<ModelSetResponse | null>('/api/model/set', { scope: 'main', provider, model, confirm_expensive_model: confirmed })

  if (result?.confirm_required) {
    return { ok: false, provider, model, confirm: result.confirm_message?.trim() || `${model} costs far more than most models.`, sessionId }
  }

  if (result?.ok !== true || typeof result.provider !== 'string' || !result.provider.trim() || typeof result.model !== 'string' || !result.model.trim()) {
    throw new ModelSetRejected(provider, model)
  }

  if (exactProviders && (result.model !== model || !exactProviders.includes(result.provider))) {
    providersChanged()
    throw new ModelSetRejected(provider, model)
  }
  const saved = { provider: result.provider, model: result.model }
  let session: ChatSwitch = { status: 'none' }

  if (sessionId) {
    // A conversation keeps the model it started with; this one follows the change. The default is
    // saved either way, so a chat that cannot switch now still leaves new ones on the new model.
    session = await gatewayRequest('config.set', { session_id: sessionId, key: 'model', value: `${saved.model} --provider ${saved.provider}`, confirm_expensive_model: true }).then(
      (ack): ChatSwitch => {
        if (!ack || ack.confirm_required || ack.key !== 'model' || ack.value !== saved.model) return { status: 'failed', sessionId }
        return { status: ack.deferred ? 'queued' : 'switched', sessionId }
      },
      (): ChatSwitch => ({ status: 'failed', sessionId })
    )
  }

  providersChanged()
  // Only the views read again; the change is already made, so a failure here is not the change's.
  await refreshHermesAuth().catch(() => undefined)

  return { ok: true, ...saved, session }
}

/** Switch Hermes to a provider that is set up: on its saved model when it already is the provider, else on Hermes's recommendation for it. */
export async function switchToProvider(slug: string, confirmed = false, sessionId: string | null = $activeChat.get()?.sessionId ?? null): Promise<ModelChange> {
  const options = await loadModelOptions()
  const row = options.providers.find(provider => provider.slug === slug)

  if (!row) {
    throw new ModelChangeNotStarted('provider-unavailable')
  }

  const [config, keys] = await Promise.all([loadProviderConfig(), loadKeyCatalog()])
  const choice = providerChoices(options, [], keys, config.keys, config.context).find(item => item.slug === slug)
  if (choice?.local) {
    if (choice.localState === 'disabled') throw new LocalModelUnavailable('runtime-disabled')
    if (!choice.ready) throw new LocalModelUnavailable('not-offered')
    const model = row.is_current && options.model && choice.models.includes(options.model) ? options.model : choice.models.length === 1 ? choice.models[0] : null
    if (!model) throw new LocalModelUnavailable('ambiguous-model')
    return selectLocalModel(row.slug, model, confirmed, sessionId, choice.local)
  }

  if (row.authenticated === false) throw new ModelChangeNotStarted('provider-unavailable')
  const recommended = row.is_current && options.model ? null : await rest.get<{ model?: string } | null>('/api/model/recommended-default', { provider: slug }).then(
    result => result?.model ?? null,
    () => null
  )
  const model = pickModel(row, options.model, recommended)

  if (!model) {
    throw new ModelChangeNotStarted('no-models')
  }

  return setHermesModel(row.slug, model, confirmed, sessionId)
}

/** The preferred-model picker uses the same local eligibility checks as the provider chooser. */
export async function selectPreferredModel(provider: string, model: string, confirmation?: Extract<ModelChange, { ok: false }>): Promise<ModelChange> {
  if (confirmation && (confirmation.provider !== provider || confirmation.model !== model)) throw new ModelChangeNotStarted('provider-unavailable')
  const sessionId = confirmation ? confirmation.sessionId : $activeChat.get()?.sessionId ?? null
  if (confirmation?.local) return confirmModelChange(confirmation)

  const [options, config, keys] = await Promise.all([loadModelOptions(), loadProviderConfig(), loadKeyCatalog()])
  const rows = options.providers.filter(row => row.slug === provider || row.aliases?.includes(provider))
  if (rows.length !== 1) throw new ModelChangeNotStarted('provider-unavailable')
  const row = rows[0]
  // A custom endpoint cannot bypass local checks just because its config read failed.
  if (row.is_user_defined && !config.context.configKnown) throw new ModelChangeNotStarted('provider-unavailable')
  const choice = providerChoices({ ...options, providers: rows }, [], keys, config.keys, config.context)[0]
  if (choice?.local) return selectLocalModel(row.slug, model, Boolean(confirmation), sessionId, choice.local)
  if (!choice?.ready || !choice.models.includes(model)) throw new ModelChangeNotStarted('provider-unavailable')
  const aliases = (row.aliases ?? []).filter(alias => !options.providers.some(other => other !== row && (other.slug === alias || other.aliases?.includes(alias))))
  return setHermesModel(row.slug, model, Boolean(confirmation), sessionId, [row.slug, ...aliases])
}

/** Re-read the native pair on every local choice, including a held price confirmation. */
export async function selectLocalModel(provider: string, model: string, confirmed = false, sessionId: string | null = $activeChat.get()?.sessionId ?? null, expectedKind?: LocalProvider): Promise<ModelChange> {
  const [options, config, keys] = await Promise.all([loadModelOptions(), loadProviderConfig(), loadKeyCatalog()])
  const rows = options.providers.filter(row => row.slug === provider || row.aliases?.includes(provider))
  if (rows.length !== 1) throw new LocalModelUnavailable('not-offered')
  const choice = providerChoices({ ...options, providers: rows }, [], keys, config.keys, config.context)[0]
  if (choice?.localState === 'disabled') throw new LocalModelUnavailable('runtime-disabled')
  if (!choice?.local || !choice.ready || !choice.models.includes(model) || (expectedKind && choice.local !== expectedKind)) throw new LocalModelUnavailable('not-offered')
  // Bind the ACK to this fresh catalog snapshot, never to a mutable display alias cache.
  const row = rows[0]
  const aliases = (row.aliases ?? []).filter(alias => !options.providers.some(other => other !== row && (other.slug === alias || other.aliases?.includes(alias))))
  const change = await setHermesModel(row.slug, model, confirmed, sessionId, [row.slug, ...aliases])
  return { ...change, local: choice.local }
}

export function confirmModelChange(change: Extract<ModelChange, { ok: false }>): Promise<ModelChange> {
  return change.local
    ? selectLocalModel(change.provider, change.model, true, change.sessionId, change.local)
    : setHermesModel(change.provider, change.model, true, change.sessionId)
}

/** Save a provider's API key where Hermes keeps its keys, then switch Hermes to that provider. */
export async function saveProviderKey(choice: ProviderChoice, key: string): Promise<ModelChange> {
  const sessionId = $activeChat.get()?.sessionId ?? null
  const value = key.trim()

  if (!choice.keyEnv || !value) {
    throw new ModelChangeNotStarted('key-required')
  }

  await rest.put('/api/env', { key: choice.keyEnv, value })
  // The runtime reads keys from its own environment as well as from the file.
  await gatewayRequest('reload.env', {}).catch(() => undefined)

  try {
    return await switchToProvider(choice.slug, false, sessionId)
  } catch {
    providersChanged()
    throw new ModelChangeIncomplete('key-saved')
  }
}

/** Never expose backend response text, credential fragments or paths; HTTP 400 alone has no known cause. */
export function modelErrorText(error: unknown): string {
  if (error instanceof ModelChangeNotStarted) return t(error.reason === 'provider-unavailable' ? 'settings.provider.notStarted.providerUnavailable' : error.reason === 'no-models' ? 'settings.provider.notStarted.noModels' : 'settings.provider.notStarted.keyRequired')
  if (error instanceof LocalModelUnavailable) return t(error.reason === 'runtime-disabled' ? 'settings.provider.local.disabled' : error.reason === 'ambiguous-model' ? 'settings.provider.local.chooseExact' : 'settings.provider.local.notOffered')
  if (error instanceof ModelChangeIncomplete) return t(error.reason === 'in-progress' ? 'settings.provider.inProgress' : error.reason === 'key-saved' ? 'settings.provider.partial.keySaved' : error.reason === 'chat-failed' ? 'settings.provider.partial.failed' : 'settings.provider.partial.queued')
  return error instanceof ModelSetRejected ? t('settings.agents.model.rejected', { model: error.model }) : t('settings.provider.changeUnconfirmed')
}
