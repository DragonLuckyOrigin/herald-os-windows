import type { TextKey } from '../../../../shared/i18n.ts'
import { t, useT } from '../../../store/i18n.ts'
import { useStore } from '@nanostores/react'
import { IconCheck, IconExternalLink, IconKey, IconRefresh, IconSearch, IconTerminal2 } from '@tabler/icons-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Dropdown, GlassButton, LinkAction, Pill } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { modelChangeScope, type ProviderChoice, type ProviderSetup, providerChoices } from '../../../lib/model-provider.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { $connection } from '../../../store/gateway.ts'
import { $activeChat } from '../../../store/chat.ts'
import { $hermesAuth, refreshHermesAuth, requestHermesLogin } from '../../../store/hermes-auth.ts'
import { $providerChanges, $providerFocus, loadProviderConfig, loadKeyCatalog, loadModelOptions, modelErrorText, ModelChangeIncomplete, type ModelChange, confirmModelChange, selectLocalModel, providerSlug, saveProviderKey, switchToProvider } from '../../../store/model-provider.ts'
import { notify } from '../../../store/notifications.ts'
import { openWebWindow } from '../../../store/web-windows.ts'
import { openApp, showPage } from '../../../store/windows.ts'
import { focusSettings, InlineNote, markSaved, SettingsRow, useDismiss } from './shared.tsx'

/*
 * Model provider: the provider Hermes thinks with, and switching it, in Settings > Hermes & agents
 * and in first-run setup. Every provider Hermes knows is offered. One that is set up is used at
 * once, on Hermes's recommended model for it; one that signs in on an account opens the sign-in
 * card; one that takes an API key asks for it here, a custom endpoint whose entry names a key
 * variable included; the rest say what to run.
 */

const SETUP_HINT: Record<ProviderSetup, TextKey> = { key: "settings.detail.literal.APIkey", 'sign-in': "settings.detail.signIn.bfd40", terminal: "settings.detail.literal.Terminal", local: "settings.detail.thisComputer.26f9f", endpoint: "settings.detail.literal.Yourendpoint" }
const READY: Record<ProviderSetup, { pill: TextKey; text: TextKey }> = {
  key: { pill: "settings.detail.keySaved.a45a9", text: "settings.detail.usesYourAPIKey.02dbc" },
  'sign-in': { pill: "settings.detail.signedIn.ca566", text: "settings.detail.signedIn.5cd6e" },
  terminal: { pill: "settings.detail.signedIn.ca566", text: "settings.detail.signedInThroughItsOwnTool.615e0" },
  local: { pill: "settings.detail.ready.5fa7a", text: "settings.detail.runsOnThisComputer.3b8db" },
  endpoint: { pill: "settings.detail.ready.5fa7a", text: "settings.detail.usesYourOwnEndpointAsHermesHasIt.983d1" }
}
const NOT_READY: Record<ProviderSetup, { pill: TextKey; text: TextKey }> = {
  key: { pill: "settings.detail.noKey.e8678", text: "settings.detail.itsAPIKeyIsMissingHermesCannotAnswer.493f7" },
  'sign-in': { pill: "settings.detail.signedOut.80c6e", text: "settings.detail.signedOutHermesCannotAnswerUntilYouSign.0946a" },
  terminal: { pill: "settings.detail.notSignedIn.491fc", text: "settings.detail.notSignedInHermesCannotAnswerUntilIt.7a89d" },
  local: { pill: "settings.detail.notRunning.9e385", text: "settings.detail.notRunningHermesCannotAnswerUntilItIs.2b284" },
  endpoint: { pill: "settings.detail.notSetUp.94b76", text: "settings.detail.notSetUpHermesCannotAnswerUntilIt.467f5" }
}

/** The last chooser request acted on, so a row that mounts later leaves an old one alone. */
let handledFocus = 0

export { modelErrorText } from '../../../store/model-provider.ts'

