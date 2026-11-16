import { describe, expect, it } from 'vitest'
import { calendarDays, calendarNotice, shiftCalendarMonth } from './calendar.ts'

describe('calendar navigation and event availability', () => {
  it('navigates across years without overflowing from a long month', () => {
    const next = shiftCalendarMonth(new Date(2026, 11, 31), 1)
    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2027, 0, 1])
    const previous = shiftCalendarMonth(new Date(2026, 0, 31), -1)
    expect([previous.getFullYear(), previous.getMonth(), previous.getDate()]).toEqual([2025, 11, 1])
  })

  it('lays out leap February and a Sunday start with Monday-first weeks', () => {
    const leap = calendarDays(new Date(2024, 1, 1))
    expect(leap.slice(0, 5)).toEqual([null, null, null, 1, 2])
    expect(leap.filter(day => day !== null)).toHaveLength(29)
    expect(calendarDays(new Date(2026, 10, 1)).slice(0, 8)).toEqual([null, null, null, null, null, null, 1, 2])
  })

  it('reports unavailable and denied calendars distinctly from an authorized empty day', () => {
    expect(calendarNotice({ status: 'unavailable', events: [] })).toBe('Calendar events are not available here.')
    expect(calendarNotice({ status: 'denied', events: [] })).toBe('Calendar access is not authorized.')
    expect(calendarNotice({ status: 'restricted', events: [] })).toBe('Calendar access is not authorized.')
    expect(calendarNotice({ status: 'not-determined', events: [] })).toBe('Calendar access is not authorized.')
    expect(calendarNotice({ status: 'authorized', events: [] })).toBe('Nothing on the calendar today.')
    expect(calendarNotice({ status: 'unavailable', events: [], error: 'Unable to read calendar' })).toBe('Unable to read calendar')
  })
})
