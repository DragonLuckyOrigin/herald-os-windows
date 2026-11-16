import { t as uiT } from './i18n.ts'
import { atom } from 'nanostores'
import type { CatalogEntryView, CatalogGroupView } from '../../shared/ipc.ts'
import { localProvider } from '../lib/model-provider.ts'
import { $activeChat } from './chat.ts'
import { loadModelOptions, loadProviderConfig, LocalModelUnavailable, type ModelChange, ModelChangeIncomplete, selectLocalModel } from './model-provider.ts'
import { notify } from './notifications.ts'

/*
 * The install catalog (linux/catalog/*.json): on Herald OS Linux everything in it, on macOS the
 * coding agents and local model apps that install there. Main does the installing; this keeps the
 * listing and which entries are busy.
 */

export interface CatalogState {
  groups: CatalogGroupView[]
  loaded: boolean
  error: string | null
  /** Entries being installed or removed right now. */
  busy: Record<string, 'install' | 'remove'>
}

export const $catalog = atom<CatalogState>({ groups: [], loaded: false, error: null, busy: {} })

let loading: Promise<void> | null = null

export function loadCatalog(): Promise<void> {
  loading ??= window.heraldOS.catalog
    .list()
    .then(groups => $catalog.set({ ...$catalog.get(), groups, loaded: true, error: null }))
    .catch((error: unknown) => $catalog.set({ ...$catalog.get(), loaded: true, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => {
      loading = null
    })

  return loading
}

export function catalogEntries(): CatalogEntryView[] {
  return $catalog.get().groups.flatMap(group => group.entries)
}

export function findCatalogEntry(query: string): CatalogEntryView | null {
  const needle = query.trim().toLowerCase()
  const entries = catalogEntries()

  return entries.find(entry => entry.id === needle) ?? entries.find(entry => entry.label.toLowerCase() === needle) ?? entries.find(entry => entry.label.toLowerCase().includes(needle)) ?? null
}

function setBusy(id: string, action: 'install' | 'remove' | null): void {
  const busy = { ...$catalog.get().busy }

  if (action) {
    busy[id] = action
  } else {
    delete busy[id]
  }

  $catalog.set({ ...$catalog.get(), busy })
}

/** Install or remove one entry; resolves with whether it worked (the toast says what happened). */
export async function runCatalog(id: string, action: 'install' | 'remove'): Promise<boolean> {
  const entry = catalogEntries().find(item => item.id === id)
  const label = entry?.label ?? id
  setBusy(id, action)

  try {
    const result = await (action === 'install' ? window.heraldOS.catalog.install(id) : window.heraldOS.catalog.remove(id))

    if (result.ok) {
      const opened = entry?.method === 'link' && action === 'install'
      notify({ title: opened ? `${label}: download page open` : `${label} ${action === 'install' ? 'installed' : 'removed'}`, body: opened ? 'Install it from there; Herald OS sees it when it is done.' : result.output.split('\n').pop() || undefined, level: 'success' })
    } else {
      notify({ title: uiT("ui.e21ee1a8f98b", { value1: String(action), value2: String(label) }), body: result.output || undefined, level: 'error' })
    }

    return result.ok
  } catch (error) {
    notify({ title: uiT("ui.e21ee1a8f98b", { value1: String(action), value2: String(label) }), body: error instanceof Error ? error.message : String(error), level: 'error' })

    return false
  } finally {
    setBusy(id, null)
    await loadCatalog()
  }
}

/** Point Hermes at a model on Ollama or LM Studio: the default for new conversations, and the current one. */
export async function useWithHermes(kind: 'ollama' | 'lmstudio', model: string, reportOutcome = false): Promise<ModelChange> {
  const sessionId = $activeChat.get()?.sessionId ?? null
  const [options, config] = await Promise.all([loadModelOptions(), loadProviderConfig()])
  const matches = options.providers.filter(row => localProvider(row, config.context) === kind && row.models?.includes(model))
  // A software inventory is not a Hermes registration. Ambiguity never chooses a provider silently.
  if (matches.length !== 1 || matches[0].authenticated !== true) throw new LocalModelUnavailable('not-offered')
  const change = await selectLocalModel(matches[0].slug, model, false, sessionId, kind)
  // Existing command consumers ignore return values. Never let those report success on a
  // warning/partial switch. Settings opts in to displaying the full native outcome.
  if (!reportOutcome) {
    if (!change.ok) throw new Error(uiT('settings.provider.changeUnconfirmed'))
    if (change.session.status === 'failed' || change.session.status === 'queued') {
      const state = change.session.status
      throw new ModelChangeIncomplete(state === 'failed' ? 'chat-failed' : 'chat-queued', uiT(state === 'failed' ? 'settings.provider.partial.failed' : 'settings.provider.partial.queued'))
    }
  }
  return change
}
