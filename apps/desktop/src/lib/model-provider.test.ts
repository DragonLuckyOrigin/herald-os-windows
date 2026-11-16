import type { ModelOptionsResult } from '@herald-os/client'
import { describe, expect, it } from 'vitest'
import { currentModelText, endpointKeys, providerContext, type KeyCatalog, matchProvider, modelChangeScope, pickModel, preferredModelOptions, providerChoices, type SignInProvider } from './model-provider.ts'

// Rows as hermes_cli/inventory.py builds them for `model.options` with the unconfigured ones: a
// provider that is set up carries no auth hints, a skeleton carries its auth type and key variable.
const OPTIONS: ModelOptionsResult = {
  model: 'hermes-4-405b',
  provider: 'nous',
  providers: [
    { slug: 'nous', name: 'Nous Portal', is_current: true, authenticated: true, models: ['hermes-4-405b', 'hermes-4-70b'] },
    { slug: 'openrouter', name: 'OpenRouter', is_current: false, authenticated: false, auth_type: 'api_key', key_env: '', models: [], source: 'canonical' },
    { slug: 'moa', name: 'Mixture of Agents', is_current: false, authenticated: true, auth_type: 'virtual', models: ['default'] },
    { slug: 'lmstudio', name: 'LM Studio', is_current: false, authenticated: false, auth_type: 'api_key', key_env: 'LM_API_KEY', models: [] },
    { slug: 'anthropic', name: 'Anthropic', is_current: false, authenticated: false, auth_type: 'api_key', key_env: 'ANTHROPIC_API_KEY', models: [] },
    { slug: 'openai-codex', name: 'ChatGPT or Codex Subscription', is_current: false, authenticated: false, auth_type: 'oauth_external', key_env: '', models: [] },
    { slug: 'openai-api', name: 'OpenAI API', is_current: false, authenticated: false, auth_type: 'api_key', key_env: 'OPENAI_API_KEY', models: [] },
    { slug: 'copilot-acp', name: 'GitHub Copilot ACP', is_current: false, authenticated: false, auth_type: 'external_process', key_env: '', models: [] },
    { slug: 'deepseek', name: 'DeepSeek', is_current: false, authenticated: true, models: ['deepseek-chat', 'deepseek-reasoner'] },
    { slug: 'bedrock', name: 'AWS Bedrock', is_current: false, authenticated: false, auth_type: 'aws_sdk', key_env: '', models: [] }
  ]
}

const SIGN_INS: SignInProvider[] = [
  { id: 'nous', flow: 'device_code', cliCommand: 'hermes auth add nous', docsUrl: 'https://portal.nousresearch.com', loggedIn: true },
  { id: 'openai-codex', flow: 'device_code', cliCommand: 'hermes auth add openai-codex', docsUrl: 'https://platform.openai.com/docs', loggedIn: false },
  { id: 'copilot-acp', flow: 'external', cliCommand: 'copilot login', docsUrl: 'https://docs.github.com/en/copilot', loggedIn: false },
  { id: 'anthropic', flow: 'external', cliCommand: 'hermes auth add anthropic', docsUrl: 'https://docs.claude.com/en/api/getting-started', loggedIn: false }
]

const KEYS: KeyCatalog = {
  OPENROUTER_API_KEY: { provider: 'openrouter', is_password: true, url: 'https://openrouter.ai/keys' },
  DEEPSEEK_BASE_URL: { provider: 'deepseek', is_password: false, url: null },
  DEEPSEEK_API_KEY: { provider: 'deepseek', is_password: true, url: 'https://platform.deepseek.com/api_keys' },
  TAVILY_API_KEY: { is_password: true, url: 'https://app.tavily.com' }
}

const choices = providerChoices(OPTIONS, SIGN_INS, KEYS)
const choice = (slug: string) => choices.find(item => item.slug === slug)

