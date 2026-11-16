import { useStore } from '@nanostores/react'
import { IconAlertTriangle, IconFolder, IconPuzzle, IconRefresh, IconSparkles, IconWorld } from '@tabler/icons-react'
import { useState } from 'react'
import { describePermissions, type PluginView } from '../../../../shared/plugins.ts'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { hostPlatform } from '../../../lib/platform-labels.ts'
import { Spinner } from '../../../components/ui/primitives.tsx'
import { openInDefaultApp } from '../../files/files-store.ts'
import { notify } from '../../../store/notifications.ts'
import { $plugins } from '../../../store/plugins.ts'
import { openAsk } from '../../../store/surface.ts'
import { openApp } from '../../../store/windows.ts'
import { t, useT } from '../../../store/i18n.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'


/*
 * Settings > Plugins: widgets for the menu bar, the Overview and their own windows (ADR-019). Each
 * runs in a sandbox and gets only what its manifest asks for and the person accepted here; new ones
 * arrive turned off.
 */
export function PluginsSection() {
  const t = useT()
  const plugins = useStore($plugins)
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)

  const add = async () => {
    setAdding(true)

    try {
      const added = await window.heraldOS.plugins.add(url.trim())
      setUrl('')
      notify({ title: t("settings.detail.installed.3cf19", { value1: added.manifest.name }), body: t("settings.detail.itIsOffUntilYouTurnItOn.9fffe"), level: 'success' })
    } catch (error) {
      notify({ title: t("settings.detail.couldNotInstallThePlugin.4da10"), body: errorText(error), level: 'error' })
    } finally {
      setAdding(false)
    }
  }

  return (
    <>
      <SectionTitle title={t('settings.section.plugins')} subtitle={t('settings.plugins.subtitle')} />

      <SettingsGroup title={t("settings.detail.installed.f8b32")}>
        {plugins.length === 0 && <SettingsRow icon={<IconPuzzle />} label={t("settings.detail.noPluginsYet.f08ab")} description={t("settings.detail.addOneFromGitBelowOrAskHermes.935ea")} />}
        {plugins.map(plugin => (
          <PluginRow key={plugin.manifest.id} plugin={plugin} />
        ))}
      </SettingsGroup>

      <SettingsGroup title={t("settings.detail.add.9fd72")}>
        <SettingsRow icon={<IconWorld />} label={t("settings.detail.fromGit.5153b")} description={t("settings.detail.installsItTurnedOffYouSeeWhatIt.a28aa")} keywords="install plugin widget git">
          <form
            className="flex items-center gap-2"
            onSubmit={event => {
              event.preventDefault()
              void add()
            }}
          >
            <input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/…/my-widget" aria-label={t("settings.detail.pluginGitURL.459e6")} className="glass-input h-8 w-[260px] rounded-lg px-2.5 text-[12.5px] outline-none" />
            <GlassButton size="sm" type="submit" disabled={adding || !/^(https:\/\/|git@|ssh:\/\/)\S+$/.test(url.trim())}>
              {adding ? <Spinner /> : null} {t("settings.detail.add.9fd72")}</GlassButton>
          </form>
        </SettingsRow>
        <SettingsRow icon={<IconSparkles />} label={t("settings.detail.makeOneWithHermes.ff3cb")} description={t("settings.detail.describeItAStripWithTheWeatherMy.e8c1e")} keywords="create widget hermes">
          <GlassButton size="sm" onClick={() => openAsk({ text: t('settings.plugins.makePrompt') })}>
            {t("settings.detail.makeAWidget.f8944")}</GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconFolder />} label={t("settings.detail.pluginsFolder.dbebc")} description={<span className="font-mono text-[11.5px]">{t(hostPlatform() === 'win32' ? 'settings.plugins.folderWindows' : 'settings.plugins.folderExample')}</span>} keywords="plugin folder files">
          <GlassButton size="sm" variant="ghost" onClick={() => openInDefaultApp('~/.config/herald-os/plugins')}>
            {t("settings.detail.open.ed077")}</GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

function PluginRow({ plugin }: { plugin: PluginView }) {
  useT()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const { manifest } = plugin
  const broken = plugin.errors.length > 0

  const setEnabled = async (enabled: boolean) => {
    setBusy(true)

    try {
      await window.heraldOS.plugins.setEnabled(manifest.id, enabled)
      markSaved()
    } catch (error) {
      notify({ title: t('settings.plugins.toggleFailed', { name: manifest.name }), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const act = async (what: 'update' | 'remove') => {
    setBusy(true)

    try {
      await (what === 'update' ? window.heraldOS.plugins.update(manifest.id) : window.heraldOS.plugins.remove(manifest.id))
      notify({ title: t(what === 'update' ? 'settings.plugins.updated' : 'settings.plugins.removed', { name: manifest.name }), level: 'success' })
    } catch (error) {
      notify({ title: t(what === 'update' ? 'settings.plugins.updateFailed' : 'settings.plugins.removeFailed', { name: manifest.name }), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsRow
      icon={<IconPuzzle />}
      label={`${manifest.name}${manifest.version !== '0.0.0' ? ` ${manifest.version}` : ''}`}
      description={broken ? undefined : manifest.description || t("settings.detail.showsIn.c8dab", { value1: manifest.placement.join(', ') })}
      keywords={`${manifest.id} plugin widget`}
      below={
        broken ? (
          <InlineNote tone="danger">
            <IconAlertTriangle size={13} className="inline" /> {plugin.errors.join('; ')}
          </InlineNote>
        ) : confirming ? (
          <div className="flex flex-col gap-2 rounded-lg border border-line p-3 text-[12.5px] text-fg-2">
            <span className="font-medium text-fg">{t('settings.plugins.confirmEnable', { name: manifest.name })}</span>
            <ul className="list-disc pl-5 text-fg-3">
              {describePermissions(manifest).map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <GlassButton size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                {t("settings.detail.cancel.19766")}</GlassButton>
              <GlassButton size="sm" variant="primary" onClick={() => void setEnabled(true)} disabled={busy}>
                {t("settings.detail.turnOn.5a1f0")}</GlassButton>
            </div>
          </div>
        ) : undefined
      }
    >
      {busy && <Spinner />}
      {plugin.enabled && manifest.placement.includes('panel') && (
        <GlassButton size="sm" variant="ghost" onClick={() => openApp('widget', { payload: { plugin: manifest.id }, title: manifest.name, singleton: false })}>
          {t("settings.detail.open.ed077")}</GlassButton>
      )}
      {plugin.git && (
        <GlassButton size="sm" variant="ghost" onClick={() => void act('update')} aria-label={t("settings.detail.update.a8964", { value1: manifest.name })} disabled={busy}>
          <IconRefresh size={14} />
        </GlassButton>
      )}
      <GlassButton size="sm" variant="ghost" onClick={() => void act('remove')} disabled={busy}>
        {t("settings.detail.remove.c3812")}</GlassButton>
      {!broken && <Pill tone={plugin.enabled ? 'ok' : 'muted'}>{t(plugin.enabled ? 'settings.common.on' : 'settings.common.off')}</Pill>}
      {!broken && <Toggle checked={plugin.enabled} onChange={next => (next ? setConfirming(true) : void setEnabled(false))} label={t("settings.detail.on.9b640", { value1: manifest.name })} />}
    </SettingsRow>
  )
}
