import type { TextKey } from '../../../../shared/i18n.ts'
import { useStore } from '@nanostores/react'
import { IconBrandSlack, IconPlugConnected, IconServer, IconTerminal2, IconWifi } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill, type PillTone, Toggle } from '../../../components/ui/glass.tsx'
import { logFailure } from '../../../lib/report.ts'
import { type HermesStatusPayload, rest } from '../../../lib/rest.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { $backend } from '../../../store/backend.ts'
import { $connection } from '../../../store/gateway.ts'
import { notify } from '../../../store/notifications.ts'
import { t, useT } from '../../../store/i18n.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

interface McpServerRow {
  name: string
  transport?: string
  url?: string | null
  command?: string | null
  enabled?: boolean
  [key: string]: unknown
}

const STATE_LABELS: Record<string, TextKey> = {
  idle: 'settings.network.state.idle',
  resolving: 'settings.network.state.resolving',
  waiting: 'settings.network.state.waiting',
  starting: 'settings.network.state.starting',
  ready: 'settings.network.state.ready',
  restarting: 'settings.network.state.restarting',
  failed: 'settings.network.state.failed',
  stopped: 'settings.network.state.stopped',
  open: 'settings.network.state.open',
  connecting: 'settings.network.state.connecting',
  closed: 'settings.network.state.closed',
  error: 'settings.network.state.error',
  env: 'settings.network.state.env',
  managed: 'settings.network.state.managed',
  path: 'settings.network.state.path',
  attached: 'settings.network.state.attached'
}

const phaseTone = (phase: string): PillTone => (phase === 'ready' ? 'ok' : phase === 'failed' ? 'danger' : phase === 'stopped' || phase === 'idle' ? 'muted' : 'warn')

export function NetworkSection() {
  const t = useT()
  const backend = useStore($backend)
  const connection = useStore($connection)

  return (
    <>
      <SectionTitle title={t('settings.section.network')} subtitle={t('settings.network.subtitle')} />

      <SettingsGroup title={t("settings.detail.hermesRuntime.d6e72")}>
        <SettingsRow icon={<IconServer />} label="Backend" description={<span className="selectable font-mono text-[11.5px]">{backend.baseUrl ?? t("settings.detail.notRunning.415ed")}</span>} keywords="hermes runtime server status">
          <Pill tone={phaseTone(backend.phase)} dot>
            {t(STATE_LABELS[backend.phase])}
          </Pill>
          <GlassButton size="sm" variant="ghost" onClick={() => void window.heraldOS.backend.restart().catch(logFailure('backend.restart'))} aria-label={t("settings.detail.restartHermes.b69e7")}>
            {t("settings.detail.restart.6b983")}</GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconPlugConnected />} label={t("settings.detail.gatewaySocket.6a150")} description={t("settings.detail.jsonrpcOverWebSocket.45f9c")} keywords="websocket connection">
          <Pill tone={connection === 'open' ? 'ok' : connection === 'error' ? 'danger' : 'warn'} dot>
            {t(STATE_LABELS[connection])}
          </Pill>
        </SettingsRow>
        <SettingsRow
          icon={<IconTerminal2 />}
          label={t("settings.detail.runtimeCommand.2c572")}
          description={<span className="selectable font-mono text-[11.5px]">{backend.runtime?.kind === 'attached' ? t("settings.detail.usingHERALDOSBACKENDURL.f140f", { value1: backend.runtime.label }) : backend.runtime ? backend.runtime.command.join(' ') : '—'}</span>}
          keywords="hermes command path managed attached shared"
        >
          {backend.runtime && <Pill>{t(STATE_LABELS[backend.runtime.kind])}</Pill>}
        </SettingsRow>
        {backend.sharedGateway && (
          <InlineNote tone="info">
            {t('settings.network.sharedGateway', { pid: String(backend.sharedGateway) })}</InlineNote>
        )}
        {backend.runtime?.kind === 'attached' && backend.localFiles === false && (
          <InlineNote tone="info">
            {t("settings.detail.thisHermesDidNotReadAFileHerald.29101")}</InlineNote>
        )}
      </SettingsGroup>

      <McpServersGroup />
      <PlatformsGroup />
    </>
  )
}