describe('local provider evidence', () => {
  const options: ModelOptionsResult = { provider: 'llamacpp', model: 'imported.gguf', providers: [
    { slug: 'llamacpp', name: 'Local', authenticated: true, models: ['imported.gguf'], is_current: true },
    { slug: 'home', name: 'My endpoint', is_user_defined: true, authenticated: true, models: ['hosted:latest'] },
    { slug: 'remote', name: 'Ollama Local', is_user_defined: true, authenticated: true, models: ['hosted:latest'] }
  ] }
  it('separates imported files from runtime readiness and ignores misleading names', () => {
    const context = providerContext({ local_runtime: { enabled: false }, providers: {
      home: { base_url: 'http://127.0.0.1:11434/v1', api_key: 'private-test-key' },
      remote: { base_url: 'https://remote.example/v1' }
    } })
    const result = providerChoices(options, [], {}, {}, context)
    expect(result.find(row => row.slug === 'llamacpp')).toMatchObject({ local: 'hermes', localState: 'disabled', ready: false })
    expect(result.find(row => row.slug === 'home')).toMatchObject({ local: 'ollama', localState: 'catalogued', ready: true })
    expect(result.find(row => row.slug === 'remote')?.local).toBeUndefined()
    expect(JSON.stringify(context)).not.toContain('private-test-key')
    expect(JSON.stringify(context)).not.toContain('base_url')
  })
  it('keeps absent runtime evidence unknown, even with an authenticated catalog', () => {
    expect(providerChoices(options, [], {})[0]).toMatchObject({ local: 'hermes', localState: 'unknown', ready: false })
  })
  it('keeps the existing key setup available for authenticated local endpoints with a missing key', () => {
    const context = providerContext({ providers: { home: { base_url: 'http://127.0.0.1:11434/v1' } } })
    expect(providerChoices(options, [], { LOCAL_KEY: { is_password: true, is_set: false } }, { home: 'LOCAL_KEY' }, context).find(row => row.slug === 'home')).toMatchObject({ local: 'ollama', ready: false, setup: 'key', keyEnv: 'LOCAL_KEY' })
  })
  it.each(['http://localhost.evil.test:11434/v1', 'https://127.0.0.1.evil.test:11434/v1', 'file:///private', 'http://user:secret@localhost:11434/v1'])('does not classify an untrusted endpoint as local: %s', base_url => {
    const context = providerContext({ providers: { remote: { base_url } } })
    expect(providerChoices(options, [], {}, {}, context).find(row => row.slug === 'remote')?.local).toBeUndefined()
  })
  it('uses the native providers map before legacy entries, including a remote override', () => {
    const context = providerContext({ providers: { home: { base_url: 'https://remote.example/v1' } }, custom_providers: [
      { provider_key: 'home', base_url: 'http://localhost:11434/v1' },
      { provider_key: 'remote', base_url: 'http://[::1]:1234/v1' }
    ] })
    expect(providerChoices(options, [], {}, {}, context).find(row => row.slug === 'home')?.local).toBeUndefined()
    expect(providerChoices(options, [], {}, {}, context).find(row => row.slug === 'remote')?.local).toBe('lmstudio')
  })
  it('does not describe a remotely configured native endpoint as running on this computer', () => {
    const context = providerContext({ providers: { lmstudio: { base_url: 'https://remote.example/v1' } } })
    const result = providerChoices({ providers: [{ slug: 'lmstudio', name: 'LM Studio', authenticated: true, models: ['remote-model'] }] }, [], {}, {}, context)[0]
    expect(result.local).toBeUndefined()
    expect(result.setup).not.toBe('local')
  })
})