export function localProviderText(choice: ProviderChoice): string {
  switch (choice.localState) {
    case 'disabled': return t('settings.provider.local.disabled')
    case 'catalogued': return t('settings.provider.local.catalogued')
    case 'unavailable': return t('settings.provider.local.unavailable')
    default: return t('settings.provider.local.unknown')
  }
}

function localLabel(choice: ProviderChoice): string {
  return choice.local === 'hermes' ? 'Hermes Local' : choice.local === 'ollama' ? 'Ollama' : choice.local === 'lmstudio' ? 'LM Studio' : choice.name
}

/**
 * What to tell the person after a model change was saved: who it reaches. A default saved while the
 * open chat switch is unconfirmed or queued is a warning, not a plain success. `openSessionId` is the chat open
 * now, which may differ from the one the model was chosen in.
 */
export function modelChangeNotice(change: Extract<ModelChange, { ok: true }>, name: string, openSessionId: string | null | undefined): { title: string; body: string; level: 'success' | 'warn' } {
  const values = { name, model: change.model }
  const body = (text: string) => `${text}${change.local ? ` ${t('settings.provider.local.responseUnverified')}` : ''}`

  switch (modelChangeScope(change.session, openSessionId)) {
    case 'chat-queued':
      return { title: t('settings.agents.model.queuedTitle'), body: body(t('settings.agents.model.saved.chatQueued', values)), level: 'warn' }
    case 'chat-failed':
      return { title: t('settings.agents.model.partialTitle'), body: body(t('settings.agents.model.saved.chatFailed', values)), level: 'warn' }
    case 'new-only':
      return { title: t('settings.detail.modelChanged.ffa6c'), body: body(t('settings.agents.model.saved.newOnly', values)), level: 'success' }
    case 'earlier-chat-and-new':
      return { title: t('settings.detail.modelChanged.ffa6c'), body: body(t('settings.agents.model.saved.earlierChat', values)), level: 'success' }
    default:
      return { title: t('settings.detail.modelChanged.ffa6c'), body: body(t('settings.agents.model.saved.chatAndNew', values)), level: 'success' }
  }
}

