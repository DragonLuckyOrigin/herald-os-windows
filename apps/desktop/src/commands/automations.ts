import { describeRule, eventLabel, HERALD_EVENTS, isEventName } from '../../shared/events.ts'
import type { CronJob } from '../lib/rest.ts'
import { automationEnabled, createAutomation, createEventAutomation, deleteAutomation, eventRuleFor, findAutomation, listAutomations, setAutomationEnabled, triggerAutomation } from '../store/automations.ts'
import { t } from '../store/i18n.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { showPage } from '../store/windows.ts'
import { humanizeSchedule } from '../features/automations/cron-humanize.ts'

/* Automations (Hermes cron jobs, some fired by events instead of their schedule). */

const summarise = (job: CronJob) => {
  const rule = eventRuleFor(job.id)

  return { id: job.id, name: job.name, schedule: rule ? describeRule(rule) : humanizeSchedule(job), event: rule?.event ?? null, paused: !automationEnabled(job), nextRun: rule ? null : (job.next_run_at ?? null), lastStatus: job.last_status ?? null }
}

async function pick(name: string) {
  const { job, candidates } = await findAutomation(name)

  if (!job) {
    return { job: null, result: candidates.length ? fail(t('commands.msg.automations.which', { names: candidates.map(j => j.name || j.id).slice(0, 5).join(', ') }), { items: candidates.map(summarise) }) : fail(t('commands.msg.automations.noMatch', { name })) }
  }

  return { job, result: null }
}

