import type { ContinuityThread } from '../../shared/ipc.ts'
import { findThread } from '../lib/continuity.ts'
import { $catchUp, $continuity, $threads, continueThread, refreshThreads, startNextStep } from '../store/continuity.ts'
import { t } from '../store/i18n.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { showPage } from '../store/windows.ts'

/* "Pick up where you left off": catch up, then resume a thread or start its next step. */

const threadArg = { name: 'thread', type: 'string', description: 'Which thread: words from its title, or first / second / third (default: the first)' } as const

function threadOrFail(query: unknown): ContinuityThread | string {
  const threads = $threads.get()

  if (!threads.length) {
    return t('commands.msg.continuity.nothing')
  }

  const ordinal = String(query ?? '').trim().toLowerCase().replace(/^(der|die|das|den)\s+/, '').replace(/\s+(unterhaltung|gespräch|eintrag)$/, '')
  const germanOrdinals: Record<string, string> = { erste: 'first', ersten: 'first', erstes: 'first', zweite: 'second', zweiten: 'second', zweites: 'second', dritte: 'third', dritten: 'third', drittes: 'third' }

  return findThread(threads, germanOrdinals[ordinal] ?? query) ?? t('commands.msg.continuity.noThread', { query: String(query), threads: threads.map(thread => thread.title).join('; ') })
}

export const continuityCommands: readonly OsCommand[] = [
  {
    id: 'continuity.catchUp',
    title: 'Pick up where I left off',
    description: 'Look at recent documents, projects, chats and the calendar, and suggest where to continue.',
    tier: 'read',
    args: [],
    phrases: ['what was I doing', 'where did I leave off', 'pick up where I left off', 'catch me up', 'what should I continue'],
    phrasesDe: ['was habe ich gemacht', 'was habe ich zuletzt gemacht', 'wo war ich stehen geblieben', 'wo habe ich aufgehört', 'bring mich auf den neuesten stand', 'was sollte ich weitermachen'],
    run: async () => {
      if ($continuity.get().enabled !== true) {
        return fail(t('commands.msg.continuity.off'), { page: 'overview' })
      }

      showPage('overview')
      const threads = await refreshThreads({ force: true })
      const status = $catchUp.get()

      if (status.phase === 'error') {
        return fail(status.message, { page: 'overview' })
      }

      if (!threads.length) {
        return ok(t('commands.msg.continuity.empty'), { page: 'overview' })
      }

      return ok(t('commands.msg.continuity.canPickUp', { threads: threads.map(thread => thread.title).join('; ') }), {
        page: 'overview',
        items: threads.map(thread => ({ id: thread.id, title: thread.title, summary: thread.summary, stopped: thread.stopped, next: thread.next?.label }))
      })
    }
  },
  {
    id: 'continuity.continue',
    title: 'Continue where I left off',
    description: "Reopen a thread's conversation, folder and documents.",
    tier: 'act',
    args: [threadArg],
    phrases: ['continue where I left off', 'continue {thread}', 'reopen {thread}'],
    phrasesDe: ['mach weiter wo ich aufgehört habe', 'mach da weiter wo ich aufgehört habe', 'mache dort weiter wo ich aufgehört habe', 'mach mit {thread} weiter', 'öffne {thread} erneut', 'setze {thread} fort'],
    run: async args => {
      const thread = threadOrFail(args.thread)

      if (typeof thread === 'string') {
        return fail(thread)
      }

      await continueThread(thread)

      return ok(t('commands.msg.continuity.reopened', { title: thread.title }))
    }
  },
  {
    id: 'continuity.nextStep',
    title: 'Do the suggested next step',
    description: 'Start the next step Hermes suggested for a thread, in its own conversation when it has one.',
    tier: 'act',
    args: [threadArg],
    phrases: ['do the next step', 'start the next step', 'next step for {thread}'],
    phrasesDe: ['mache den nächsten schritt', 'führe den nächsten schritt aus', 'starte den nächsten schritt', 'nächster schritt für {thread}'],
    run: async args => {
      const thread = threadOrFail(args.thread)

      if (typeof thread === 'string') {
        return fail(thread)
      }

      if (!thread.next) {
        return fail(t('commands.msg.continuity.noNext', { title: thread.title }))
      }

      await startNextStep(thread)

      return ok(t('commands.msg.continuity.startedStep', { label: thread.next.label }), { page: 'hermes' })
    }
  }
]
