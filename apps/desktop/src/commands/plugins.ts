import { focusSettings } from '../features/settings/sections/shared.tsx'
import { t } from '../store/i18n.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { $plugins } from '../store/plugins.ts'
import { openApp, showPage } from '../store/windows.ts'

/* Widget plugins (ADR-019). Turning one on stays in Settings > Plugins, where the person reads what it asks for. */

function findPlugin(name: unknown) {
  const needle = String(name ?? '').trim().toLowerCase()

  return $plugins.get().find(plugin => plugin.manifest.id === needle || plugin.manifest.name.toLowerCase() === needle) ?? null
}

export const pluginCommands: readonly OsCommand[] = [
  {
    id: 'plugin.list',
    title: 'Plugins',
    description: 'The widget plugins installed (menu bar, Overview, their own windows), which are on, and what each may do.',
    tier: 'read',
    args: [],
    run: async () => {
      const plugins = await window.heraldOS.plugins.list()
      $plugins.set(plugins)

      return ok(plugins.length ? plugins.map(plugin => t(plugin.enabled ? 'commands.msg.plugins.entryOn' : 'commands.msg.plugins.entryOff', { name: plugin.manifest.name })).join(', ') : t('commands.msg.plugins.none'), {
        data: { plugins: plugins.map(plugin => ({ id: plugin.manifest.id, name: plugin.manifest.name, enabled: plugin.enabled, placement: plugin.manifest.placement, permissions: plugin.manifest.permissions, hosts: plugin.manifest.hosts, errors: plugin.errors })) },
        highlight: { kind: 'setting', id: 'plugins' }
      })
    }
  },
  {
    id: 'plugin.open',
    title: 'Open a widget',
    description: 'Open a widget plugin in its own window (for plugins whose placement includes panel).',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Plugin id or name', required: true }],
    run: async ({ name }) => {
      const plugin = findPlugin(name)

      if (!plugin) {
        return fail(t('commands.msg.plugins.noPlugin', { name: String(name) }))
      }

      if (!plugin.enabled) {
        return fail(t('commands.msg.plugins.isOff', { name: plugin.manifest.name }))
      }

      if (!plugin.manifest.placement.includes('panel')) {
        return fail(t('commands.msg.plugins.notInWindow', { name: plugin.manifest.name, placement: plugin.manifest.placement.join(t('commands.msg.plugins.and')) }))
      }

      openApp('widget', { payload: { plugin: plugin.manifest.id }, title: plugin.manifest.name, singleton: false })

      return ok(t('commands.msg.plugins.opened', { name: plugin.manifest.name }))
    }
  },
  {
    id: 'plugin.manage',
    title: 'Manage plugins',
    description: 'Show Settings > Plugins, where plugins are turned on (after reading what they ask for), updated and removed.',
    tier: 'read',
    args: [],
    phrases: ['manage plugins', 'show my widgets'],
    phrasesDe: ['verwalte plugins', 'plugins verwalten', 'zeige meine widgets'],
    run: async () => {
      showPage('settings')
      focusSettings({ section: 'plugins' })

      return ok(t('commands.msg.plugins.settingsOpen'), { highlight: { kind: 'setting', id: 'plugins' } })
    }
  },
  {
    id: 'plugin.add',
    title: 'Install a plugin',
    description: 'Install a widget plugin from a git URL. It arrives turned off; the person turns it on in Settings > Plugins.',
    tier: 'mutate',
    args: [{ name: 'url', type: 'string', description: 'https or ssh git URL', required: true }],
    run: async ({ url }) => {
      const added = await window.heraldOS.plugins.add(String(url))

      return ok(t('commands.msg.plugins.installed', { name: added.manifest.name }), { highlight: { kind: 'setting', id: 'plugins' } })
    }
  }
]
