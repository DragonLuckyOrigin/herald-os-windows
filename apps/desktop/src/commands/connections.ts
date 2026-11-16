import { findConnection, setConnectionEnabled } from '../store/connections-actions.ts'
import { t } from '../store/i18n.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { showPage } from '../store/windows.ts'
import { loadConnections } from '../features/connections/connections-model.ts'

const statusKeys = { connected: 'commands.result.connection.connected', 'needs-auth': 'commands.result.connection.needsAuth', error: 'commands.result.connection.error', disabled: 'commands.result.connection.disabled', available: 'commands.result.connection.available' } as const

/* Connections: MCP servers, messaging platforms, toolsets, provider sign-ins. */

export const connectionCommands: readonly OsCommand[] = [
  {
    id: 'connection.list',
    title: 'List connections',
    description: 'Open Connections and list what is connected.',
    tier: 'read',
    args: [],
    phrases: ['show my connections', 'list connections', 'what is connected', 'show integrations'],
    phrasesDe: ['zeige meine verbindungen', 'liste die verbindungen auf', 'was ist verbunden', 'zeige integrationen'],
    run: async () => {
      showPage('connections')
      const { connections } = await loadConnections()
      const connected = connections.filter(c => c.status === 'connected')

      return ok(t('commands.msg.connections.count', { count: connections.length, connected: connected.length }), {
        page: 'connections',
        spoken: connected.length ? t('commands.msg.connections.spoken', { count: connected.length, names: connected.slice(0, 5).map(c => c.name).join(', ') }) : t('commands.msg.connections.none'),
        items: connections.map(c => ({ id: c.id, name: c.name, kind: c.kind, status: t(statusKeys[c.status]), scope: c.scope }))
      })
    }
  },
  {
    id: 'connection.show',
    title: 'Show a connection',
    description: 'Open Connections focused on one integration.',
    tier: 'read',
    args: [{ name: 'name', type: 'string', description: 'Connection name', required: true }],
    phrases: ['show the {name} connection', 'open {name} connection'],
    phrasesDe: ['zeige die verbindung {name}', 'öffne die verbindung {name}'],
    run: async ({ name }) => {
      const { connection, candidates } = await findConnection(String(name))

      if (!connection) {
        return candidates.length ? fail(t('commands.msg.connections.which', { names: candidates.map(c => c.name).slice(0, 5).join(', ') })) : fail(t('commands.msg.connections.noMatch', { name: String(name) }))
      }

      showPage('connections')

      return ok(t('commands.msg.connections.statusLine', { name: connection.name, status: t(statusKeys[connection.status]) }), { page: 'connections', highlight: { kind: 'connection', id: connection.id }, data: { id: connection.id, status: connection.status, tools: connection.tools.map(tool => tool.label) } })
    }
  },
  {
    id: 'connection.enable',
    title: 'Enable a connection',
    description: 'Turn a connection on.',
    tier: 'mutate',
    args: [{ name: 'name', type: 'string', description: 'Connection name', required: true }],
    phrases: ['enable {name}', 'turn on {name}', 'connect {name}'],
    phrasesDe: ['aktiviere {name}', 'schalte {name} ein', 'verbinde {name}'],
    run: async ({ name }) => {
      const { connection, candidates } = await findConnection(String(name))

      if (!connection) {
        return candidates.length ? fail(t('commands.msg.connections.which', { names: candidates.map(c => c.name).slice(0, 5).join(', ') })) : fail(t('commands.msg.connections.noMatch', { name: String(name) }))
      }

      await setConnectionEnabled(connection, true)
      showPage('connections')

      return ok(t('commands.msg.connections.enabled', { name: connection.name }), { page: 'connections', highlight: { kind: 'connection', id: connection.id } })
    }
  },
  {
    id: 'connection.disable',
    title: 'Disable a connection',
    description: 'Turn a connection off (credentials are kept).',
    tier: 'mutate',
    args: [{ name: 'name', type: 'string', description: 'Connection name', required: true }],
    phrases: ['disable {name}', 'turn off {name}', 'disconnect {name}'],
    phrasesDe: ['deaktiviere {name}', 'schalte {name} aus', 'trenne {name}'],
    run: async ({ name }) => {
      const { connection, candidates } = await findConnection(String(name))

      if (!connection) {
        return candidates.length ? fail(t('commands.msg.connections.which', { names: candidates.map(c => c.name).slice(0, 5).join(', ') })) : fail(t('commands.msg.connections.noMatch', { name: String(name) }))
      }

      await setConnectionEnabled(connection, false)
      showPage('connections')

      return ok(t('commands.msg.connections.disabled', { name: connection.name }), { page: 'connections', highlight: { kind: 'connection', id: connection.id } })
    }
  }
]
