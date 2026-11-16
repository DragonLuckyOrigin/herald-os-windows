import { t as uiT } from './i18n.ts'
import { atom } from 'nanostores'
import type { CrashReport } from '../../shared/ipc.ts'
import { crashPrompt, crashTitle } from '../lib/crash.ts'
import { $prefs, updatePrefs } from './backend.ts'
import { createChat, sendPrompt } from './chat.ts'
import { notify } from './notifications.ts'
import { showPage } from './windows.ts'

/** Crashes seen since Herald OS started, newest first (main keeps the list; this caches it). */
export const $crashes = atom<CrashReport[]>([])

export async function loadCrashes(): Promise<CrashReport[]> {
  const reports = (await window.heraldOS.crash?.recent().catch(() => [])) ?? []
  $crashes.set(reports)

  return reports
}

/** Main saw a crash worth mentioning: offer help, never open anything by itself. */
export function offerCrashHelp(report: CrashReport): void {
  $crashes.set([report, ...$crashes.get().filter(entry => entry.id !== report.id)].slice(0, 20))
  notify({
    title: crashTitle(report),
    body: uiT("ui.8934dbdca63b"),
    level: 'warn',
    key: `crash:${report.app.toLowerCase()}`,
    native: true,
    actions: [
      { label: uiT("ui.b29c6b24c618"), command: 'crash.diagnose', args: { crash: report.id } },
      { label: uiT("ui.8b6c7145aa71", { value1: String(report.app) }), command: 'crash.mute', args: { app: report.app } }
    ]
  })
}

/** Start a chat that hands the crash to Hermes with the diagnose-crash skill. */
export async function diagnoseCrash(report: CrashReport): Promise<string | null> {
  const chat = await createChat({ title: uiT("ui.472fcb9c6d63", { value1: String(report.app) }) })
  showPage('hermes')

  return sendPrompt(crashPrompt(report), { sessionId: chat.sessionId })
}

export async function setCrashMuted(app: string, muted: boolean): Promise<string[]> {
  const current = $prefs.get().crashHelp
  const others = current.muted.filter(entry => entry.toLowerCase() !== app.toLowerCase())
  const next = muted ? [...others, app] : others
  await updatePrefs({ crashHelp: { ...current, muted: next } })

  return next
}

export async function setCrashHelpEnabled(enabled: boolean): Promise<void> {
  await updatePrefs({ crashHelp: { ...$prefs.get().crashHelp, enabled } })
}