describe('providerChoices', () => {
  it('lists the current provider, then those set up, then the rest, in Hermes order', () => {
    expect(choices.map(item => item.slug)).toEqual(['nous', 'deepseek', 'openrouter', 'lmstudio', 'anthropic', 'openai-codex', 'openai-api', 'copilot-acp', 'bedrock'])
    expect(choice('nous')).toMatchObject({ current: true, ready: true, setup: 'sign-in', models: ['hermes-4-405b', 'hermes-4-70b'] })
  })

  it('leaves Mixture of Agents out unless Hermes routes through it', () => {
    const moa = { ...OPTIONS, providers: OPTIONS.providers.map(row => ({ ...row, is_current: row.slug === 'moa' })) }

    expect(providerChoices(moa, SIGN_INS, KEYS)[0]).toMatchObject({ slug: 'moa', current: true })
  })

  it('asks for the key Hermes names, and finds the one it does not name (OpenRouter) in the key catalog', () => {
    expect(choice('openrouter')).toMatchObject({ ready: false, setup: 'key', keyEnv: 'OPENROUTER_API_KEY', helpUrl: 'https://openrouter.ai/keys' })
    expect(choice('openai-api')).toMatchObject({ ready: false, setup: 'key', keyEnv: 'OPENAI_API_KEY', helpUrl: null })
    // Anthropic also has a terminal sign-in, but a pasted key is the way in from here.
    expect(choice('anthropic')).toMatchObject({ setup: 'key', keyEnv: 'ANTHROPIC_API_KEY', command: null })
    // A provider set up with a key offers it for replacing; the base URL is no key.
    expect(choice('deepseek')).toMatchObject({ ready: true, setup: 'key', keyEnv: 'DEEPSEEK_API_KEY', helpUrl: 'https://platform.deepseek.com/api_keys' })
  })

  it('signs in on the card where Hermes has a code flow, and is not ready while signed out', () => {
    expect(choice('openai-codex')).toMatchObject({ ready: false, setup: 'sign-in', keyEnv: null, command: null, helpUrl: 'https://platform.openai.com/docs' })

    // The inventory still counts a lapsed Nous login; the sign-in list knows better.
    const signedOut = providerChoices(OPTIONS, SIGN_INS.map(provider => (provider.id === 'nous' ? { ...provider, loggedIn: false } : provider)), KEYS)

    expect(signedOut[0]).toMatchObject({ slug: 'nous', current: true, ready: false, setup: 'sign-in' })
  })

  it('sends the rest to a terminal, or to this computer', () => {
    expect(choice('copilot-acp')).toMatchObject({ ready: false, setup: 'terminal', command: 'copilot login', helpUrl: 'https://docs.github.com/en/copilot' })
    expect(choice('bedrock')).toMatchObject({ ready: false, setup: 'terminal', command: 'hermes model', keyEnv: null })
    expect(choice('lmstudio')).toMatchObject({ ready: false, setup: 'local', keyEnv: null, command: null })
  })

  it('has nothing to offer before the inventory is read', () => {
    expect(providerChoices(null, SIGN_INS, KEYS)).toEqual([])
  })
})

// Custom endpoints as config.yaml sets them up: Hermes Desktop writes `providers:` entries whose key
// is in .env under `key_env`; `hermes model` wrote the older `custom_providers:` list.
const CONFIG = {
  model: 'qwen3-30b-a3b',
  providers: {
    'qwen-flash': { name: 'qwen-flash', base_url: 'http://192.168.1.20:8000/v1', model: 'qwen3-30b-a3b', key_env: 'HERMES_CUSTOM_QWEN_FLASH_API_KEY' },
    vllm: { base_url: 'http://192.168.1.21:8000/v1', api_key_env: 'VLLM_KEY' },
    gateway: { base_url: 'https://llm.example.com/v1', api_key: '${GATEWAY_KEY}' },
    inline: { base_url: 'https://other.example.com/v1', api_key: 'sk-written-into-config' },
    ollama: { base_url: 'http://127.0.0.1:11434/v1' }
  },
  custom_providers: [
    { name: 'Lab GPU — llama3', base_url: 'http://10.0.0.5:8080/v1', model: 'llama3', key_env: 'HERMES_CUSTOM_10_0_0_5_8080_API_KEY' },
    { name: 'qwen-flash', base_url: 'http://192.168.1.99:8000/v1', key_env: 'SHADOWED' }
  ]
}

