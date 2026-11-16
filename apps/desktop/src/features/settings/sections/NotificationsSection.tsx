import { useStore } from '@nanostores/react'
import { IconBug, IconChecklist, IconDeviceDesktop, IconShieldCheck, IconVolumeOff, IconX } from '@tabler/icons-react'
import { useState } from 'react'
import { Toggle } from '../../../components/ui/glass.tsx'
import type { NotifyPrefs } from '../../../../shared/ipc.ts'
import type { TextKey } from '../../../../shared/i18n.ts'
import { $prefs } from '../../../store/backend.ts'
import { setCrashHelpEnabled, setCrashMuted } from '../../../store/crashes.ts'
import { useT } from '../../../store/i18n.ts'
import { setNotifySwitch } from '../../../store/notifications.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

type NotifyKey = keyof NotifyPrefs

// No row for taskUpdates yet: nothing raises a task-result alert for it to silence. The pref and the
// taskUpdate category stay, so the row can come back with that alert.
const ROWS: { key: NotifyKey; label: TextKey; description: TextKey; icon: React.ReactNode; keywords?: string }[] = [
  { key: 'toolCompletions', label: 'settings.notifications.finished', description: 'settings.notifications.finishedDescription', icon: <IconChecklist />, keywords: 'toast finished turn tool completions' },
  { key: 'approvals', label: 'settings.notifications.approvals', description: 'settings.notifications.approvalsDescription', icon: <IconShieldCheck />, keywords: 'permission request waiting' },
  { key: 'nativeWhenUnfocused', label: 'settings.notifications.native', description: 'settings.notifications.nativeDescription', icon: <IconDeviceDesktop />, keywords: 'macos windows system background' }
]

export function NotificationsSection() {
  const t = useT()

  return (
    <>
      <SectionTitle title={t('settings.section.notifications')} subtitle={t('settings.notifications.subtitle')} />

      <AlertsGroup />

      <CrashHelpGroup />
    </>
  )
}

function AlertsGroup() {
  const t = useT()
  const flags = useStore($prefs).notify
  const [error, setError] = useState<{ key: NotifyKey; text: string } | null>(null)

  const set = (key: NotifyKey, value: boolean) =>
    setNotifySwitch(key, value).then(
      () => {
        setError(null)
        markSaved()
      },
      reason => setError({ key, text: errorText(reason) })
    )

  return (
    <SettingsGroup title={t('settings.notifications.alerts')}>
      {ROWS.map(row => (
        <SettingsRow
          key={row.key}
          icon={row.icon}
          label={t(row.label)}
          description={t(row.description)}
          keywords={row.keywords}
          below={error?.key === row.key ? <InlineNote tone="danger">{error.text}</InlineNote> : undefined}
        >
          <Toggle checked={flags[row.key]} onChange={next => void set(row.key, next)} label={t(row.label)} />
        </SettingsRow>
      ))}
    </SettingsGroup>
  )
}

function CrashHelpGroup() {
  const t = useT()
  const { enabled, muted } = useStore($prefs).crashHelp
  const [error, setError] = useState<string | null>(null)

  const save = (work: Promise<unknown>) =>
    work.then(
      () => {
        setError(null)
        markSaved()
      },
      reason => setError(errorText(reason))
    )

  return (
    <SettingsGroup title={t('settings.notifications.crashHelp')}>
      <SettingsRow
        icon={<IconBug />}
        label={t('settings.notifications.explainCrashes')}
        description={t('settings.notifications.explainCrashesDescription')}
        keywords="crash report core dump diagnose"
        below={error ? <InlineNote tone="danger">{error}</InlineNote> : undefined}
      >
        <Toggle checked={enabled} onChange={next => save(setCrashHelpEnabled(next))} label={t('settings.notifications.explainCrashes')} />
      </SettingsRow>
      <SettingsRow
        icon={<IconVolumeOff />}
        label={t('settings.notifications.muted')}
        description={t(muted.length === 0 ? 'settings.notifications.muteHint' : 'settings.notifications.mutedDescription')}
        keywords="mute crash quiet"
        below={
          muted.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {muted.map(app => (
                <span key={app} className="inline-flex h-7 items-center gap-1 rounded-full border border-line bg-white/6 pr-1 pl-2.5 text-[12px] text-fg-2">
                  {app}
                  <button type="button" aria-label={t('settings.notifications.unmute', { name: app })} onClick={() => save(setCrashMuted(app, false))} className="flex size-5 items-center justify-center rounded-full text-fg-3 hover:bg-white/10 hover:text-fg">
                    <IconX size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : undefined
        }
      />
    </SettingsGroup>
  )
}
