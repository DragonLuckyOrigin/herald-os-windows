import { modelErrorText } from '../store/model-provider.ts'
import { t } from '../store/i18n.ts'
import { $catalog, catalogEntries, findCatalogEntry, loadCatalog, runCatalog, useWithHermes } from '../store/catalog.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { openTerminalProgram } from '../store/terminal.ts'

/* The install catalog: coding agents, local models, languages, editors, games, Windows, web apps. */

async function entryFor(name: unknown) {
  if (!$catalog.get().loaded) {
    await loadCatalog()
  }

  return findCatalogEntry(String(name ?? ''))
}

export const softwareCommands: readonly OsCommand[] = [
  {
    id: 'software.list',
    title: 'Software catalog',
    description: 'What the install catalog offers and what is installed: coding agents, local models, languages, editors, terminals, games, the Windows VM, media apps, services and web apps.',
    tier: 'read',
    args: [],
    run: async () => {
      await loadCatalog()
      const entries = catalogEntries()
      const installed = entries.filter(entry => entry.installed).map(entry => entry.label)

      return ok(installed.length ? t('commands.result.software.list', { count: installed.length, total: entries.length, names: installed.join(', ') }) : t('commands.result.software.empty', { count: entries.length }), {
        data: { groups: $catalog.get().groups.map(group => ({ group: group.label, entries: group.entries.map(entry => `${entry.id}: ${entry.label} (${entry.installed ? 'installed' : entry.available ? 'available' : entry.reason})`) })) },
        highlight: { kind: 'setting', id: 'software' }
      })
    }
  },
  {
    id: 'software.install',
    title: 'Install software',
    description: 'Install something from the catalog by id or name (claude-code, node, zed, steam, windows, discord…), the right way for this machine.',
    tier: 'mutate',
    args: [{ name: 'name', type: 'string', description: 'Catalog id or name', required: true }],
    phrases: ['install {name}', 'get me {name}'],
    phrasesDe: ["installiere {name}","besorge mir {name}"],
    run: async ({ name }) => {
      const entry = await entryFor(name)

      if (!entry) {
        return fail(t('commands.result.software.missing', { name: String(name) }))
      }

      if (entry.installed) {
        return ok(t('commands.result.software.already', { name: entry.label }))
      }

      if (!entry.available) {
        return fail(t('commands.result.software.unavailable', { name: entry.label, reason: entry.reason ?? t('commands.result.software.wrongComputer') }))
      }

      return (await runCatalog(entry.id, 'install')) ? ok(entry.method === 'link' ? t('commands.result.software.download', { name: entry.label }) : t('commands.result.software.installed', { name: entry.label })) : fail(t('commands.result.software.installFailed', { name: entry.label }))
    }
  },
  {
    id: 'software.remove',
    title: 'Remove software',
    description: 'Remove something that was installed from the catalog.',
    tier: 'destructive',
    args: [{ name: 'name', type: 'string', description: 'Catalog id or name', required: true }],
    phrases: ['uninstall {name}', 'remove {name}'],
    phrasesDe: ["deinstalliere {name}","entferne {name}"],
    run: async ({ name }) => {
      const entry = await entryFor(name)

      if (!entry?.installed) {
        return fail(entry ? t('commands.result.software.notInstalled', { name: entry.label }) : t('commands.result.software.notCatalog', { name: String(name) }))
      }

      if (!entry.removable) {
        return fail(t('commands.result.software.noRemoval', { name: entry.label }))
      }

      return (await runCatalog(entry.id, 'remove')) ? ok(t('commands.result.software.removed', { name: entry.label })) : fail(t('commands.result.software.removeFailed', { name: entry.label }))
    }
  },
  {
    id: 'software.agent',
    title: 'Open a coding agent',
    description: 'Open an installed coding agent (Claude Code, Codex, OpenCode, Gemini CLI, Copilot CLI) in a new Terminal tab.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'The agent: claude-code, codex, opencode, gemini-cli or copilot-cli', required: true }],
    phrases: ['open {name} in the terminal', 'start {name}'],
    phrasesDe: ["öffne {name} im terminal","starte den coding agenten {name}"],
    run: async ({ name }) => {
      const entry = await entryFor(name)

      if (!entry?.terminal) {
        return fail(t('commands.result.software.notAgent', { name: String(name) }))
      }

      if (!entry.installed) {
        return fail(t('commands.result.software.agentMissing', { name: entry.label }))
      }

      openTerminalProgram(entry.id, entry.label)

      return ok(t('commands.result.software.starting', { name: entry.label }))
    }
  },
  {
    id: 'software.localModel',
    title: 'Use a local model',
    description: 'Point Hermes at a model running on this computer through Ollama or LM Studio. Without a model, lists the ones the server has.',
    tier: 'mutate',
    args: [
      { name: 'server', type: 'string', description: 'ollama or lmstudio', required: true, enum: ['ollama', 'lmstudio'] },
      { name: 'model', type: 'string', description: 'The model name as the server lists it' }
    ],
    run: async ({ server, model }) => {
      const kind = server === 'lmstudio' ? 'lmstudio' : 'ollama'
      let models: string[]
      try {
        models = [...new Set(await window.heraldOS.catalog.localModels(kind))]
      } catch {
        return fail(t('commands.result.software.modelsReadFailed'))
      }
      try {
        if (!model) {
          return ok(t('commands.result.software.models', { server: kind === 'ollama' ? 'Ollama' : 'LM Studio', models: models.join(', ') }), { data: { models } })
        }

        const query = String(model).toLowerCase()
        const literal = models.filter(name => name === model)
        const exact = literal.length ? literal : models.filter(name => name.toLowerCase() === query)
        const matches = exact.length ? exact : models.filter(name => name.toLowerCase().startsWith(query))
        if (matches.length > 1) {
          return fail(t('commands.result.software.ambiguousModel', { model: String(model), models: matches.join(', ') }))
        }
        const chosen = matches[0]

        if (!chosen) {
          return fail(t('commands.result.software.noModel', { model: String(model), models: models.join(', ') }))
        }

        await useWithHermes(kind, chosen)

        return ok(t('commands.result.software.using', { model: chosen }))
      } catch (error) {
        return fail(modelErrorText(error))
      }
    }
  }
]