const ENDPOINT_ROWS: ModelOptionsResult = {
  model: 'qwen3-30b-a3b',
  provider: 'custom:qwen-flash',
  providers: [
    { slug: 'qwen-flash', name: 'qwen-flash', is_current: true, is_user_defined: true, authenticated: true, models: ['qwen3-30b-a3b'], source: 'user-config', api_url: 'http://192.168.1.20:8000/v1', aliases: ['custom:qwen-flash', 'qwen-flash'] },
    { slug: 'vllm', name: 'vllm', is_current: false, is_user_defined: true, authenticated: true, models: ['mistral-small'], source: 'user-config' },
    { slug: 'custom:lab-gpu', name: 'Lab GPU', is_current: false, is_user_defined: true, authenticated: true, models: ['llama3'], source: 'user-config' },
    { slug: 'ollama', name: 'ollama', is_current: false, is_user_defined: true, authenticated: true, models: ['gemma3'], source: 'user-config' }
  ]
}

describe('endpointKeys', () => {
  it('reads the variable each endpoint keeps its key in, the way Hermes does', () => {
    // The older list's qwen-flash loses to the `providers:` one, as it does in Hermes.
    expect(endpointKeys(CONFIG)).toEqual({
      'qwen-flash': 'HERMES_CUSTOM_QWEN_FLASH_API_KEY',
      vllm: 'VLLM_KEY',
      gateway: 'GATEWAY_KEY',
      'lab-gpu': 'HERMES_CUSTOM_10_0_0_5_8080_API_KEY'
    })
  })

  it('never keeps a key written into config.yaml', () => {
    expect(JSON.stringify(endpointKeys(CONFIG))).not.toContain('sk-written-into-config')
  })

  it('has nothing for a config without endpoints', () => {
    expect(endpointKeys(null)).toEqual({})
    expect(endpointKeys({ providers: 'broken', custom_providers: {} })).toEqual({})
  })
})

describe('providerChoices for custom endpoints', () => {
  const keys: KeyCatalog = { HERMES_CUSTOM_QWEN_FLASH_API_KEY: { is_password: true, is_set: true }, OPENROUTER_API_KEY: { provider: 'openrouter', is_password: true, is_set: false } }
  const endpoints = endpointKeys(CONFIG)
  const custom = (slug: string, catalog = keys) => providerChoices(ENDPOINT_ROWS, [], catalog, endpoints).find(item => item.slug === slug)

  it('takes and replaces the key in the variable the endpoint names', () => {
    expect(custom('qwen-flash')).toMatchObject({ current: true, ready: true, setup: 'key', keyEnv: 'HERMES_CUSTOM_QWEN_FLASH_API_KEY', helpUrl: null, command: null })
    expect(custom('custom:lab-gpu')).toMatchObject({ setup: 'key', keyEnv: 'HERMES_CUSTOM_10_0_0_5_8080_API_KEY' })
  })

  it("is not ready while that variable is not in Hermes's .env", () => {
    expect(custom('vllm')).toMatchObject({ ready: false, setup: 'key', keyEnv: 'VLLM_KEY' })
    // Remote endpoints retain the existing native-auth fallback while metadata loads.
    expect(custom('vllm', {})).toMatchObject({ ready: true, setup: 'key' })
  })

  it('leaves an endpoint that names no key as Hermes has it', () => {
    expect(custom('ollama')).toMatchObject({ ready: true, setup: 'endpoint', keyEnv: null, command: null })
  })
})

describe('currentModelText', () => {
  it('names the model and its provider, a custom endpoint by its name rather than custom:<name>', () => {
    expect(currentModelText(OPTIONS)).toBe('Current model: hermes-4-405b (Nous Portal)')
    expect(currentModelText(ENDPOINT_ROWS)).toBe('Current model: qwen3-30b-a3b (qwen-flash)')
    expect(currentModelText({ model: 'llama3', provider: 'custom', providers: [] })).toBe('Current model: llama3 (custom)')
  })

  it('leaves the answer to Hermes when it names no model', () => {
    expect(currentModelText({ model: '', provider: 'nous', providers: [] })).toBeNull()
    expect(currentModelText(null)).toBeNull()
  })
})

