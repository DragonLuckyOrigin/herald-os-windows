import type { CalendarResult } from '../../../shared/ipc.ts'

export function shiftCalendarMonth(month: Date, offset: number): Date {
  return new Date(month.getFullYear(), month.getMonth() + offset, 1)
}

/** Monday-first month grid, shared by navigation and rendering. */
export function calendarDays(month: Date): (number | null)[] {
  const first = shiftCalendarMonth(month, 0)
  const lead = (first.getDay() + 6) % 7
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  return [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => i + 1)]
}

export function calendarNotice(result: CalendarResult): string {
  if (result.error) return result.error
  if (result.status === 'unavailable') return 'Calendar events are not available here.'
  if (result.status !== 'authorized') return 'Calendar access is not authorized.'
  return 'Nothing on the calendar today.'
}