export function ModelProviderRow() {
  useT()
  const online = useStore($connection) === 'open'
  const auth = useStore($hermesAuth)
  const changes = useStore($providerChanges)
  const focus = useStore($providerFocus)
  const options = useBackendData(loadModelOptions, [changes], { enabled: online })
  const keys = useBackendData(loadKeyCatalog, [changes])
  const endpoints = useBackendData(loadProviderConfig, [changes])
  const choices = useMemo(() => providerChoices(options.data, auth.providers, keys.data ?? {}, endpoints.data?.keys ?? {}, endpoints.data?.context), [options.data, auth.providers, keys.data, endpoints.data])
  const current = choices.find(choice => choice.current) ?? null
  const [setup, setSetup] = useState<ProviderChoice | null>(null)
  const [confirm, setConfirm] = useState<Extract<ModelChange, { ok: false }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [menuRequest, setMenuRequest] = useState(0)

  const openSetup = (choice: ProviderChoice) => {
    setConfirm(null)
    setSetup(choice)
  }

  // The sign-in card, setup or a command asked for the chooser, or for one provider's setup (its
  // key form even when a key is saved: the card sends a refused one here to be replaced).
  useEffect(() => {
    if (!focus || focus.ts <= handledFocus || choices.length === 0) {
      return
    }

    handledFocus = focus.ts
    const slug = focus.slug && providerSlug(focus.slug)
    const choice = slug ? choices.find(item => item.slug === slug) : undefined

    if (choice && choice.setup !== 'sign-in') {
      openSetup(choice)
    } else {
      setMenuRequest(focus.ts)
    }
  }, [focus, choices])

  const nameOf = (slug: string) => choices.find(choice => choice.slug === providerSlug(slug))?.name ?? slug

  const settle = (change: ModelChange) => {
    if (change.ok) {
      markSaved()

      notify(modelChangeNotice(change, nameOf(change.provider), $activeChat.get()?.sessionId))
    } else {
      setConfirm(change)
    }
  }

  const run = async (name: string, change: () => Promise<ModelChange>) => {
    setBusy(true)

    try {
      settle(await change())
    } catch (error) {
      notify({ title: t("settings.detail.couldNotSwitchTo.2b974", { value1: name }), body: modelErrorText(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const pick = (choice: ProviderChoice, model?: string) => {
    setConfirm(null)
    setSetup(null)

    if (choice.ready) {
      if (choice.local && model) {
        if (choice.current && model === options.data?.model) return
        void run(choice.name, () => selectLocalModel(choice.slug, model, false, $activeChat.get()?.sessionId ?? null, choice.local))
      } else if (!choice.current) {
        void run(choice.name, () => switchToProvider(choice.slug))
      }
    } else if (choice.setup === 'sign-in') {
      requestHermesLogin(t("settings.detail.signInToToUseItWithHermes.bbe3b", { value1: choice.name }), choice.slug)
    } else {
      openSetup(choice)
    }
  }

  const refresh = () => {
    void refreshHermesAuth()
    options.reload()
    keys.reload()
    endpoints.reload()
  }

  const others = auth.providers.filter(provider => provider.loggedIn && provider.id !== current?.slug).map(provider => provider.name)
  const description = !options.data
    ? !online
      ? t("settings.detail.waitingForHermes.7fdc2")
      : options.error
        ? t('settings.provider.readFailed')
        : t("settings.detail.checking.ec963")
    : !current
      ? t("settings.detail.hermesHasNoModelProviderYetChooseOne.ebb05")
      : current.local
        ? localProviderText(current)
        : current.ready
        ? `${t(READY[current.setup].text)}${others.length ? t("settings.detail.alsoSignedIn.5622a", { value1: others.join(', ') }) : ''}`
        : t(NOT_READY[current.setup].text)

  return (
    <SettingsRow
      icon={<IconKey />}
      label={t("settings.detail.modelProvider.ea703")}
      description={<span className="break-words">{description}{options.data?.provider && <span className="mt-1 block selectable">{options.data.provider} · {options.data.model || t('settings.provider.local.unknownModel')}</span>}</span>}
      keywords={`${t('settings.search.providers')} provider account sign in login oauth api key nous portal openrouter openai anthropic chatgpt codex gemini switch change llm credentials custom endpoint server key_env ${description} local lokale modelle ollama lm studio llamacpp gguf ${choices.map(choice => [choice.slug, choice.name, ...choice.models].join(' ')).join(' ')}`}
      below={
        confirm ? (
          <ModelConfirm
            message={confirm.confirm}
            busy={busy}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              setConfirm(null)
              void run(nameOf(confirm.provider), () => confirmModelChange(confirm))
            }}
          />
        ) : setup ? (
          <SetupPanel
            key={setup.slug}
            choice={setup}
            onCancel={() => setSetup(null)}
            onDone={change => {
              setSetup(null)
              settle(change)
            }}
          />
        ) : undefined
      }
    >
      {current && (
        <Pill tone={current.local || !current.ready ? 'warn' : 'ok'} dot>
          {current.local ? t('settings.provider.local.inferenceUnverified') : t((current.ready ? READY : NOT_READY)[current.setup].pill)}
        </Pill>
      )}
      {current && <CurrentAction current={current} onSetup={openSetup} />}
      <ProviderMenu choices={choices} current={current} currentModel={options.data?.model ?? null} loading={options.loading} error={options.error} disabled={!online || busy} busy={busy} request={menuRequest} onPick={pick} />
      <GlassButton size="sm" variant="ghost" onClick={refresh} aria-label={t("settings.detail.refreshProviders.56b2d")}>
        <IconRefresh />
      </GlassButton>
    </SettingsRow>
  )
}

/** The current provider's own next step: sign in, add or replace its key, or set it up. */
function CurrentAction({ current, onSetup }: { current: ProviderChoice; onSetup: (choice: ProviderChoice) => void }) {
  useT()
  if (current.ready) {
    return current.setup === 'key' ? (
      <GlassButton size="sm" variant="ghost" onClick={() => onSetup(current)} aria-label={t("settings.detail.replaceTheAPIKey.4c81a", { value1: current.name })}>
        {t("settings.detail.newKey.eda54")}</GlassButton>
    ) : null
  }

  if (current.setup === 'sign-in') {
    return (
      <GlassButton size="sm" variant="primary" onClick={() => requestHermesLogin(t("settings.detail.isSignedOut.b5706", { value1: current.name }), current.slug)} aria-label={t("settings.detail.signInWith.584af", { value1: current.name })}>
        {t("settings.detail.signIn.bfd40")}</GlassButton>
    )
  }

  return (
    <GlassButton size="sm" variant="primary" onClick={() => onSetup(current)}>
      {current.setup === 'key' ? t("settings.detail.addKey.12626") : t("settings.detail.setUp.4da10")}
    </GlassButton>
  )
}

function ProviderMenu({ choices, current, currentModel, loading, error, disabled, busy, request, onPick }: { choices: ProviderChoice[]; current: ProviderChoice | null; currentModel: string | null; loading: boolean; error: string | null; disabled: boolean; busy: boolean; request: number; onPick: (choice: ProviderChoice, model?: string) => void }) {
  useT()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useDismiss(open, () => setOpen(false))
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !menuRef.current) return
    const menu = menuRef.current
    const place = () => {
      menu.style.transform = ''
      let rect = menu.getBoundingClientRect()
      const width = document.documentElement.clientWidth
      const height = document.documentElement.clientHeight
      const scale = rect.width / Math.max(1, menu.offsetWidth)
      menu.style.maxWidth = `${(width - 32) / scale}px`
      menu.style.maxHeight = `${(height - 32) / scale}px`
      rect = menu.getBoundingClientRect()
      const x = Math.max(16 - rect.left, Math.min(0, width - 16 - rect.right))
      const y = Math.max(16 - rect.top, Math.min(0, height - 16 - rect.bottom))
      menu.style.transform = `translate(${x / scale}px, ${y / scale}px)`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(menu)
    // CSS text/layout scaling can change visual bounds without changing the content box.
    const ancestors = new MutationObserver(place)
    for (let parent = menu.parentElement; parent; parent = parent.parentElement) {
      ancestors.observe(parent, { attributes: true, attributeFilter: ['style', 'class'] })
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      ancestors.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (request) {
      setOpen(true)
    }
  }, [request])

  const q = filter.trim().toLowerCase()
  const shown = q ? choices.filter(choice => choice.name.toLowerCase().includes(q) || choice.slug.includes(q) || localLabel(choice).toLowerCase().includes(q) || choice.models.some(model => model.toLowerCase().includes(q))) : choices
  const groups = [
    { title: t('settings.provider.local.group'), items: shown.filter(choice => choice.local) },
    { title: t("settings.detail.readyToUse.996f8"), items: shown.filter(choice => !choice.local && choice.ready) },
    { title: t("settings.detail.setUpFirst.a5ea8"), items: shown.filter(choice => !choice.local && !choice.ready) }
  ].filter(group => group.items.length > 0)

  return (
    <div ref={ref} className="relative">
      <Dropdown label={<span className="max-w-[200px] truncate">{busy ? t("settings.detail.switching.b7b9f") : (current?.name ?? t("settings.detail.chooseAProvider.e1d36"))}</span>} onClick={() => !disabled && setOpen(o => !o)} className={cn(disabled && 'opacity-50')} />
      {open && (
        <div ref={menuRef} className="float absolute top-[calc(100%+6px)] right-0 z-30 flex w-[min(340px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] flex-col rounded-lg" role="dialog" aria-label={t("settings.detail.chooseAModelProvider.03c0d")}>
          <label className="glass-input m-2 flex h-8 items-center gap-2 rounded-lg px-2.5">
            <IconSearch size={14} className="text-fg-3" />
            <input autoFocus value={filter} onChange={event => setFilter(event.target.value)} placeholder={t("settings.detail.filterProviders.8064b")} aria-label={t("settings.detail.filterProviders.8064b")} className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4" />
          </label>
          <div className="flex min-h-0 max-h-[360px] flex-col gap-3 overflow-y-auto px-2 pb-2">
            {loading && choices.length === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">{t("settings.detail.loadingProviders.d8de9")}</div>}
            {error && <div className="px-1 py-2 text-[12px] text-danger">{t('settings.provider.readFailed')}</div>}
            {!loading && !error && shown.length === 0 && <div className="px-1 py-2 text-[12px] text-fg-4">{t("settings.detail.noProviderMatches.80d62")}</div>}
            {groups.map(group => (
              <section key={group.title}>
                <div className="mb-1 px-1 text-[11.5px] font-medium text-fg-2">{group.title}</div>
                <div className="flex flex-col" role="listbox" aria-label={group.title}>
                  {group.items.flatMap<{ choice: ProviderChoice; model?: string }>(choice => choice.local && choice.ready ? choice.models.map(model => ({ choice, model })) : [{ choice }]).map(({ choice, model }) => (
                    <ProviderOption key={JSON.stringify([choice.slug, model])} choice={choice} model={model} currentModel={currentModel} onPick={() => {
                      setOpen(false)
                      setFilter('')
                      onPick(choice, model)
                    }} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function openHelp(choice: ProviderChoice): void {
  if (choice.helpUrl) {
    void openWebWindow(choice.helpUrl, { title: choice.name }).catch(() => undefined)
  }
}

function SetupPanel({ choice, onCancel, onDone }: { choice: ProviderChoice; onCancel: () => void; onDone: (change: ModelChange) => void }) {
  useT()
  return choice.setup === 'key' ? <KeyForm choice={choice} onCancel={onCancel} onDone={onDone} /> : <OtherSetup choice={choice} onCancel={onCancel} onDone={onDone} />
}

function KeyForm({ choice, onCancel, onDone }: { choice: ProviderChoice; onCancel: () => void; onDone: (change: ModelChange) => void }) {
  useT()
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setError(null)

    try {
      const change = await saveProviderKey(choice, key)
      setKey('')
      onDone(change)
    } catch (err) {
      if (err instanceof ModelChangeIncomplete && err.reason === 'key-saved') setKey('')
      setError(modelErrorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="animate-rise flex flex-col gap-2 rounded-lg border border-line bg-black/20 p-3"
      onSubmit={event => {
        event.preventDefault()
        void save()
      }}
    >
      <div className="text-[12px] leading-snug text-fg-2">
        {t('settings.provider.keyInstructions', { name: choice.name, keyEnv: choice.keyEnv ?? '' })}</div>
      <div className="flex items-center gap-2">
        <input type="password" value={key} onChange={event => setKey(event.target.value)} autoFocus autoComplete="off" spellCheck={false} placeholder={t("settings.detail.apiKey.16f0e")} aria-label={t("settings.detail.apiKey.9b6b4", { value1: choice.name })} className="glass-input h-8 min-w-0 flex-1 rounded-lg px-2.5 font-mono text-[12px] text-fg outline-none placeholder:text-fg-4" />
        <GlassButton size="sm" variant="ghost" onClick={onCancel}>
          {t("settings.detail.cancel.19766")}</GlassButton>
        <GlassButton size="sm" variant="primary" type="submit" disabled={saving || !key.trim()}>
          {saving ? t("settings.detail.saving.23e39") : t("settings.detail.saveAndUse.bf927")}
        </GlassButton>
      </div>
      {error && <InlineNote tone="danger">{error}</InlineNote>}
      {choice.helpUrl && <LinkAction onClick={() => openHelp(choice)}>{t('settings.provider.getKey', { name: choice.name })}</LinkAction>}
    </form>
  )
}

/** A provider that signs in through its own tool, runs on this computer, or is the person's own endpoint: what to do, then use it. */
function OtherSetup({ choice, onCancel, onDone }: { choice: ProviderChoice; onCancel: () => void; onDone: (change: ModelChange) => void }) {
  useT()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const local = choice.setup === 'local'

  const check = async () => {
    setChecking(true)
    setError(null)

    try {
      onDone(await switchToProvider(choice.slug))
    } catch (err) {
      setError(modelErrorText(err))
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="animate-rise flex flex-col gap-2 rounded-lg border border-line bg-black/20 p-3 text-[12px] leading-snug text-fg-2">
      {local ? (
        <p>{localProviderText(choice)} {t('settings.provider.local.nativeSetup')}</p>
      ) : choice.setup === 'endpoint' ? (
        <p>
          {t('settings.provider.endpointInstructions', { name: choice.name })}</p>
      ) : (
        <>
          <p>{choice.name} {t("settings.detail.signsInThroughItsOwnToolRunThis.b6f46")}</p>
          <code className="selectable rounded-lg border border-line bg-black/25 px-3 py-2 font-mono text-[12px] text-fg">{choice.command}</code>
        </>
      )}
      {error && <InlineNote tone="danger">{error}</InlineNote>}
      <div className="flex flex-wrap items-center gap-2">
        {local ? (
          <GlassButton
            size="sm"
            onClick={() => {
              showPage('settings')
              focusSettings({ section: 'software' })
            }}
          >
            {t("settings.detail.openSoftware.e8178")}</GlassButton>
        ) : (
          <GlassButton size="sm" onClick={() => openApp('terminal')}>
            <IconTerminal2 />
            {t("settings.detail.openTerminal.ae088")}</GlassButton>
        )}
        {choice.helpUrl && (
          <GlassButton size="sm" variant="ghost" onClick={() => openHelp(choice)} aria-label={t("settings.detail.howSignsIn.1cd67", { value1: choice.name })}>
            <IconExternalLink />
            {t("settings.detail.howItWorks.9c870")}</GlassButton>
        )}
        <span className="flex-1" />
        <GlassButton size="sm" variant="ghost" onClick={onCancel}>
          {t("settings.detail.cancel.19766")}</GlassButton>
        <GlassButton size="sm" variant="primary" onClick={() => void check()} disabled={checking}>
          {checking ? t("settings.detail.checking.ec963") : t("settings.detail.use.c9359", { value1: choice.name })}
        </GlassButton>
      </div>
    </div>
  )
}

/** A model Hermes warns about (far pricier than most): say so, and switch only when the person agrees. */
export function ModelConfirm({ message, busy, onCancel, onConfirm }: { message: string; busy?: boolean; onCancel: () => void; onConfirm: () => void }) {
  useT()
  return (
    <div className="animate-rise flex items-center gap-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2">
      <InlineNote tone="warn" className="selectable flex-1 whitespace-pre-line">
        {message}
      </InlineNote>
      <GlassButton size="sm" variant="ghost" onClick={onCancel}>
        {t("settings.detail.cancel.19766")}</GlassButton>
      <GlassButton size="sm" variant="primary" onClick={onConfirm} disabled={busy} aria-label={t("settings.detail.useThisModelAnyway.08e2a")}>
        {t("settings.detail.useItAnyway.2eda8")}</GlassButton>
    </div>
  )
}

/** One exact model option; selection styling, accessibility and automation target agree. */
export function ProviderOption({ choice, model, currentModel, onPick }: { choice: ProviderChoice; model?: string; currentModel: string | null; onPick: () => void }) {
  const selected = choice.current && (!model || model === currentModel)
  return <button type="button" role="option" aria-selected={selected} data-os-target={model ? `provider:${choice.slug}:${model}` : `provider:${choice.slug}`} onClick={onPick}
    className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors', selected ? 'bg-accent-soft text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg')}>
    <span className="min-w-0 flex-1 break-words">{choice.local ? localLabel(choice) : choice.name}{model && <span className="block selectable">{model}</span>}{choice.local && <span className="mt-0.5 block text-[11px] text-fg-3">{choice.slug} · {localProviderText(choice)}</span>}</span>
    {!choice.ready && <span className="shrink-0 text-[11px] text-fg-4">{t(SETUP_HINT[choice.setup])}</span>}
    {selected && <IconCheck size={14} className="shrink-0 text-accent-strong" />}
  </button>
}
