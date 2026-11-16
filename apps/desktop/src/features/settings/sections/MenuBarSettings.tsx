import type { TextKey } from '../../../../shared/i18n.ts'
import { t, useT } from '../../../store/i18n.ts'
import { useStore } from '@nanostores/react'
import { IconCalendar, IconChevronDown, IconChevronUp, IconClock, IconGripVertical, IconRestore } from '@tabler/icons-react'
import { useState } from 'react'
import { clockText, type MenuBarClock, type MenuBarItem, normalizeMenuBar, PINNED_ITEMS } from '../../../../shared/menu-bar.ts'
import { Chips, GlassButton, Toggle } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { useClock } from '../../../shell/MenuBar.tsx'
import { $prefs } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { runCommand } from '../../../store/os-commands.ts'
import { Filterable, markSaved, SettingsGroup, SettingsRow } from './shared.tsx'

const ITEM_LABELS: Record<MenuBarItem, TextKey> = {
  search: 'settings.menuBar.item.search',
  widgets: 'settings.menuBar.item.widgets',
  voice: 'settings.menuBar.item.voice',
  pet: 'settings.menuBar.item.pet',
  indicators: 'settings.menuBar.item.indicators',
  usage: 'settings.menuBar.item.usage',
  wifi: 'settings.menuBar.item.wifi',
  bluetooth: 'settings.menuBar.item.bluetooth',
  sound: 'settings.menuBar.item.sound',
  battery: 'settings.menuBar.item.battery',
  notifications: 'settings.menuBar.item.notifications',
  clock: 'settings.menuBar.item.clock'
}

const HINTS: Partial<Record<MenuBarItem, TextKey>> = {
  widgets: "settings.detail.widgetsYouTurnedOnForTheMenuBar.51977",
  voice: "settings.detail.whileHermesIsListeningOrSpeaking.6c8ed",
  pet: "settings.detail.whileAPetIsOnPutsItAway.028ef",
  indicators: "settings.detail.recordingDictationAndSwitchesThatAreOnAlways.87fb8",
  usage: "settings.detail.howMuchOfYourModelPlanIsUsed.39905",
  battery: "settings.detail.onComputersWithABattery.1ab36"
}

const HOURS: { id: MenuBarClock['hours']; label: TextKey }[] = [
  { id: 'system', label: "settings.detail.automatic.d461a" },
  { id: '12', label: "settings.detail.12hour.c3a5f" },
  { id: '24', label: "settings.detail.24hour.0a56a" }
]

const DATES: { id: MenuBarClock['date']; label: TextKey }[] = [
  { id: 'short', label: "settings.detail.short.f5d61" },
  { id: 'long', label: "settings.detail.long.d1d87" },
  { id: 'none', label: "settings.detail.none.dc937" }
]

async function run(command: string, args: Record<string, unknown> = {}) {
  const result = await runCommand(command, args, { source: 'ui' })

  if (result.ok) {
    markSaved()
  } else {
    notify({ title: t("settings.detail.couldNotChangeTheMenuBar.4ee03"), body: result.error ?? result.summary, level: 'error' })
  }
}