describe('pickModel', () => {
  it('keeps the saved model while the provider stays', () => {
    expect(pickModel({ is_current: true, models: ['hermes-4-70b'] }, 'hermes-4-405b', 'hermes-4-70b')).toBe('hermes-4-405b')
  })

  it("takes Hermes's recommendation for another provider, else its first model", () => {
    expect(pickModel({ is_current: false, models: ['anthropic/claude-opus-4.6', 'deepseek/deepseek-chat'] }, 'hermes-4-405b', 'deepseek/deepseek-chat')).toBe('deepseek/deepseek-chat')
    expect(pickModel({ is_current: false, models: ['deepseek-chat'] }, 'hermes-4-405b', '  ')).toBe('deepseek-chat')
    expect(pickModel({ is_current: false, models: [] }, 'hermes-4-405b', null)).toBeNull()
    expect(pickModel(undefined, '', null)).toBeNull()
  })
})

// The picker's inventory as the observed confusion has it: the ChatGPT subscription is the provider
// Hermes uses, yet another row carries the `is_current` flag and a model named like OpenAI's.
const SUBSCRIPTION: ModelOptionsResult = {
  model: 'gpt-5.1-codex',
  provider: 'openai-codex',
  providers: [
    { slug: 'nous', name: 'Nous Portal', is_current: true, authenticated: true, models: ['hermes-4-405b'] },
    { slug: 'openrouter', name: 'OpenRouter', is_current: false, authenticated: true, models: ['openai/gpt-5.1-codex', 'anthropic/claude-opus-4.6'] },
    { slug: 'openai-codex', name: 'ChatGPT or Codex Subscription', is_current: false, authenticated: true, models: ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'GPT-5-Pro'] }
  ]
}

