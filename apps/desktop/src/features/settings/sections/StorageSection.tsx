import { useStore } from '@nanostores/react'
import { IconDeviceFloppy, IconHome } from '@tabler/icons-react'
import { GlassButton, ProgressBar } from '../../../components/ui/glass.tsx'
import { formatBytes } from '../../../lib/format.ts'
import { deviceNoun } from '../../../lib/platform-labels.ts'
import { useLocalData } from '../../../lib/use-async.ts'
import { $env } from '../../../store/backend.ts'
import { sendPrompt } from '../../../store/chat.ts'
import { useSystemStats } from '../../../store/system.ts'
import { showPage } from '../../../store/windows.ts'
import { useT } from '../../../store/i18n.ts'
import { SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

export function StorageSection() {
  const t = useT()
  const stats = useSystemStats()
  const env = useStore($env)
  const hermesHome = env?.hermesHome ?? null
  const homeSize = useLocalData(() => (hermesHome ? window.heraldOS.fs.dirSize(hermesHome) : Promise.resolve(null)), [hermesHome])

  const askHermes = () => {
    showPage('hermes')
    void sendPrompt(t('settings.storage.askPrompt'))
  }

  return (
    <>
      <SectionTitle title={t('settings.section.storage')} subtitle={t('settings.storage.subtitle', { device: deviceNoun() })} />

      <SettingsGroup title={t("settings.detail.disks.7d486")}>
        {(stats?.disks ?? []).length === 0 && <SettingsRow icon={<IconDeviceFloppy />} label={t("settings.detail.disks.7d486")} description={t("settings.detail.readingDiskUsage.d1b53")} keywords="volume mount" />}
        {(stats?.disks ?? []).map(disk => {
          const percent = disk.total > 0 ? (disk.used / disk.total) * 100 : 0

          return (
            <SettingsRow
              key={disk.mount}
              icon={<IconDeviceFloppy />}
              label={disk.mount === '/' ? t('settings.storage.systemDrive') : disk.mount}
              description={t("settings.detail.usedOfFree.a06a8", { value1: formatBytes(disk.used), value2: formatBytes(disk.total), value3: formatBytes(disk.free) })}
              keywords="disk volume mount free used"
              below={<ProgressBar value={percent} tone={percent > 90 ? 'progress' : 'accent'} />}
            >
              <span className="text-[12px] tabular-nums text-fg-2">{Math.round(percent)}%</span>
            </SettingsRow>
          )
        })}
      </SettingsGroup>

      <SettingsGroup title="Hermes">
        <SettingsRow
          icon={<IconHome />}
          label={t("settings.detail.hermesHome.db8ea")}
          description={
            <span className="selectable font-mono text-[11.5px]">
              {hermesHome ?? '—'}
              {homeSize.data ? t("settings.detail.inFiles.e48dd", { value1: formatBytes(homeSize.data.bytes), value2: homeSize.data.complete ? '' : '+', value3: homeSize.data.files.toLocaleString() }) : homeSize.loading ? t("settings.detail.measuring.85199") : ''}
            </span>
          }
          keywords="hermes home folder size sessions memories"
        >
          <GlassButton size="sm" onClick={askHermes} aria-label={t("settings.detail.askHermesWhatIsUsingSpace.90e26")}>
            {t("settings.detail.askHermesWhatIsUsingSpace.90e26")}</GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