/** Settings > Appearance > Menu bar: the items in order (drag or the arrows), each one's switch, and the clock. */
export function MenuBarSettings() {
  useT()
  const prefs = useStore($prefs)
  const layout = normalizeMenuBar(prefs.menuBar)
  const [dragging, setDragging] = useState<MenuBarItem | null>(null)
  const [slot, setSlot] = useState<number | null>(null)
  const now = useClock(1000)
  const preview = clockText(now, layout.clock)
  const shown = (item: MenuBarItem) => (item === 'usage' ? Boolean(prefs.usageInMenuBar) : !layout.hidden.includes(item))
  const last = layout.order.length - 1

  const endDrag = () => {
    setDragging(null)
    setSlot(null)
  }

  const drop = () => {
    if (dragging && slot !== null) {
      const from = layout.order.indexOf(dragging)
      // Slots count the dragged row itself; positions are among the others, 1 being leftmost.
      void run('bar.move', { item: dragging, position: String((slot > from ? slot - 1 : slot) + 1) })
    }

    endDrag()
  }

  return (
    <SettingsGroup title={t("settings.detail.menuBar.2d9de")}>
      <Filterable label={t("settings.detail.menuBarItems.7bff2")} description={t("settings.detail.dragToReorderTheSwitchShowsOrHides.2f6fb")} keywords="menu bar status icons order hide show reorder wifi bluetooth battery search">
        <div className="settings-row px-3.5 py-2.5">
          <div className="mb-1.5 text-[12px] text-fg-3">{t("settings.detail.topToBottomIsLeftToRightIn.ce7d1")}</div>
          <ol aria-label={t("settings.detail.menuBarItems.7bff2")} className="flex flex-col">
            {layout.order.map((item, index) => {
              const label = t(ITEM_LABELS[item])

              return (
                <li
                  key={item}
                  draggable
                  onDragStart={event => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', item)
                    setDragging(item)
                  }}
                  onDragOver={event => {
                    if (!dragging) {
                      return
                    }

                    event.preventDefault()
                    const box = event.currentTarget.getBoundingClientRect()
                    setSlot(event.clientY < box.top + box.height / 2 ? index : index + 1)
                  }}
                  onDrop={event => {
                    event.preventDefault()
                    drop()
                  }}
                  onDragEnd={endDrag}
                  className={cn('relative flex h-10 cursor-grab items-center gap-2.5 rounded-lg px-1.5 hover:bg-white/4', dragging === item && 'opacity-40')}
                >
                  {dragging && slot === index && <span aria-hidden="true" className="absolute inset-x-1 -top-px h-0.5 rounded-full bg-accent" />}
                  {dragging && slot === last + 1 && index === last && <span aria-hidden="true" className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent" />}
                  <IconGripVertical size={14} className="shrink-0 text-fg-4" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className={cn('text-[13px]', shown(item) ? 'text-fg' : 'text-fg-3')}>{label}</div>
                    {HINTS[item] && <div className="truncate text-[11.5px] text-fg-4">{HINTS[item] ? t(HINTS[item]!) : undefined}</div>}
                  </div>
                  <GlassButton size="icon" variant="ghost" aria-label={t("settings.detail.moveEarlier.81658", { value1: label })} disabled={index === 0} onClick={() => void run('bar.move', { item, position: String(index) })}>
                    <IconChevronUp size={14} />
                  </GlassButton>
                  <GlassButton size="icon" variant="ghost" aria-label={t("settings.detail.moveLater.18959", { value1: label })} disabled={index === last} onClick={() => void run('bar.move', { item, position: String(index + 2) })}>
                    <IconChevronDown size={14} />
                  </GlassButton>
                  <Toggle checked={shown(item)} disabled={PINNED_ITEMS.includes(item)} onChange={next => void run(next ? 'bar.show' : 'bar.hide', { item })} label={t("settings.detail.show.b4960", { value1: label })} />
                </li>
              )
            })}
          </ol>
        </div>
      </Filterable>
      <SettingsRow icon={<IconClock />} label={t("settings.detail.clock.93ff9")} description={<span className="tabular-nums">{[preview.date, preview.time].filter(Boolean).join('  ')}</span>} keywords="time 12 hour 24 hour format">
        <Chips items={HOURS.map(item => ({ ...item, label: t(item.label) }))} value={layout.clock.hours} onChange={hours => void run('bar.clock', { hours })} />
      </SettingsRow>
      <SettingsRow icon={<IconClock />} label={t("settings.detail.showSeconds.f516b")} keywords="clock seconds time">
        <Toggle checked={layout.clock.seconds} onChange={seconds => void run('bar.clock', { seconds })} label={t("settings.detail.showSeconds.f516b")} />
      </SettingsRow>
      <SettingsRow icon={<IconCalendar />} label={t("settings.detail.date.99c40")} description={t("settings.detail.nextToTheTime.8b923")} keywords="clock date weekday">
        <Chips items={DATES.map(item => ({ ...item, label: t(item.label) }))} value={layout.clock.date} onChange={date => void run('bar.clock', { date })} />
      </SettingsRow>
      <SettingsRow icon={<IconRestore />} label={t("settings.detail.resetTheMenuBar.2c6f2")} description={t("settings.detail.everyItemBackInItsPlaceAndShown.bec97")} keywords="menu bar default restore">
        <GlassButton size="sm" variant="ghost" onClick={() => void run('bar.reset')}>
          {t("settings.detail.reset.daee7")}</GlassButton>
      </SettingsRow>
    </SettingsGroup>
  )
}