describe('preferredModelOptions', () => {
  it("offers only the reported provider's catalog, whatever is_current says and however other models are named", () => {
    const view = preferredModelOptions(SUBSCRIPTION)

    expect(view).toMatchObject({ status: 'ready', providerId: 'openai-codex', slug: 'openai-codex', name: 'ChatGPT or Codex Subscription', models: ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'GPT-5-Pro'], current: 'gpt-5.1-codex', currentListed: true })
    expect(view.models).not.toContain('openai/gpt-5.1-codex')
    expect(view.models).not.toContain('hermes-4-405b')
  })

  it('never derives the provider from the current model or a row flag', () => {
    // Two rows say they are current, the reported provider is a third; a model prefix names a fourth.
    const view = preferredModelOptions({ ...SUBSCRIPTION, model: 'openai/gpt-5.1-codex', provider: 'nous', providers: SUBSCRIPTION.providers.map(row => ({ ...row, is_current: row.slug !== 'nous' })) })

    expect(view).toMatchObject({ status: 'ready', slug: 'nous', models: ['hermes-4-405b'], currentListed: false })
  })

  it("finds a custom endpoint by the alias Hermes reports and sends the row's own slug", () => {
    const view = preferredModelOptions(ENDPOINT_ROWS)

    expect(view).toMatchObject({ status: 'ready', providerId: 'custom:qwen-flash', slug: 'qwen-flash', name: 'qwen-flash', models: ['qwen3-30b-a3b'] })
  })

  it('prefers a row of exactly that slug over another row that merely lists it as an alias', () => {
    const rows = [
      { slug: 'other', name: 'Other', is_current: false, authenticated: true, models: ['other-model'], aliases: ['shared'] },
      { slug: 'shared', name: 'Shared', is_current: false, authenticated: true, models: ['shared-model'] }
    ]

    expect(preferredModelOptions({ model: 'shared-model', provider: 'shared', providers: rows })).toMatchObject({ status: 'ready', slug: 'shared', models: ['shared-model'] })
  })

  it('offers nothing, and picks no provider, when none or more than one fits', () => {
    expect(preferredModelOptions({ model: 'm', provider: '', providers: SUBSCRIPTION.providers })).toMatchObject({ status: 'no-provider', slug: null, models: [] })
    expect(preferredModelOptions({ model: 'm', provider: '  ', providers: SUBSCRIPTION.providers }).status).toBe('no-provider')
    expect(preferredModelOptions({ ...SUBSCRIPTION, provider: 'anthropic' })).toMatchObject({ status: 'unknown-provider', providerId: 'anthropic', slug: null, models: [] })
    expect(preferredModelOptions(null)).toMatchObject({ status: 'no-provider', models: [] })

    const twice = [
      { slug: 'a', name: 'A', is_current: false, authenticated: true, models: ['a-model'], aliases: ['both'] },
      { slug: 'b', name: 'B', is_current: false, authenticated: true, models: ['b-model'], aliases: ['both'] }
    ]

    expect(preferredModelOptions({ model: 'a-model', provider: 'both', providers: twice })).toMatchObject({ status: 'ambiguous-provider', slug: null, models: [] })
  })

  it('offers no models of a provider that is not signed in or set up', () => {
    const rows = [{ slug: 'openai-codex', name: 'ChatGPT or Codex Subscription', is_current: true, authenticated: false, models: ['gpt-5.1-codex'] }]

    expect(preferredModelOptions({ model: 'gpt-5.1-codex', provider: 'openai-codex', providers: rows })).toMatchObject({ status: 'unauthenticated', slug: 'openai-codex', name: 'ChatGPT or Codex Subscription', models: [] })
  })

  it('tells an empty catalog from a filter that matches nothing, and ignores blank and repeated entries', () => {
    const rows = [{ slug: 'openai-codex', name: 'ChatGPT or Codex Subscription', is_current: true, authenticated: true, models: ['', '  '] }]

    expect(preferredModelOptions({ model: 'x', provider: 'openai-codex', providers: rows })).toMatchObject({ status: 'empty', models: [], catalogSize: 0 })
    expect(preferredModelOptions(SUBSCRIPTION, 'zzz')).toMatchObject({ status: 'no-match', models: [], filtered: true, catalogSize: 3 })
    expect(preferredModelOptions({ ...SUBSCRIPTION, providers: [{ ...SUBSCRIPTION.providers[2], models: ['a', 'a', 'b'] }] }).models).toEqual(['a', 'b'])
  })

  it("filters by the model's id, not case, and gives back the ids as Hermes spelled them", () => {
    expect(preferredModelOptions(SUBSCRIPTION, '  MINI ').models).toEqual(['gpt-5.1-codex-mini'])
    expect(preferredModelOptions(SUBSCRIPTION, 'gpt-5-pro').models).toEqual(['GPT-5-Pro'])
    // The provider's name is no search term, and another provider's models are never found.
    expect(preferredModelOptions(SUBSCRIPTION, 'subscription').status).toBe('no-match')
    expect(preferredModelOptions(SUBSCRIPTION, 'claude').status).toBe('no-match')
  })

  it("reports a current model the provider does not list as stale instead of adding it or switching provider", () => {
    const view = preferredModelOptions({ ...SUBSCRIPTION, model: 'hermes-4-405b' })

    expect(view).toMatchObject({ status: 'ready', slug: 'openai-codex', current: 'hermes-4-405b', currentListed: false })
    expect(view.models).not.toContain('hermes-4-405b')
  })

  it('counts a catalog Hermes lists more of than it sent', () => {
    const rows = [{ ...SUBSCRIPTION.providers[2], total_models: 120 }]

    expect(preferredModelOptions({ ...SUBSCRIPTION, providers: rows })).toMatchObject({ catalogSize: 120, models: ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'GPT-5-Pro'] })
  })
})

