import { t, useT } from '../../../store/i18n.ts'
import { useStore } from '@nanostores/react'
import { IconListSearch } from '@tabler/icons-react'
import { useState } from 'react'
import { Toggle } from '../../../components/ui/glass.tsx'
import { useBackendData } from '../../../lib/use-async.ts'
import { $backend } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { readToolSearch, setToolSearch } from '../../../store/tool-search.ts'
import { errorText, InlineNote, markSaved, SettingsRow } from './shared.tsx'

/*
 * Tool search: Hermes's `tools.tool_search.enabled` (/api/config), one setting for every Hermes
 * session. Herald OS turns it off at setup (ADR-010); this is where it goes back on.
 */

export function ToolSearchRow() {
  useT()
  const setting = useBackendData(readToolSearch)
  const bridgeError = useStore($backend).bridgeError
  const [override, setOverride] = useState<{ base: unknown; on: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const on = override && override.base === setting.data ? override.on : setting.data

  const toggle = async (next: boolean) => {
    setOverride({ base: setting.data, on: next })
    setBusy(true)

    try {
      await setToolSearch(next)
      markSaved()
      notify({ title: next ? t("settings.detail.toolSearchOn.13867") : t("settings.detail.toolSearchOff.26f24"), body: next ? t("settings.detail.hermesLooksPluginAndMCPToolsUpWhen.bb9eb") : t("settings.detail.heraldOSsSystemToolsStayDirectlyCallable.78ceb"), level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: t("settings.detail.couldNotChangeToolSearch.6e4d4"), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      setting.reload()
    }
  }

  return (
    <SettingsRow
      icon={<IconListSearch />}
      label={t("settings.detail.toolSearch.64c0e")}
      description={t("settings.detail.hermesLooksPluginAndMCPToolsUpWhen.f0a9a")}
      keywords="tool search defer plugins mcp system tools bridge prompt tokens"
      below={bridgeError ? <InlineNote tone="danger">{t('settings.tools.bridgeError', { error: bridgeError })}</InlineNote> : undefined}
    >
      <Toggle checked={on ?? false} onChange={next => void toggle(next)} label={t("settings.detail.toolSearch.64c0e")} disabled={busy || on === null || on === undefined} />
    </SettingsRow>
  )
}