function McpServersGroup() {
  useT()
  const servers = useBackendData(() => rest.get<{ servers: McpServerRow[] }>('/api/mcp/servers'))
  const [override, setOverride] = useState<{ base: unknown; name: string; enabled: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const rows = servers.data?.servers ?? []

  const toggle = async (row: McpServerRow, enabled: boolean) => {
    setOverride({ base: servers.data, name: row.name, enabled })
    setBusy(row.name)

    try {
      await rest.put(`/api/mcp/servers/${encodeURIComponent(row.name)}/enabled`, { enabled })
      markSaved()
      notify({ title: enabled ? t("settings.detail.mcpServerEnabled.28110") : t("settings.detail.mcpServerDisabled.60f07"), body: t("settings.detail.takesEffectOnTheNextSession.c269c", { value1: row.name }), level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: t("settings.detail.couldNotUpdateMCPServer.057a9"), body: errorText(error), level: 'error' })
    } finally {
      setBusy(null)
      servers.reload()
    }
  }

  return (
    <SettingsGroup title={t("settings.detail.mcpServers.22a75")}>
      {rows.length === 0 && (
        <SettingsRow icon={<IconWifi />} label={t("settings.detail.mcpServers.22a75")} description={servers.loading ? t("settings.detail.loading.ba3bb") : servers.error ? servers.error : t("settings.detail.noMCPServersConfiguredAddThemInConnections.38bde")} keywords="mcp model context protocol" />
      )}
      {rows.map(row => {
        const enabled = override && override.base === servers.data && override.name === row.name ? override.enabled : row.enabled !== false
        const target = row.url ?? (row.command ? [row.command, ...((row.args as string[] | undefined) ?? [])].join(' ') : '')

        return (
          <SettingsRow key={row.name} icon={<IconWifi />} label={row.name} description={<span className="selectable font-mono text-[11.5px]">{target || row.transport || t('settings.detail.mcpServers.22a75')}</span>} keywords="mcp server">
            {row.transport && <Pill>{row.transport}</Pill>}
            <Toggle checked={enabled} onChange={next => void toggle(row, next)} label={t("settings.detail.enable.3fbe6", { value1: row.name })} disabled={busy === row.name} />
          </SettingsRow>
        )
      })}
    </SettingsGroup>
  )
}

type PlatformState = { state?: string; status?: string; [key: string]: unknown } | string

function platformTone(value: PlatformState): PillTone {
  const state = String(typeof value === 'string' ? value : (value.state ?? value.status ?? '')).toLowerCase()

  if (['connected', 'running', 'ok'].includes(state)) {
    return 'ok'
  }

  if (['fatal', 'error', 'failed'].includes(state)) {
    return 'danger'
  }

  if (!state) {
    return 'muted'
  }

  return 'warn'
}

function PlatformsGroup() {
  useT()
  const status = useBackendData(() => rest.get<HermesStatusPayload & { gateway_platforms?: Record<string, PlatformState>; platforms?: Record<string, PlatformState> | PlatformState[] }>('/api/status'))
  const raw = status.data?.gateway_platforms ?? status.data?.platforms
  const entries: [string, PlatformState][] = Array.isArray(raw) ? raw.map((item, index) => [typeof item === 'string' ? item : String(item.name ?? item.id ?? index), item]) : Object.entries(raw ?? {})

  return (
    <SettingsGroup title={t("settings.detail.messagingPlatforms.0155d")}>
      {entries.length === 0 && <SettingsRow icon={<IconBrandSlack />} label={t("settings.detail.messagingPlatforms.0155d")} description={status.loading ? t("settings.detail.loading.ba3bb") : t("settings.detail.noMessagingPlatformsConnectedToTheHermesGateway.efbea")} keywords="telegram discord slack whatsapp" />}
      {entries.map(([name, value]) => {
        const state = typeof value === 'string' ? value : String(value.state ?? value.status ?? 'unknown')

        return (
          <SettingsRow key={name} icon={<IconBrandSlack />} label={name} description={t("settings.detail.connectedToTheHermesGateway.18b7b")} keywords="messaging platform">
            <Pill tone={platformTone(value)} dot>
              {state}
            </Pill>
          </SettingsRow>
        )
      })}
    </SettingsGroup>
  )
}
