import type { ModelOptionProvider, ModelOptionsResult } from '@herald-os/client'

/*
 * The model providers Hermes knows, as the OS offers them (pure; tested). `model.options` with the
 * unconfigured ones lists what `hermes model` lists, the sign-in list (`/api/providers/oauth`) says
 * which sign in on an account, and Hermes's key catalog (`/api/env`) names the variable an API key
 * goes in and where to get one. A custom endpoint's entry in config.yaml names its own variable.
 */

/** How a provider that is not ready yet gets ready; `endpoint` is one of the person's own whose entry names no key. */
export type ProviderSetup = 'key' | 'sign-in' | 'terminal' | 'local' | 'endpoint'

export interface ProviderChoice {
  slug: string
  name: string
  current: boolean
  /** Eligible for selection; never evidence of a loaded model or successful inference. */
  ready: boolean
  local?: LocalProvider
  localState?: 'disabled' | 'unknown' | 'catalogued' | 'unavailable'
  setup: ProviderSetup
  /** The variable its API key goes in (`key`). */
  keyEnv: string | null
  /** Where to get an API key, or how its sign-in works. */
  helpUrl: string | null
  /** What to run in a terminal, for a provider that signs in through its own tool (`terminal`). */
  command: string | null
  models: string[]
}

/** The parts of a sign-in provider that the choices read. */
export interface SignInProvider {
  id: string
  flow: 'device_code' | 'external'
  cliCommand: string | null
  docsUrl: string | null
  loggedIn: boolean
}

/** One variable of Hermes's key catalog (`GET /api/env`). */
export interface KeyCatalogEntry {
  provider?: string
  is_password?: boolean
  is_set?: boolean
  url?: string | null
}

export type KeyCatalog = Record<string, KeyCatalogEntry>

/** The variable each custom endpoint keeps its API key in, by endpoint id. */
export type EndpointKeys = Record<string, string>

export type LocalProvider = 'hermes' | 'ollama' | 'lmstudio' | 'endpoint'
export interface ProviderContext {
  configKnown: boolean
  localRuntimeEnabled: boolean | null
  /** Only a classification is retained, never URLs or credentials. Null overrides legacy entries. */
  endpoints: Record<string, LocalProvider | null>
}

export function localProvider(row: ModelOptionProvider, context?: ProviderContext): LocalProvider | undefined {
  const id = endpointId(row.slug)
  if (context && Object.hasOwn(context.endpoints, id)) return context.endpoints[id] ?? undefined
  if (row.is_user_defined) return undefined
  if (row.slug === 'llamacpp') return 'hermes'
  if (row.slug === 'lmstudio') return 'lmstudio'
  return row.auth_type === 'local' ? 'endpoint' : undefined
}