describe('modelChangeScope', () => {
  it('says who a saved change reaches, by what became of the chat that was open', () => {
    expect(modelChangeScope({ status: 'none' }, 's1')).toBe('new-only')
    expect(modelChangeScope({ status: 'switched', sessionId: 's1' }, 's1')).toBe('chat-and-new')
    expect(modelChangeScope({ status: 'switched', sessionId: 's1' }, 's2')).toBe('earlier-chat-and-new')
    expect(modelChangeScope({ status: 'switched', sessionId: 's1' }, null)).toBe('earlier-chat-and-new')
    expect(modelChangeScope({ status: 'failed', sessionId: 's1' }, 's1')).toBe('chat-failed')
    expect(modelChangeScope({ status: 'failed', sessionId: 's1' }, 's2')).toBe('chat-failed')
  })
})

describe('matchProvider', () => {
  it('finds a provider by its id or its name, however it is spelled', () => {
    expect(matchProvider(choices, 'openrouter').choice?.slug).toBe('openrouter')
    expect(matchProvider(choices, 'Open Router').choice?.slug).toBe('openrouter')
    expect(matchProvider(choices, 'nous').choice?.slug).toBe('nous')
    expect(matchProvider(choices, 'openai-codex').choice?.slug).toBe('openai-codex')
  })

  it('then takes the one name that starts with the words, before the one id that does', () => {
    expect(matchProvider(choices, 'OpenAI').choice?.slug).toBe('openai-api')
    expect(matchProvider(choices, 'ChatGPT').choice?.slug).toBe('openai-codex')
    expect(matchProvider(choices, 'copilot').choice?.slug).toBe('copilot-acp')
  })

  it('names the candidates when the words fit more than one, and nothing when they fit none', () => {
    expect(matchProvider(choices, 'a')).toMatchObject({ choice: null, candidates: [{ slug: 'anthropic' }, { slug: 'bedrock' }] })
    expect(matchProvider(choices, 'claude')).toEqual({ choice: null, candidates: [] })
    expect(matchProvider(choices, '  ')).toEqual({ choice: null, candidates: [] })
  })
})

it('does not enable native LM Studio selection before configuration is read', () => {
  const options = { providers: [{ slug: 'lmstudio', name: 'LM Studio', authenticated: true, models: ['m'] }] }
  expect(providerChoices(options, [], {}, {}, providerContext(null))[0]).toMatchObject({ localState: 'unknown', ready: false })
  expect(providerChoices(options, [], {}, {}, providerContext({}))[0]).toMatchObject({ localState: 'catalogued', ready: true })
})

it('requires positive key evidence for a custom endpoint and deduplicates exact models', () => {
  const options = { providers: [{ slug: 'lab', name: 'Lab', is_user_defined: true, authenticated: true, models: ['m', 'm', 'M', ''] }] }
  const context = providerContext({ providers: { lab: { base_url: 'http://localhost:11434/v1', key_env: 'LAB_KEY' } } })
  expect(providerChoices(options, [], {}, { lab: 'LAB_KEY' }, context)[0].ready).toBe(false)
  expect(providerChoices(options, [], { LAB_KEY: { is_set: false } }, { lab: 'LAB_KEY' }, context)[0].ready).toBe(false)
  expect(providerChoices(options, [], { LAB_KEY: { is_set: true } }, { lab: 'LAB_KEY' }, context)[0]).toMatchObject({ ready: true, models: ['m', 'M'] })
  expect(providerChoices(options, [], {}, {}, context)[0].ready).toBe(true)
})

it('does not classify blank-only native models as selectable', () => {
  const context = providerContext({ local_runtime: { enabled: true } })
  const options = { providers: [{ slug: 'llamacpp', name: 'Local', authenticated: true, models: ['', '  '] }] }
  expect(providerChoices(options, [], {}, {}, context)[0]).toMatchObject({ ready: false, localState: 'unavailable', models: [] })
})
