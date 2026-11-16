import { useStore } from '@nanostores/react'
import { IconApps, IconBrain, IconBrandWindows, IconCode, IconDeviceGamepad2, IconDownload, IconKey, IconMovie, IconRefresh, IconTerminal2, IconWorld } from '@tabler/icons-react'
import { type ComponentType, useEffect, useRef, useState } from 'react'
import type { CatalogEntryView } from '../../../../shared/ipc.ts'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { Spinner } from '../../../components/ui/primitives.tsx'
import { hostPlatform } from '../../../lib/platform-labels.ts'
import { $catalog, loadCatalog, runCatalog, useWithHermes } from '../../../store/catalog.ts'
import { notify } from '../../../store/notifications.ts'
import { $activeChat } from '../../../store/chat.ts'
import { type ModelChange, confirmModelChange, providerName } from '../../../store/model-provider.ts'
import { ModelConfirm, modelChangeNotice, modelErrorText } from './ProviderRow.tsx'
import { openTerminalProgram } from '../../../store/terminal.ts'
import { t, useT } from '../../../store/i18n.ts'
import { InlineNote, MenuDropdown, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

const GROUP_ICONS: Record<string, ComponentType<{ size?: number }>> = {
  ai: IconBrain,
  developer: IconCode,
  editors: IconCode,
  terminals: IconTerminal2,
  gaming: IconDeviceGamepad2,
  windows: IconBrandWindows,
  'windows-apps': IconBrandWindows,
  media: IconMovie,
  services: IconKey,
  webapps: IconWorld
}

/*
 * Software: the install catalog, grouped. Each row installs the right way for this machine
 * (Flatpak, the package manager, npm or mise in ~/.local, a web app), or says why it cannot.
 */
export function SoftwareSection() {
  const t = useT()
  const catalog = useStore($catalog)
  const [refreshing, setRefreshing] = useState(false)
  const linux = hostPlatform() === 'linux'

  useEffect(() => {
    void loadCatalog()
  }, [])

  const refresh = () => {
    setRefreshing(true)
    void loadCatalog().finally(() => setRefreshing(false))
  }

  return (
    <>
      <SectionTitle title={t('settings.section.software')} subtitle={linux ? t('settings.software.subtitleLinux') : hostPlatform() === 'win32' ? t('settings.software.subtitleWindows') : t('settings.software.subtitleMac')} />

      {catalog.error && <InlineNote tone="danger">{catalog.error}</InlineNote>}
      {!catalog.loaded && (
        <div className="flex items-center gap-3 px-1 py-4 text-[12.5px] text-fg-3">
          <Spinner /> {t("settings.detail.checkingWhatIsInstalled.596be")}</div>
      )}

      {catalog.groups.map(group => {
        const Icon = GROUP_ICONS[group.id] ?? IconApps

        return (
          <SettingsGroup key={group.id} title={group.label}>
            {group.entries.map(entry => (
              <CatalogRow key={entry.id} entry={entry} icon={<Icon size={16} />} busy={catalog.busy[entry.id]} />
            ))}
          </SettingsGroup>
        )
      })}

      {catalog.loaded && (
        <div className="flex justify-end">
          <GlassButton size="sm" variant="ghost" onClick={refresh} disabled={refreshing} aria-label={t("settings.detail.checkAgain.fb709")}>
            <IconRefresh size={14} /> {t("settings.detail.checkAgain.fb709")}</GlassButton>
        </div>
      )}
    </>
  )
}

function CatalogRow({ entry, icon, busy }: { entry: CatalogEntryView; icon: React.ReactNode; busy?: 'install' | 'remove' }) {
  useT()
  const description = entry.available || entry.installed ? entry.description : `${entry.description} ${entry.reason ? `(${entry.reason[0]?.toUpperCase()}${entry.reason.slice(1)}.)` : ''}`

  return (
    <SettingsRow icon={icon} label={entry.label} description={description} keywords={`${entry.id} ${entry.group} install ${t('settings.search.software')}`}>
      {busy ? (
        <span className="flex items-center gap-2 text-[12px] text-fg-3">
          <Spinner /> {busy === 'install' ? t("settings.detail.installing.530bc") : t("settings.detail.removing.d4b09")}
        </span>
      ) : entry.installed ? (
        <>
          <Pill tone="ok">{t("settings.detail.installed.f8b32")}</Pill>
          {entry.terminal && (
            <GlassButton size="sm" onClick={() => openTerminalProgram(entry.id, entry.label)} aria-label={t("settings.detail.openInTheTerminal.25025", { value1: entry.label })}>
              <IconTerminal2 size={14} /> {t("settings.detail.open.ed077")}</GlassButton>
          )}
          {entry.hermes && <UseWithHermes kind={entry.hermes} label={entry.label} />}
          {entry.removable && (
            <GlassButton size="sm" variant="ghost" onClick={() => void runCatalog(entry.id, 'remove')} aria-label={t("settings.detail.remove.0ab4d", { value1: entry.label })}>
              {t("settings.detail.remove.c3812")}</GlassButton>
          )}
        </>
      ) : entry.available ? (
        <GlassButton size="sm" onClick={() => void runCatalog(entry.id, 'install')} aria-label={t("settings.detail.install.e1fe2", { value1: entry.label })}>
          <IconDownload size={14} /> {t(entry.method === 'link' ? 'settings.common.download' : 'settings.common.install')}
        </GlassButton>
      ) : (
        <span className="text-[12px] text-fg-4">{hostPlatform() === 'win32' ? t("settings.detail.notDetected.9f4a1") : t("settings.detail.notHere.6358f")}</span>
      )}
    </SettingsRow>
  )
}

/** Point Hermes at one of the local server's models. */
function UseWithHermes({ kind, label }: { kind: 'ollama' | 'lmstudio'; label: string }) {
  useT()
  const [models, setModels] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirm, setConfirm] = useState<Extract<ModelChange, { ok: false }> | null>(null)
  const [switching, setSwitching] = useState(false)
  const changing = useRef(false)

  const load = async () => {
    setLoading(true)

    try {
      setModels([...new Set(await window.heraldOS.catalog.localModels(kind))])
    } catch (error) {
      notify({ title: t("settings.detail.isNotReady.1220f", { value1: label }), body: t('commands.result.software.modelsReadFailed'), level: 'warn' })
    } finally {
      setLoading(false)
    }
  }

  const choose = async (model: string, approved?: Extract<ModelChange, { ok: false }>) => {
    if (changing.current) return
    changing.current = true
    setSwitching(true)
    setConfirm(null)
    try {
      const change = approved ? await confirmModelChange(approved) : await useWithHermes(kind, model, true)
      if (change.ok) notify(modelChangeNotice(change, providerName(change.provider) ?? change.provider, $activeChat.get()?.sessionId))
      else setConfirm(change)
    } catch (error) {
      notify({ title: t("settings.detail.couldNotSwitchHermes.f15c1"), body: modelErrorText(error), level: 'error' })
    } finally {
      changing.current = false
      setSwitching(false)
    }
  }

  if (!models) {
    return (
      <GlassButton size="sm" onClick={() => void load()} disabled={loading} aria-label={t("settings.detail.useWithHermes.f3735", { value1: label })}>
        {loading ? <Spinner /> : <IconBrain size={14} />} {t("settings.detail.useWithHermes.99694")}</GlassButton>
    )
  }

  if (switching) return <span role="status">{t('settings.detail.switching.b7b9f')}</span>
  if (confirm) return <ModelConfirm message={confirm.confirm} onCancel={() => setConfirm(null)} onConfirm={() => void choose(confirm.model, confirm)} />
  return <div className="min-w-0">
    <InlineNote>{t(models.length ? 'settings.provider.local.hostedOnly' : 'settings.provider.local.noHostedModels')}</InlineNote>
    {models.length > 0 && <MenuDropdown ariaLabel={t("settings.detail.modelOn.e6dad", { value1: label })} label={t("settings.detail.chooseAModel.78a7a")} items={models.map(model => ({ id: model, label: model }))} onSelect={model => void choose(model)} />}
    <GlassButton size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>{t('settings.detail.checkAgain.fb709')}</GlassButton>
  </div>
}