/** Project supported native config into nonsecret presentation evidence, without probing/starting servers. */
export function providerContext(config: { providers?: unknown; custom_providers?: unknown; local_runtime?: unknown } | null | undefined): ProviderContext {
  const endpoints: ProviderContext['endpoints'] = Object.create(null)
  const add = (id: string, entry: unknown) => {
    if (!id || Object.hasOwn(endpoints, id)) return
    endpoints[id] = null
    if (!isRecord(entry) || typeof entry.base_url !== 'string') return
    try {
      const url = new URL(entry.base_url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return
      const standardPath = /^\/v1\/?$/.test(url.pathname)
      endpoints[id] = standardPath && url.port === '11434' ? 'ollama' : standardPath && url.port === '1234' ? 'lmstudio' : 'endpoint'
    } catch { /* Invalid endpoint evidence stays unknown. */ }
  }
  for (const [id, entry] of Object.entries(isRecord(config?.providers) ? config.providers : {})) add(endpointId(id), entry)
  for (const entry of Array.isArray(config?.custom_providers) ? config.custom_providers : []) {
    if (isRecord(entry)) add(endpointId(String(entry.provider_key || namePrefix(String(entry.name ?? '')))), entry)
  }
  const enabled = isRecord(config?.local_runtime) ? config.local_runtime.enabled : null
  return { configKnown: isRecord(config), localRuntimeEnabled: typeof enabled === 'boolean' ? enabled : null, endpoints }
}

/** Every provider Hermes knows: the current one first, then those ready to use, then the rest, each in Hermes's own order. */
export function providerChoices(options: ModelOptionsResult | null | undefined, signIns: readonly SignInProvider[], keys: KeyCatalog, endpoints: EndpointKeys = {}, context?: ProviderContext): ProviderChoice[] {
  const bySlug = new Map(signIns.map(provider => [provider.id, provider]))
  const rank = (choice: ProviderChoice) => (choice.current ? 0 : choice.ready ? 1 : 2)

  return (
    (options?.providers ?? [])
      // Mixture of Agents routes through other providers rather than being one to set up.
      .filter(row => row.slug !== 'moa' || row.is_current)
      .map(row => choiceFor(row, bySlug.get(row.slug), keys, endpoints, context))
      .sort((a, b) => rank(a) - rank(b))
  )
}

function choiceFor(row: ModelOptionProvider, signIn: SignInProvider | undefined, keys: KeyCatalog, endpoints: EndpointKeys, context?: ProviderContext): ProviderChoice {
  const models = [...new Set((row.models ?? []).filter(model => typeof model === 'string' && model.trim() !== ''))]
  const endpointKey = row.is_user_defined ? (endpoints[endpointId(row.slug)] ?? null) : null
  // `model.options` names the key only for providers in Hermes's registry, which OpenRouter is not.
  const keyEnv = endpointKey || row.key_env || (Object.entries(keys).find(([, entry]) => entry.provider === row.slug && entry.is_password)?.[0] ?? null)
  const local = localProvider(row, context)
  const setup = local && !endpointKey ? 'local' : setupFor(row, signIn, keyEnv)
  // Local selection requires positive key evidence. Keep the existing remote-provider
  // fallback to native authentication while metadata loads; keyless endpoints are unaffected.
  const keyUnsaved = endpointKey !== null && (Boolean(local) || Object.keys(keys).length > 0) && keys[endpointKey]?.is_set !== true
  const configured = row.authenticated !== false && !(signIn?.flow === 'device_code' && !signIn.loggedIn) && !keyUnsaved
  const localState = !local ? undefined : local === 'hermes' && context?.localRuntimeEnabled === false ? 'disabled' : !context?.configKnown || (local === 'hermes' && context.localRuntimeEnabled !== true) ? 'unknown' : row.authenticated === true && models.length > 0 && !keyUnsaved ? 'catalogued' : 'unavailable'

  return {
    slug: row.slug,
    name: row.name || row.slug,
    current: Boolean(row.is_current),
    // The inventory counts a stored login that has lapsed; the sign-in list knows it is signed out.
    ready: configured && (!local || (row.authenticated === true && models.length > 0 && localState === 'catalogued')),
    local,
    localState,
    setup,
    keyEnv: setup === 'key' ? keyEnv : null,
    helpUrl: setup === 'key' ? (keyEnv ? (keys[keyEnv]?.url ?? null) : null) : (signIn?.docsUrl ?? null),
    command: setup === 'terminal' ? (signIn?.cliCommand ?? 'hermes model') : null,
    models
  }
}

function setupFor(row: ModelOptionProvider, signIn: SignInProvider | undefined, keyEnv: string | null): ProviderSetup {
  if (signIn?.flow === 'device_code') {
    return 'sign-in'
  }

  // Rows that are set up carry no auth type; a key the catalog knows for them means an API key.
  if (keyEnv && (!row.auth_type || row.auth_type === 'api_key')) {
    return 'key'
  }

  return row.is_user_defined ? 'endpoint' : 'terminal'
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** An endpoint's id as Hermes matches it: `custom:Lab GPU` and `lab-gpu` are the same endpoint. */
const endpointId = (value: string) => value.trim().toLowerCase().replace(/ /g, '-').replace(/^custom:/, '')

/** A `custom_providers` name up to the separator Hermes puts before a model ("Lab GPU — llama3"). */
const namePrefix = (name: string) => ['—', ' - '].map(separator => name.split(separator)).find(parts => parts.length > 1)?.[0].trim() ?? name

/** The variable a config entry keeps its key in, read as Hermes reads it; never the key itself. */
function keyVariable(entry: Record<string, unknown>): string | null {
  const named = [entry.key_env, entry.api_key_env].find((value): value is string => typeof value === 'string' && value.trim() !== '')
  const reference = typeof entry.api_key === 'string' ? /^\$\{(\w+)\}$/.exec(entry.api_key.trim())?.[1] : undefined

  return named?.trim() ?? reference ?? null
}

/**
 * The variables the custom endpoints in Hermes's raw config (`GET /api/config?include_defaults=false`)
 * keep their API keys in: `key_env`, else `api_key_env`, else an `api_key` of just `${VAR}`. A key
 * written into config.yaml itself is never kept.
 */
export function endpointKeys(config: { providers?: unknown; custom_providers?: unknown } | null | undefined): EndpointKeys {
  const found: EndpointKeys = {}
  const add = (id: string, entry: unknown) => {
    const variable = isRecord(entry) ? keyVariable(entry) : null

    if (id && variable && !(id in found)) {
      found[id] = variable
    }
  }
  const providers = config?.providers
  const legacy = config?.custom_providers

  // Hermes finds an endpoint under `providers:` before the older list.
  for (const [id, entry] of Object.entries(isRecord(providers) ? providers : {})) {
    add(endpointId(id), entry)
  }

  for (const entry of Array.isArray(legacy) ? legacy : []) {
    if (isRecord(entry)) {
      add(endpointId(String(entry.provider_key || namePrefix(String(entry.name ?? '')))), entry)
    }
  }

  return found
}

/** A bare `/model`'s answer from `model.options` for the session: its model, and its provider by name. */
export function currentModelText(options: ModelOptionsResult | null | undefined): string | null {
  if (!options?.model) {
    return null
  }

  const id = options.provider ?? ''
  const provider = id && (options.providers.find(row => row.slug === id || row.aliases?.includes(id))?.name ?? id)

  return `Current model: ${options.model}${provider ? ` (${provider})` : ''}`
}

/** The model a switch to `row` lands on: the saved one when the provider stays, else Hermes's recommendation, else its first. */
export function pickModel(row: Pick<ModelOptionProvider, 'is_current' | 'models'> | undefined, savedModel: string | null | undefined, recommended: string | null | undefined): string | null {
  if (row?.is_current && savedModel) {
    return savedModel
  }

  return recommended?.trim() || row?.models?.find(Boolean) || null
}

export type PreferredModelStatus = 'no-provider' | 'unknown-provider' | 'ambiguous-provider' | 'unauthenticated' | 'empty' | 'no-match' | 'ready'

/** The models the Preferred model picker offers, and why it offers none when it does not. */
export interface PreferredModels {
  status: PreferredModelStatus
  /** The provider Hermes reports as current, by the id it gives (an alias such as `custom:<name>` for a custom endpoint). */
  providerId: string | null
  /** The slug of the row that id names: the provider a choice from `models` is sent with. */
  slug: string | null
  name: string | null
  /** That provider's models matching the filter, in Hermes's order; empty unless the status is `ready`. */
  models: string[]
  /** How many models Hermes lists for that provider, the filter aside. */
  catalogSize: number
  filtered: boolean
  /** The model Hermes reports as current. */
  current: string | null
  /** The current model is one of that provider's own. */
  currentListed: boolean
}

/**
 * The models the Preferred model picker offers: only those of the provider Hermes reports as current
 * (`options.provider`), found by its slug and then its aliases. Neither a row's `is_current` flag nor
 * a model's name decides which provider a model belongs to, and no other provider is ever the
 * fallback: an unknown, ambiguous or signed-out provider offers nothing. Changing provider is the
 * Model provider row's job.
 */
export function preferredModelOptions(options: ModelOptionsResult | null | undefined, filter = ''): PreferredModels {
  const providerId = options?.provider?.trim() || null
  const current = options?.model?.trim() || null
  const query = filter.trim().toLowerCase()
  const result = (status: PreferredModelStatus, row?: ModelOptionProvider, catalog: string[] = [], models: string[] = []): PreferredModels => ({
    status,
    providerId,
    slug: row?.slug ?? null,
    name: row ? row.name || row.slug : null,
    models,
    catalogSize: Math.max(catalog.length, row?.total_models ?? 0),
    filtered: query !== '',
    current,
    currentListed: current !== null && catalog.includes(current)
  })

  if (!providerId) {
    return result('no-provider')
  }

  const rows = options?.providers ?? []
  const named = rows.filter(row => row.slug === providerId)
  const matches = named.length > 0 ? named : rows.filter(row => row.aliases?.includes(providerId))

  if (matches.length === 0) {
    return result('unknown-provider')
  }

  if (matches.length > 1) {
    return result('ambiguous-provider')
  }

  const row = matches[0]

  if (row.authenticated === false) {
    return result('unauthenticated', row)
  }

  const catalog = [...new Set((row.models ?? []).filter(model => typeof model === 'string' && model.trim() !== ''))]
  const models = query ? catalog.filter(model => model.toLowerCase().includes(query)) : catalog

  return result(catalog.length === 0 ? 'empty' : models.length === 0 ? 'no-match' : 'ready', row, catalog, models)
}

/** What became of the chat that was open when a model was chosen. */
export type ChatSwitch = { status: 'none' } | { status: 'switched' | 'queued' | 'failed'; sessionId: string }

/** Who a saved model change reaches, as the person should be told. */
export type ModelChangeScope = 'chat-and-new' | 'new-only' | 'earlier-chat-and-new' | 'chat-failed' | 'chat-queued'

/** `openSessionId` is the chat open now, which may no longer be the one the model was chosen in. */
export function modelChangeScope(session: ChatSwitch, openSessionId: string | null | undefined): ModelChangeScope {
  if (session.status === 'none') {
    return 'new-only'
  }

  if (session.status === 'failed') {
    return 'chat-failed'
  }

  if (session.status === 'queued') return 'chat-queued'

  return session.sessionId === openSessionId ? 'chat-and-new' : 'earlier-chat-and-new'
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * The provider a typed or spoken name means: an exact id or name, else the one name that starts
 * with it, the one id that does, or the one name containing it. More than one is ambiguous.
 */
export function matchProvider(choices: readonly ProviderChoice[], query: string): { choice: ProviderChoice | null; candidates: ProviderChoice[] } {
  const needle = squash(query)

  if (!needle) {
    return { choice: null, candidates: [] }
  }

  const tests: ((choice: ProviderChoice) => boolean)[] = [
    choice => squash(choice.slug) === needle || squash(choice.name) === needle,
    choice => squash(choice.name).startsWith(needle),
    choice => squash(choice.slug).startsWith(needle),
    choice => squash(choice.name).includes(needle)
  ]

  for (const test of tests) {
    const found = choices.filter(test)

    if (found.length > 0) {
      return { choice: found.length === 1 ? found[0] : null, candidates: found }
    }
  }

  return { choice: null, candidates: [] }
}
