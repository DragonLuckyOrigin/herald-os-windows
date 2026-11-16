import type { TextKey } from '../../../../shared/i18n.ts'
import type { ModelOptionsResult } from '@herald-os/client'
import { useStore } from '@nanostores/react'
import { IconBolt, IconCloud, IconCpu, IconFileText, IconHistory, IconLock, IconMessage, IconScale, IconSearch, IconUsers } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import type { AuditEntry } from '../../../../shared/ipc.ts'
import { HermesAvatar } from '../../../components/app-icon.tsx'
import { Dropdown, GlassButton, GlassCard, LinkAction, Pill, type PillTone, StatusDot, Toggle } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { formatRelative } from '../../../lib/format.ts'
import { type PreferredModels, preferredModelOptions } from '../../../lib/model-provider.ts'
import { rest } from '../../../lib/rest.ts'
import { useBackendData, useLocalData } from '../../../lib/use-async.ts'
import { $activeChat } from '../../../store/chat.ts'
import { $connection, gatewayRequest } from '../../../store/gateway.ts'
import { $providerChanges, type ModelChange, selectPreferredModel } from '../../../store/model-provider.ts'
import { notify } from '../../../store/notifications.ts'
import { readTier, withTier } from './policy.ts'
import { ModelConfirm, modelChangeNotice, modelErrorText, ModelProviderRow } from './ProviderRow.tsx'
import { t, useT } from '../../../store/i18n.ts'
import { errorText, InlineNote, markSaved, MenuDropdown, RadioCard, SectionTitle, SettingsBlock, SettingsGroup, SettingsRow, Stepper, useDismiss } from './shared.tsx'
import { ToolSearchRow } from './ToolSearchRow.tsx'

/*
 * Hermes & agents: the default Settings section. Every control here binds to real Hermes state:
 *   approvals.mode (gateway config.get/set)            -> Autonomy cards
 *   model.options, /api/providers/oauth, /api/env      -> Model provider (ProviderRow.tsx)
 *   model.options + /api/model/set + config.set model  -> Preferred model
 *   /api/tools/terminal/backend(s)                     -> Run on
 *   delegation.max_concurrent_children (/api/config)   -> Background agents
 *   `memory` toolset (/api/tools/toolsets)             -> Remember preferences
 *   bridge policy tier `act`                           -> Ask before sending messages
 *   bridge audit log                                   -> Activity history
 */

export function AgentsSection() {
  const t = useT()
  const connection = useStore($connection)
  const ready = connection === 'open'

  return (
    <>
      <SectionTitle title={t('settings.section.agents')} subtitle={t('settings.agents.subtitle')} />

      <SettingsBlock label="Hermes" description={t("settings.detail.personalAgent.e35e1")} keywords="status identity ready connecting">
        <GlassCard className="flex items-center gap-3.5 px-4 py-3">
          <HermesAvatar size={44} rounded={11} />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-fg">Hermes</div>
            <div className="text-[12px] text-fg-3">{t("settings.detail.personalAgent.e35e1")}</div>
            <div className="mt-1 flex items-center gap-1.5 text-[12px] text-fg-2">
              <StatusDot tone={ready ? 'ok' : connection === 'error' || connection === 'closed' ? 'danger' : 'warn'} pulse={!ready} />
              {ready ? t('settings.common.ready') : connection === 'connecting' ? t('settings.common.connecting') : connection === 'error' ? t("settings.detail.connectionError.8d137") : connection === 'closed' ? t('settings.common.disconnected') : t("settings.detail.waitingForHermes.72318")}
            </div>
          </div>
        </GlassCard>
      </SettingsBlock>

      <AutonomyBlock ready={ready} />

      <SettingsGroup title={t("settings.detail.account.7e1b0")}>
        <ModelProviderRow />
      </SettingsGroup>

      <SettingsGroup title={t("settings.detail.modelPerformance.759a0")}>
        <PreferredModelRow ready={ready} />
        <RunOnRow />
        <BackgroundAgentsRow />
        <ToolSearchRow />
      </SettingsGroup>

      <SettingsGroup title={t("settings.detail.privacyControl.aa8eb")}>
        <RememberPreferencesRow />
        <AskBeforeSendingRow />
        <ActivityHistoryRow />
      </SettingsGroup>
    </>
  )
}

// ---- Autonomy ------------------------------------------------------------------------------

type ApprovalMode = 'manual' | 'smart' | 'off'