export const automationCommands: readonly OsCommand[] = [
  {
    id: 'automation.list',
    title: 'List automations',
    description: 'Open Automations and list the scheduled jobs.',
    tier: 'read',
    args: [],
    phrases: ['show my automations', 'list automations', 'what automations do i have', 'show scheduled tasks', 'what is scheduled'],
    phrasesDe: ['zeige meine automatisierungen', 'liste die automatisierungen auf', 'welche automatisierungen habe ich', 'zeige geplante aufgaben', 'was ist geplant'],
    run: async () => {
      showPage('automations')
      const jobs = await listAutomations()
      const active = jobs.filter(job => automationEnabled(job))

      return ok(t('commands.msg.automations.count', { count: jobs.length, active: active.length }), {
        page: 'automations',
        spoken: jobs.length ? t('commands.msg.automations.spoken', { count: jobs.length, active: active.length, names: jobs.slice(0, 4).map(j => j.name || t('commands.msg.automations.unnamed')).join(', ') }) : t('commands.msg.automations.none'),
        items: jobs.map(summarise)
      })
    }
  },
  {
    id: 'automation.show',
    title: 'Show an automation',
    description: 'Open Automations focused on one job.',
    tier: 'read',
    args: [{ name: 'name', type: 'string', description: 'Part of the automation name', required: true }],
    phrases: ['show the {name} automation', 'open the {name} automation'],
    phrasesDe: ['zeige die automatisierung {name}', 'öffne die automatisierung {name}'],
    run: async ({ name }) => {
      const { job, result } = await pick(String(name))

      if (!job) {
        return result!
      }

      showPage('automations')

      const summary = summarise(job)

      return ok(t(summary.paused ? 'commands.msg.automations.showLineOff' : 'commands.msg.automations.showLine', { name: job.name ?? job.id, schedule: summary.schedule }), { page: 'automations', highlight: { kind: 'automation', id: job.id }, data: summary })
    }
  },
  {
    id: 'automation.run',
    title: 'Run an automation now',
    description: 'Trigger a scheduled job immediately.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Part of the automation name', required: true }],
    phrases: ['run the {name} automation now', 'run {name} now', 'trigger {name}'],
    phrasesDe: ['führe die automatisierung {name} jetzt aus', 'führe {name} jetzt aus', 'starte die automatisierung {name}', 'löse {name} aus'],
    run: async ({ name }) => {
      const { job, result } = await pick(String(name))

      if (!job) {
        return result!
      }

      await triggerAutomation(job)
      showPage('automations')

      return ok(t('commands.msg.automations.started', { name: job.name ?? job.id }), { spoken: t('commands.msg.automations.running', { name: job.name ?? job.id }), page: 'automations', highlight: { kind: 'automation', id: job.id } })
    }
  },
  {
    id: 'automation.pause',
    title: 'Pause an automation',
    description: 'Pause a scheduled job.',
    tier: 'mutate',
    args: [{ name: 'name', type: 'string', description: 'Part of the automation name', required: true }],
    phrases: ['pause the {name} automation', 'pause {name}', 'disable the {name} automation'],
    phrasesDe: ['pausiere die automatisierung {name}', 'deaktiviere die automatisierung {name}', 'halte die automatisierung {name} an'],
    run: async ({ name }) => {
      const { job, result } = await pick(String(name))

      if (!job) {
        return result!
      }

      await setAutomationEnabled(job, false)
      showPage('automations')

      return ok(t('commands.msg.automations.paused', { name: job.name ?? job.id }), { page: 'automations', highlight: { kind: 'automation', id: job.id } })
    }
  },
  {
    id: 'automation.resume',
    title: 'Resume an automation',
    description: 'Resume a paused job.',
    tier: 'mutate',
    args: [{ name: 'name', type: 'string', description: 'Part of the automation name', required: true }],
    phrases: ['resume the {name} automation', 'resume {name}', 'enable the {name} automation', 'unpause {name}'],
    phrasesDe: ['setze die automatisierung {name} fort', 'aktiviere die automatisierung {name}', 'nimm die automatisierung {name} wieder auf'],
    run: async ({ name }) => {
      const { job, result } = await pick(String(name))

      if (!job) {
        return result!
      }

      await setAutomationEnabled(job, true)
      showPage('automations')

      return ok(t('commands.msg.automations.resumed', { name: job.name ?? job.id }), { page: 'automations', highlight: { kind: 'automation', id: job.id } })
    }
  },
  {
    id: 'automation.create',
    title: 'Create an automation',
    description:
      'Make Hermes run a prompt on a schedule (`schedule`: natural like "every day at 9am", "weekdays at 8:00", or cron) or each time something happens on this computer (`event`: login, wake, unlock, returned, battery-low, network-change, crash, theme-set, after-update; `match` narrows it, e.g. a program name for crash or a Wi-Fi network for network-change).',
    tier: 'mutate',
    args: [
      { name: 'name', type: 'string', description: 'Short name', required: true },
      { name: 'prompt', type: 'string', description: 'What Hermes should do each run', required: true },
      { name: 'schedule', type: 'string', description: 'When it runs (or give event)' },
      { name: 'event', type: 'string', description: 'Run each time this happens instead of on a schedule', enum: ['', ...HERALD_EVENTS.filter(event => event.automation).map(event => event.name)] },
      { name: 'match', type: 'string', description: 'For event: the program (crash) or Wi-Fi network (network-change) it is about' }
    ],
    run: async ({ name, schedule, prompt, event, match }) => {
      if (event && isEventName(event)) {
        const key = event === 'crash' ? 'app' : event === 'network-change' ? 'wifi' : null
        const created = await createEventAutomation({ name: String(name), prompt: String(prompt), deliver: 'local' }, event, key && match ? { [key]: String(match) } : undefined)
        showPage('automations')

        const summary = match
          ? t('commands.msg.automations.createdEventMatch', { name: created.name ?? String(name), event: eventLabel(event).toLowerCase(), match: String(match) })
          : t('commands.msg.automations.createdEvent', { name: created.name ?? String(name), event: eventLabel(event).toLowerCase() })

        return ok(summary, { page: 'automations', highlight: { kind: 'automation', id: created.id }, data: summarise(created) })
      }

      if (!schedule) {
        return fail(t('commands.msg.automations.needWhen'))
      }

      const created = await createAutomation({ name: String(name), schedule: String(schedule), prompt: String(prompt), deliver: 'local' })
      showPage('automations')

      return ok(t('commands.msg.automations.created', { name: created.name ?? String(name), schedule: humanizeSchedule(created) }), { page: 'automations', highlight: { kind: 'automation', id: created.id }, data: summarise(created) })
    }
  },
  {
    id: 'automation.delete',
    title: 'Delete an automation',
    description: 'Delete a scheduled job permanently.',
    tier: 'destructive',
    args: [{ name: 'name', type: 'string', description: 'Part of the automation name', required: true }],
    phrases: ['delete the {name} automation', 'remove the {name} automation'],
    phrasesDe: ['lösche die automatisierung {name}', 'entferne die automatisierung {name}'],
    run: async ({ name }) => {
      const { job, result } = await pick(String(name))

      if (!job) {
        return result!
      }

      await deleteAutomation(job)
      showPage('automations')

      return ok(t('commands.msg.automations.deleted', { name: job.name ?? job.id }), { page: 'automations' })
    }
  }
]
