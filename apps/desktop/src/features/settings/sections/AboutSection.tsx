import { useStore } from '@nanostores/react'
import { IconDownload, IconFileText, IconInfoCircle, IconServer } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { type HermesStatusPayload, rest } from '../../../lib/rest.ts'
import { useBackendData, useLocalData } from '../../../lib/use-async.ts'
import { $backend, $env } from '../../../store/backend.ts'
import { openApp } from '../../../store/windows.ts'
import { AboutIdentity, BrandingSettings } from './BrandingSettings.tsx'
import { useT } from '../../../store/i18n.ts'
import { LogView, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'
import { desktopProductName, presentationPlatform } from '../../../lib/platform-labels.ts'

export function AboutSection() {
  const t = useT()
  const env = useStore($env)
  const windows = presentationPlatform(env?.platform) === 'win32'
  const backend = useStore($backend)
  const status = useBackendData(() => rest.get<HermesStatusPayload>('/api/status'))
  const [showLog, setShowLog] = useState(false)
  const log = useLocalData(() => (showLog ? window.heraldOS.backend.logTail(300) : Promise.resolve<string[]>([])), [showLog, backend.phase])

  return (
    <>
      <SectionTitle title={t('settings.section.about')} subtitle={t('settings.about.subtitle')} />

      <AboutIdentity />

      <SettingsGroup title={t("settings.detail.versions.f89ea")}>
        <SettingsRow icon={<IconInfoCircle />} label={desktopProductName(env?.platform)} description={env?.isDev ? t("settings.detail.developmentBuild.b547d") : t("settings.detail.agentnativeOperatingSystem.e358c")} keywords="version build shell">
          <Pill tone="accent">{env?.version ?? '—'}</Pill>
        </SettingsRow>
        <SettingsRow icon={<IconServer />} label={t("settings.detail.hermesRuntime.d6e72")} description={<span className="selectable">{backend.runtime?.label ?? t("settings.detail.notResolvedYet.8df14")}</span>} keywords="hermes agent version runtime">
          <Pill>{status.data?.version && status.data.version !== 'unknown' ? `v${String(status.data.version).replace(/^v/, '')}` : status.loading ? '…' : t('settings.common.unknown')}</Pill>
          {backend.runtime && <Pill>{t(`settings.network.state.${backend.runtime.kind}`)}</Pill>}
        </SettingsRow>
      </SettingsGroup>

      <BrandingSettings />

      <SettingsGroup title={t("settings.detail.maintenance.17ccf")}>
        {windows ? (
          <SettingsRow icon={<IconDownload />} label={t('settings.dragon.windowsUpdates.title')} description={t('settings.dragon.windowsUpdates.description')} keywords="herald update windows hermes">
            <Pill>{env?.version ?? '—'}</Pill>
            <GlassButton size="sm" disabled>
              {t('settings.dragon.windowsUpdates.open')}
            </GlassButton>
          </SettingsRow>
        ) : (
        <SettingsRow icon={<IconDownload />} label={t("settings.detail.checkForUpdates.f26f3")} description={t("settings.detail.heraldOSRunsWhateverHermesIsInstalledRun.2097b")} keywords="upgrade update hermes update terminal">
          <GlassButton size="sm" onClick={() => openApp('terminal')} aria-label={t("settings.detail.openTerminal.ae088")}>
            {t("settings.detail.openTerminal.ae088")}</GlassButton>
        </SettingsRow>
        )}
        <SettingsRow
          icon={<IconFileText />}
          label={t("settings.detail.openLogs.59188")}
          description={t("settings.detail.theLast300LinesFromTheHermesBackend.74f45")}
          keywords="log output debug backend"
          below={showLog ? <LogView lines={log.data ?? []} empty={log.loading ? t("settings.detail.loading.ba3bb") : t("settings.detail.noLogOutputYet.f1648")} className="animate-rise" /> : undefined}
        >
          {showLog && (
            <GlassButton size="sm" variant="ghost" onClick={log.reload}>
              {t("settings.detail.refresh.0e916")}</GlassButton>
          )}
          <GlassButton size="sm" onClick={() => setShowLog(o => !o)} aria-label={showLog ? t("settings.detail.hideLogs.215a7") : t("settings.detail.openLogs.59188")}>
            {showLog ? t("settings.detail.hideLogs.215a7") : t("settings.detail.openLogs.59188")}
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