const AUTONOMY: { mode: ApprovalMode; label: TextKey; description: TextKey; icon: React.ReactNode }[] = [
  { mode: 'manual', label: "settings.detail.askFirst.4a9e8", description: "settings.detail.confirmEachAction.76e02", icon: <IconMessage /> },
  { mode: 'smart', label: "settings.detail.balanced.5386e", description: "settings.detail.workFreelyAskBeforeSharing.2718b", icon: <IconScale /> },
  { mode: 'off', label: "settings.detail.independent.6cbf0", description: "settings.detail.followYourSavedRules.141b2", icon: <IconBolt /> }
]

function normalizeMode(value: unknown): ApprovalMode | null {
  const raw = String(value ?? '').toLowerCase()

  return raw === 'manual' || raw === 'smart' || raw === 'off' ? raw : null
}

function AutonomyBlock({ ready }: { ready: boolean }) {
  useT()
  const setting = useBackendData(() => gatewayRequest('config.get', { key: 'approvals.mode' }), [], { enabled: ready })
  const [override, setOverride] = useState<{ base: unknown; mode: ApprovalMode } | null>(null)
  const [pendingOff, setPendingOff] = useState(false)
  const [busy, setBusy] = useState(false)
  const current = override && override.base === setting.data ? override.mode : normalizeMode(setting.data?.value)

  const apply = async (mode: ApprovalMode) => {
    setPendingOff(false)
    setOverride({ base: setting.data, mode })
    setBusy(true)

    try {
      await gatewayRequest('config.set', { key: 'approvals.mode', value: mode })
      markSaved()
      notify({ title: t("settings.detail.autonomyUpdated.fc79b"), body: t(AUTONOMY.find(item => item.mode === mode)!.label), level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: t("settings.detail.couldNotChangeAutonomy.f6e72"), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      setting.reload()
    }
  }

  const choose = (mode: ApprovalMode) => {
    if (mode === current) {
      setPendingOff(false)

      return
    }

    if (mode === 'off') {
      setPendingOff(true)

      return
    }

    void apply(mode)
  }

  return (
    <SettingsBlock title={t("settings.detail.autonomy.30edc")} label={t("settings.detail.autonomy.30edc")} description={t("settings.detail.askFirstBalancedIndependentHowMuchHermesChecks.8f9af")} keywords="approvals mode manual smart off yolo confirm">
      <div className="flex gap-3" aria-label={t("settings.detail.autonomy.30edc")}>
        {AUTONOMY.map(item => (
          <RadioCard key={item.mode} icon={item.icon} label={t(item.label)} description={t(item.description)} selected={pendingOff ? item.mode === 'off' : current === item.mode} onSelect={() => choose(item.mode)} disabled={!ready || busy} />
        ))}
      </div>
      {pendingOff && (
        <GlassCard className="flex items-center gap-3 px-3.5 py-2.5">
          <InlineNote tone="warn" className="flex-1">
            {t("settings.detail.hermesWillRunGatedActionsWithoutAsking.39f2f")}</InlineNote>
          <GlassButton size="sm" variant="ghost" onClick={() => setPendingOff(false)}>
            {t("settings.detail.cancel.19766")}</GlassButton>
          <GlassButton size="sm" variant="primary" onClick={() => void apply('off')} aria-label={t("settings.detail.confirmIndependentMode.72d03")}>
            {t("settings.detail.confirm.eebdd")}</GlassButton>
        </GlassCard>
      )}
      {setting.error && <InlineNote tone="danger">{t('settings.agents.approvalError', { error: setting.error })}</InlineNote>}
    </SettingsBlock>
  )
}

// ---- Preferred model -----------------------------------------------------------------------

function shortModel(model: string | undefined | null): string {
  if (!model) {
    return t('settings.common.automatic')
  }

  return model.includes('/') ? model.slice(model.indexOf('/') + 1) : model
}

/** A model chosen in the picker: the slug of the provider whose list it came from, and the model id exactly as that list gives it. */
export interface PreferredModelPick {
  provider: string
  model: string
}

export type PreferredModelListState = { kind: 'loading' } | { kind: 'error'; error: string } | { kind: 'models'; view: PreferredModels }

/** `model.options` as read for one `$providerChanges` count: the count says which provider state the answer is about. */
interface ModelOptionsLoad {
  data: { changes: number; result: ModelOptionsResult } | null
  loading: boolean
  error: string | null
}

/**
 * What the picker may show. Models are offered only from an answer read since the last provider
 * change and with no read under way or failed: an older answer is for a provider that may no longer
 * be the current one, and choosing from it would send that provider.
 */
export function preferredModelListState(load: ModelOptionsLoad, changes: number, filter: string): PreferredModelListState {
  if (load.error) {
    return { kind: 'error', error: load.error }
  }

  if (!load.data || load.data.changes !== changes || load.loading) {
    return { kind: 'loading' }
  }

  return { kind: 'models', view: preferredModelOptions(load.data.result, filter) }
}

/** The picker button's label: the current provider and model, or why there is none to name. */
export function preferredModelLabel(state: PreferredModelListState): string {
  if (state.kind === 'loading') {
    return t('settings.detail.loadingModels.cc8b4')
  }

  if (state.kind === 'error') {
    return t('settings.agents.model.unavailable')
  }

  const provider = state.view.name ?? state.view.providerId

  if (!provider) {
    return shortModel(state.view.current)
  }

  return state.view.current ? `${provider} · ${shortModel(state.view.current)}` : provider
}

const MODEL_LIMIT = 40

/** Why a provider's list is empty, in words; null when there are models to show. */
function modelNotice(view: PreferredModels): string | null {
  const name = view.name ?? view.providerId ?? ''

  switch (view.status) {
    case 'no-provider':
      return t('settings.agents.model.noProvider')
    case 'unknown-provider':
      return t('settings.agents.model.unknownProvider', { provider: view.providerId ?? '' })
    case 'ambiguous-provider':
      return t('settings.agents.model.ambiguousProvider', { provider: view.providerId ?? '' })
    case 'unauthenticated':
      return t('settings.agents.model.unauthenticated', { name })
    case 'empty':
      return t('settings.agents.model.empty', { name })
    case 'no-match':
      return t('settings.agents.model.noMatch', { name })
    default:
      return null
  }
}

/**
 * The picker's list, without state or hooks so a test can render it and call its real `onSelect`.
 * It always names the provider the models belong to; choosing one hands back that provider's slug.
 */
export function PreferredModelList({ state, pending, onSelect }: { state: PreferredModelListState; pending: PreferredModelPick | null; onSelect: (pick: PreferredModelPick) => void }) {
  if (state.kind === 'loading') {
    return <div className="px-1 py-2 text-[12px] text-fg-4">{t('settings.detail.loadingModels.cc8b4')}</div>
  }

  if (state.kind === 'error') {
    return <div className="px-1 py-2 text-[12px] text-danger">{t('settings.agents.model.loadError', { error: state.error })}</div>
  }

  const view = state.view
  const notice = modelNotice(view)
  const provider = view.status === 'ready' ? view.slug : null
  const shown = provider ? view.models.slice(0, MODEL_LIMIT) : []
  const more = (view.filtered ? view.models.length : view.catalogSize) - shown.length
  const name = view.name ?? view.providerId

  return (
    <div className="flex flex-col gap-2">
      <div className="px-1">
        <div className="text-[11.5px] font-medium text-fg-2">{name ? t('settings.agents.model.providerHeader', { name }) : t('settings.agents.model.providerUnknown')}</div>
        <div className="text-[11px] leading-snug text-fg-4">{t('settings.agents.model.changeProviderHint')}</div>
      </div>
      {notice && <div className="px-1 py-2 text-[12px] text-fg-4">{notice}</div>}
      {(view.status === 'ready' || view.status === 'no-match') && view.current && !view.currentListed && <div className="px-1 text-[11px] leading-snug text-fg-3">{t('settings.agents.model.currentNotListed', { model: view.current, name: name ?? '' })}</div>}
      {provider && (
        <div className="flex flex-col">
          {shown.map(model => {
            const active = model === view.current
            const busy = pending !== null && pending.provider === provider && pending.model === model

            return (
              <button key={model} type="button" data-os-target={`model:${model}`} aria-pressed={active} disabled={active || pending !== null} onClick={() => { if (!active && pending === null) onSelect({ provider, model }) }} className={cn('flex items-center justify-between rounded-md px-2 py-1.5 text-left font-mono text-[12px] transition-colors disabled:opacity-60', active ? 'bg-accent-soft text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg', busy && 'opacity-60')}>
                <span className="truncate">{model}</span>
                {busy ? <span className="ml-2 text-[10.5px] text-fg-3">{t('settings.agents.model.switching')}</span> : active && <span className="ml-2 text-[10.5px] text-accent-strong">{t('settings.detail.active.96879')}</span>}
              </button>
            )
          })}
          {more > 0 && <span className="px-2 py-1 text-[11px] text-fg-4">+{more} {t('settings.detail.moreViaModel.d1efc')}</span>}
        </div>
      )}
    </div>
  )
}

function PreferredModelRow({ ready }: { ready: boolean }) {
  useT()
  const changes = useStore($providerChanges)
  // The read remembers the change count it answered, so an answer from before a provider change is never taken for the current one.
  const options = useBackendData(async () => ({ changes, result: await gatewayRequest('model.options', { include_unconfigured: false }) }), [changes], { enabled: ready })
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [pending, setPending] = useState<PreferredModelPick | null>(null)
  const changing = useRef(false)
  const [confirm, setConfirm] = useState<(Extract<ModelChange, { ok: false }> & { revision: number }) | null>(null)
  const ref = useDismiss(open, () => setOpen(false))
  const state = preferredModelListState(options, changes, filter)
  const view = state.kind === 'models' ? state.view : null
  // A warning cannot survive a provider/model refresh or return after A → B → A.
  useEffect(() => setConfirm(null), [changes, view?.slug, view?.current])
  const liveConfirm = confirm && confirm.revision === changes && view?.slug === confirm.provider && view.current !== confirm.model ? confirm : null

  const setModel = async (pick: PreferredModelPick, confirmation?: Extract<ModelChange, { ok: false }>) => {
    if (changing.current) return
    changing.current = true
    setPending(pick)
    setConfirm(null)

    try {
      const change = await selectPreferredModel(pick.provider, pick.model, confirmation)
      setOpen(false)

      if (!change.ok) {
        setConfirm({ ...change, revision: changes })

        return
      }

      markSaved()
      // The chat open now, which may no longer be the one the model was chosen in.
      notify(modelChangeNotice(change, view?.slug === change.provider ? (view.name ?? change.provider) : change.provider, $activeChat.get()?.sessionId))
    } catch (error) {
      notify({ title: t("settings.detail.couldNotChangeModel.9df0b"), body: modelErrorText(error), level: 'error' })
    } finally {
      changing.current = false
      setPending(null)
    }
  }

  return (
    <SettingsRow
      icon={<IconCpu />}
      label={t("settings.detail.preferredModel.ec99e")}
      description={t("settings.detail.chooseTheModelHermesUsesForMostTasks.83dfe")}
      keywords="llm provider"
      below={liveConfirm ? <ModelConfirm message={liveConfirm.confirm} busy={pending !== null} onCancel={() => setConfirm(null)} onConfirm={() => void setModel({ provider: liveConfirm.provider, model: liveConfirm.model }, liveConfirm)} /> : undefined}
    >
      <div ref={ref} className="relative">
        <Dropdown label={<span className="max-w-[240px] truncate">{preferredModelLabel(state)}</span>} onClick={() => ready && setOpen(o => !o)} className={cn(!ready && 'opacity-50')} />
        {open && (
          <div className="float animate-pop absolute top-[calc(100%+6px)] right-0 z-30 flex w-[380px] flex-col rounded-lg" role="dialog" aria-label={t("settings.detail.chooseModel.f6e05")}>
            <label className="glass-input m-2 flex h-8 items-center gap-2 rounded-lg px-2.5">
              <IconSearch size={14} className="text-fg-3" />
              <input autoFocus value={filter} onChange={event => setFilter(event.target.value)} placeholder={t("settings.detail.filterModels.9a35e")} className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4" />
            </label>
            <div className="flex max-h-[360px] flex-col gap-3 overflow-y-auto px-2 pb-2">
              <PreferredModelList state={state} pending={pending} onSelect={pick => void setModel(pick)} />
            </div>
          </div>
        )}
      </div>
    </SettingsRow>
  )
}

// ---- Run on ---------------------------------------------------------------------------------

interface TerminalBackendRow {
  name: string
  label: string
  description?: string
  active?: boolean
  status?: 'ready' | 'needs_setup' | 'unavailable' | string
  detail?: string | null
}

interface TerminalBackendsPayload {
  active: string
  backends: TerminalBackendRow[]
}

const backendLabel = (row: TerminalBackendRow | undefined, name: string) => (name === 'local' ? t("settings.detail.thisDevice.d0525") : (row?.label ?? name))

function RunOnRow() {
  useT()
  const backends = useBackendData(() => rest.get<TerminalBackendsPayload>('/api/tools/terminal/backends'))
  const [override, setOverride] = useState<{ base: unknown; active: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const active = override && override.base === backends.data ? override.active : (backends.data?.active ?? 'local')
  const rows = backends.data?.backends ?? []
  const activeRow = rows.find(row => row.name === active)

  const select = async (name: string) => {
    if (name === active) {
      return
    }

    setOverride({ base: backends.data, active: name })
    setBusy(true)

    try {
      await rest.put('/api/tools/terminal/backend', { backend: name })
      markSaved()
      notify({ title: t("settings.detail.executionBackendChanged.49773"), body: t('settings.agents.backendChanged', { name: backendLabel(rows.find(row => row.name === name), name) }), level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: t("settings.detail.couldNotChangeBackend.1118d"), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      backends.reload()
    }
  }

  const statusTone = (status: string | undefined): PillTone => (status === 'ready' ? 'ok' : status === 'needs_setup' ? 'warn' : 'muted')

  return (
    <SettingsRow icon={<IconCloud />} label={t("settings.detail.runOn.f4b4b")} description={activeRow?.detail && activeRow.status !== 'ready' ? activeRow.detail : t("settings.detail.whereAgentsExecuteYourTasks.1dbb3")} keywords="terminal backend execution docker ssh modal cloud local">
      <MenuDropdown
        ariaLabel={t("settings.detail.executionBackend.95b4d")}
        label={backendLabel(activeRow, active)}
        value={active}
        disabled={busy || rows.length === 0}
        menuClassName="min-w-[300px]"
        items={rows.map(row => ({
          id: row.name,
          label: backendLabel(row, row.name),
          description: row.description,
          trailing: row.status ? <Pill tone={statusTone(row.status)}>{row.status.replace('_', ' ')}</Pill> : undefined
        }))}
        onSelect={name => void select(name)}
      />
    </SettingsRow>
  )
}

// ---- Background agents ---------------------------------------------------------------------

interface HermesConfigPayload {
  delegation?: { max_concurrent_children?: number | string | null; [key: string]: unknown }
  [key: string]: unknown
}

function BackgroundAgentsRow() {
  useT()
  const config = useBackendData(() => rest.get<HermesConfigPayload>('/api/config'))
  const [override, setOverride] = useState<{ base: unknown; value: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const raw = Number(config.data?.delegation?.max_concurrent_children)
  const value = override && override.base === config.data ? override.value : config.data ? (Number.isFinite(raw) && raw >= 1 ? Math.round(raw) : 10) : null

  const change = async (next: number) => {
    setOverride({ base: config.data, value: next })
    setBusy(true)

    try {
      await rest.put('/api/config', { config: { delegation: { max_concurrent_children: next } } })
      markSaved()
    } catch (error) {
      setOverride(null)
      notify({ title: t("settings.detail.couldNotChangeBackgroundAgents.46bf8"), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      config.reload()
    }
  }

  return (
    <SettingsRow icon={<IconUsers />} label={t("settings.detail.backgroundAgents.f508a")} description={t("settings.detail.numberOfConcurrentBackgroundAgents.ff141")} keywords="delegation subagents parallel concurrency">
      <Stepper value={value} onChange={next => void change(next)} min={1} max={32} disabled={busy || value === null} label={t("settings.detail.backgroundAgents.40071")} />
    </SettingsRow>
  )
}

// ---- Remember preferences (memory toolset) -------------------------------------------------

interface ToolsetRow {
  name: string
  label?: string
  enabled?: boolean
  [key: string]: unknown
}

function RememberPreferencesRow() {
  useT()
  const toolsets = useBackendData(() => rest.get<ToolsetRow[]>('/api/tools/toolsets'))
  const [override, setOverride] = useState<{ base: unknown; enabled: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const row = toolsets.data?.find(item => item.name === 'memory')
  const enabled = override && override.base === toolsets.data ? override.enabled : (row?.enabled ?? true)

  const toggle = async (next: boolean) => {
    setOverride({ base: toolsets.data, enabled: next })
    setBusy(true)

    try {
      await rest.put('/api/tools/toolsets/memory', { enabled: next })
      markSaved()
      notify({ title: next ? t("settings.detail.memoryOn.573b7") : t("settings.detail.memoryPaused.acf48"), body: next ? t("settings.detail.hermesCanSaveMemoriesAgain.a157e") : t("settings.detail.hermesStopsSavingToItsOwnMemoryIn.77672"), level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: t("settings.detail.couldNotChangeMemory.d8bdf"), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      toolsets.reload()
    }
  }

  return (
    <SettingsRow icon={<IconFileText />} label={t("settings.detail.rememberPreferences.7d880")} description={t("settings.detail.letHermesRememberYourSettingsAndLearnFrom.77474")} keywords="memory toolset learn">
      <Toggle checked={enabled} onChange={next => void toggle(next)} label={t("settings.detail.rememberPreferences.7d880")} disabled={busy || !row} />
    </SettingsRow>
  )
}

// ---- Ask before sending messages (bridge `act` tier) ---------------------------------------

function AskBeforeSendingRow() {
  useT()
  const policy = useLocalData(() => window.heraldOS.bridge.readPolicy())
  const [override, setOverride] = useState<{ base: unknown; confirm: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const tier = policy.data ? readTier(policy.data, 'act') : null
  const confirm = override && override.base === policy.data ? override.confirm : tier === 'confirm' || tier === 'deny'

  const toggle = async (next: boolean) => {
    if (!policy.data) {
      return
    }

    setOverride({ base: policy.data, confirm: next })
    setBusy(true)

    try {
      await window.heraldOS.bridge.writePolicy(withTier(policy.data, 'act', next ? 'confirm' : 'allow'))
      markSaved()
    } catch (error) {
      setOverride(null)
      notify({ title: t("settings.detail.couldNotUpdatePermissions.3a185"), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      policy.reload()
    }
  }

  return (
    <SettingsRow icon={<IconLock />} label={t("settings.detail.askBeforeSendingMessages.e776a")} description={t("settings.detail.getAConfirmationBeforeHermesSendsMessagesOn.83eb2")} keywords="permissions policy act tier bridge">
      <Toggle checked={confirm} onChange={next => void toggle(next)} label={t("settings.detail.askBeforeSendingMessages.e776a")} disabled={busy || !policy.data} />
    </SettingsRow>
  )
}

// ---- Activity history (bridge audit) --------------------------------------------------------

function ActivityHistoryRow() {
  useT()
  const [open, setOpen] = useState(false)
  // Only read the log while the panel is open; `open` in deps refetches on every expand.
  const audit = useLocalData(() => (open ? window.heraldOS.bridge.readAudit(200) : Promise.resolve<AuditEntry[]>([])), [open])

  return (
    <SettingsRow
      icon={<IconHistory />}
      label={t("settings.detail.activityHistory.e4687")}
      description={t("settings.detail.viewAndManageYourPastAgentActivity.611bf")}
      keywords="audit log bridge actions"
      below={
        open ? (
          <div className="animate-rise flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12px] text-fg-3">
              <span>{t("settings.detail.everyActionTheSystemBridgeTookOrRefused.36d25")}</span>
              <GlassButton size="sm" variant="ghost" onClick={audit.reload}>
                {t("settings.detail.refresh.0e916")}</GlassButton>
            </div>
            <div className="flex max-h-[320px] flex-col overflow-y-auto rounded-lg border border-line bg-black/20">
              {audit.loading && !audit.data?.length && <div className="p-3 text-[12px] text-fg-4">{t("settings.detail.loading.ba3bb")}</div>}
              {!audit.loading && (audit.data?.length ?? 0) === 0 && <div className="p-3 text-[12px] text-fg-4">{t("settings.detail.noBridgeActivityYet.b0b14")}</div>}
              {(audit.data ?? []).map((entry, index) => (
                <AuditRow key={`${entry.ts}-${index}`} entry={entry} />
              ))}
            </div>
          </div>
        ) : undefined
      }
    >
      <LinkAction onClick={() => setOpen(o => !o)}>{open ? t("settings.detail.hideHistory.db1dd") : t("settings.detail.viewHistory.a5932")}</LinkAction>
    </SettingsRow>
  )
}

export function AuditRow({ entry }: { entry: AuditEntry }) {
  useT()
  const tone: PillTone = !entry.ok ? 'danger' : entry.decision === 'denied' || entry.decision === 'blocked' ? 'warn' : entry.tier === 'destructive' ? 'warn' : 'muted'

  return (
    <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-[12px] last:border-b-0">
      <span className="w-14 shrink-0 text-fg-4">{formatRelative(Date.parse(entry.ts))}</span>
      <span className="w-40 shrink-0 truncate font-mono text-fg-2">
        {entry.tool}
        {entry.action ? `.${entry.action}` : ''}
      </span>
      <Pill tone={tone}>{entry.decision}</Pill>
      <span className="selectable min-w-0 flex-1 truncate text-fg-3">{entry.summary ?? entry.error ?? ''}</span>
    </div>
  )
}
