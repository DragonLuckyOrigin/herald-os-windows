import { useStore } from '@nanostores/react'
import { IconBrain, IconEyeOff, IconFolder, IconHash, IconHistory, IconShieldLock, IconTrash, IconX } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, GlassCard, LinkAction, Toggle } from '../../../components/ui/glass.tsx'
import { deviceNoun } from '../../../lib/platform-labels.ts'
import { useLocalData } from '../../../lib/use-async.ts'
import { $env } from '../../../store/backend.ts'
import { $continuity, forgetThreads, setContinuityEnabled, setExclusions } from '../../../store/continuity.ts'
import { notify } from '../../../store/notifications.ts'
import { AuditRow } from './AgentsSection.tsx'
import { t, useT } from '../../../store/i18n.ts'
import { errorText, markSaved, SectionTitle, SettingsBlock, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Privacy: what "Pick up where you left off" may look at, the raw permission policy the Herald OS
 * bridge plugin enforces, and the audit trail. The textarea is the source of truth; the "Ask
 * before sending" toggle in Hermes & agents edits the same file line by line.
 */

function ContinuitySettings() {
  useT()
  const continuity = useStore($continuity)
  const home = useStore($env)?.homeDir ?? ''
  const [word, setWord] = useState('')
  const add = (entries: string[]) => void setExclusions([...continuity.exclude, ...entries])
  const isFolder = (entry: string) => entry.startsWith('/') || entry.startsWith('~')

  const pickFolders = async () => {
    const picked = await window.heraldOS.fs.pickFiles({ directory: true, multiple: true })
    add(picked.map(target => (home && target.startsWith(`${home}/`) ? `~${target.slice(home.length)}` : target)))
  }

  return (
    <SettingsGroup title={t("settings.detail.pickUpWhereYouLeftOff.47173")}>
      <SettingsRow
        icon={<IconBrain />}
        label={t("settings.detail.pickUpWhereYouLeftOff.47173")}
        description={t("settings.detail.whenYouOpenHeraldOSOrComeBack.509bb")}
        keywords="continuity resume catch up brain context recent work suggestions welcome back"
      >
        <Toggle checked={continuity.enabled === true} onChange={enabled => void setContinuityEnabled(enabled)} label={t("settings.detail.pickUpWhereYouLeftOff.47173")} />
      </SettingsRow>
      <SettingsRow
        icon={<IconEyeOff />}
        label={t("settings.detail.neverLookAt.0d43e")}
        description={t("settings.detail.foldersAndWordsHeraldOSLeavesOutA.e9373")}
        keywords="exclude hide private confidential folders words clients"
        below={
          <div className="flex flex-col gap-2.5">
            {continuity.exclude.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {continuity.exclude.map(entry => (
                  <span key={entry} className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-line bg-white/6 pr-1 pl-2.5 text-[12px] text-fg-2">
                    {isFolder(entry) ? <IconFolder size={13} className="shrink-0 text-fg-3" /> : <IconHash size={13} className="shrink-0 text-fg-3" />}
                    <span className="truncate">{entry}</span>
                    <button
                      type="button"
                      aria-label={t("settings.detail.stopLeavingOut.5ebec", { value1: entry })}
                      onClick={() => void setExclusions(continuity.exclude.filter(e => e !== entry))}
                      className="flex size-5 shrink-0 items-center justify-center rounded-full text-fg-4 hover:bg-white/10 hover:text-fg"
                    >
                      <IconX size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <form
              className="flex gap-2"
              onSubmit={event => {
                event.preventDefault()

                if (word.trim()) {
                  add([word.trim()])
                  setWord('')
                }
              }}
            >
              <input
                value={word}
                onChange={event => setWord(event.target.value)}
                placeholder={t("settings.detail.addAWordSuchAsAClientsName.93424")}
                aria-label={t("settings.detail.wordToLeaveOut.5e28f")}
                className="glass-input h-8 min-w-0 flex-1 rounded-lg px-3 text-[12.5px] text-fg outline-none"
              />
              <GlassButton size="sm" type="submit" disabled={!word.trim()}>
                {t("settings.detail.addWord.c4d12")}</GlassButton>
            </form>
          </div>
        }
      >
        <GlassButton size="sm" onClick={() => void pickFolders()}>
          {t("settings.detail.addFolder.fb227")}</GlassButton>
      </SettingsRow>
      <SettingsRow icon={<IconTrash />} label={t("settings.detail.forgetSuggestions.a7f23")} description={t("settings.detail.clearTheThreadsHermesFoundHeraldOSKeeps.12779")} keywords="clear delete reset threads">
        <GlassButton size="sm" variant="ghost" disabled={!continuity.threads?.length} onClick={() => void forgetThreads()}>
          {t("settings.detail.forget.a6bd4")}</GlassButton>
      </SettingsRow>
    </SettingsGroup>
  )
}

export function PrivacySection() {
  const t = useT()
  const policy = useLocalData(() => window.heraldOS.bridge.readPolicy())
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [showAudit, setShowAudit] = useState(false)
  const audit = useLocalData(() => (showAudit ? window.heraldOS.bridge.readAudit(200) : Promise.resolve([])), [showAudit])
  const text = draft ?? policy.data ?? ''
  const dirty = draft !== null && draft !== policy.data

  useEffect(() => {
    setDraft(null)
  }, [policy.data])

  const save = async () => {
    setSaving(true)

    try {
      await window.heraldOS.bridge.writePolicy(text)
      markSaved()
      notify({ title: t("settings.detail.permissionsSaved.d5221"), body: t("settings.detail.theSystemBridgeReadsThePolicyOnIts.7f267"), level: 'success' })
      policy.reload()
    } catch (error) {
      notify({ title: t("settings.detail.couldNotSavePolicy.18b0c"), body: errorText(error), level: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <SectionTitle title={t('settings.section.privacy')} subtitle={t('settings.privacy.subtitle', { device: deviceNoun() })} />

      <ContinuitySettings />

      <SettingsBlock title={t("settings.detail.permissionPolicy.442ba")} label={t("settings.detail.permissionPolicy.442ba")} description={t('settings.privacy.policyHelp')} keywords={`${t('settings.search.privacy')} permissions yaml tiers allow confirm deny bridge`}>
        <GlassCard className="flex flex-col gap-3 p-3.5">
          <div className="text-[12px] leading-snug text-fg-3">
            {t('settings.privacy.policyHelp')}
          </div>
          <textarea
            value={text}
            onChange={event => setDraft(event.target.value)}
            spellCheck={false}
            aria-label={t("settings.detail.permissionPolicy.442ba")}
            className="glass-input min-h-[260px] resize-y rounded-lg p-3 font-mono text-[12px] leading-relaxed text-fg-2 outline-none"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-fg-4">{policy.error ? policy.error : dirty ? t("settings.detail.unsavedChanges.a710c") : t("settings.detail.savedOnDisk.28013")}</span>
            <div className="flex items-center gap-2">
              <GlassButton size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(null)}>
                {t("settings.detail.revert.0026c")}</GlassButton>
              <GlassButton size="sm" variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
                {t("settings.detail.savePolicy.57ee1")}</GlassButton>
            </div>
          </div>
        </GlassCard>
      </SettingsBlock>

      <SettingsGroup title={t("settings.detail.protectedPaths.cf658")}>
        <SettingsRow
          icon={<IconShieldLock />}
          label={t("settings.detail.protectedPaths.cf658")}
          description={t("settings.detail.pathsListedUnderProtectedpathsAreNeverReadWritten.09d41")}
          keywords="secrets config.yaml never touched"
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.detail.audit.bb6ae")}>
        <SettingsRow
          icon={<IconHistory />}
          label={t("settings.detail.auditLog.e4d36")}
          description={t("settings.detail.everyActionTheBridgeTookOrRefusedNewest.e86ee")}
          keywords="history activity"
          below={
            showAudit ? (
              <div className="animate-rise flex max-h-[360px] flex-col overflow-y-auto rounded-lg border border-line bg-black/20">
                {audit.loading && !audit.data?.length && <div className="p-3 text-[12px] text-fg-4">{t("settings.detail.loading.ba3bb")}</div>}
                {!audit.loading && (audit.data?.length ?? 0) === 0 && <div className="p-3 text-[12px] text-fg-4">{t("settings.detail.noBridgeActivityYet.b0b14")}</div>}
                {(audit.data ?? []).map((entry, index) => (
                  <AuditRow key={`${entry.ts}-${index}`} entry={entry} />
                ))}
              </div>
            ) : undefined
          }
        >
          {showAudit && (
            <GlassButton size="sm" variant="ghost" onClick={audit.reload}>
              {t("settings.detail.refresh.0e916")}</GlassButton>
          )}
          <LinkAction onClick={() => setShowAudit(o => !o)}>{showAudit ? t("settings.detail.hideLog.163de") : t("settings.detail.viewLog.ccab9")}</LinkAction>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
