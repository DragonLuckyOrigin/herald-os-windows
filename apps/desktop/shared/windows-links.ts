import type { StatusPanelId } from './ipc.ts'

/** Exact native destinations only: no parameters, account changes or system commands. */
export const WINDOWS_SETTINGS = {
  wifi: 'ms-settings:network',
  bluetooth: 'ms-settings:bluetooth',
  audio: 'ms-settings:sound',
  display: 'ms-settings:display',
  power: 'ms-settings:powersleep'
} as const satisfies Record<Exclude<StatusPanelId, 'clock'>, string>

export const WINDOWS_CALENDAR_URL = 'ms-outlook:launch:calendar'

export function isWindowsSystemUrl(url: string): boolean {
  return url === WINDOWS_CALENDAR_URL || Object.values(WINDOWS_SETTINGS).some(target => target === url)
}
