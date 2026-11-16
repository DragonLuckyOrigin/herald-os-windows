import { t as uiT, useT as useUiT } from '../../store/i18n.ts'
import { IconMessageChatbot, IconPlus, IconSparkles, IconX } from '@tabler/icons-react'
import { useState } from 'react'
import { HERALD_EVENTS, type HeraldEventName } from '../../../shared/events.ts'
import { Chips, GlassButton, GlassCard } from '../../components/ui/glass.tsx'
import { sendPrompt } from '../../store/chat.ts'
import { showPage } from '../../store/windows.ts'
import type { CronJobDraft, DeliveryTarget } from './api.ts'
import { SCHEDULE_FORMATS_HINT, SCHEDULE_PLACEHOLDER, humanizeCronExpr } from './cron-humanize.ts'
import { FieldLabel, GlyphTile, Hint, SelectInput, TextArea, TextInput, isLocalDelivery } from './presentation.tsx'

const DESCRIBE_PROMPT = 'Help me set up a new scheduled automation. Ask me what it should do and when, then create it with the cronjob tool.'

/** Runs on an event instead of a schedule; the page turns it into a paused job plus a rule. */
export interface EventTrigger {
  event: HeraldEventName
  match?: Record<string, string>
}

const TRIGGER_MODES = [
  { id: 'schedule', get label() { return uiT("ui.8c4f34506ebc") } },
  { id: 'event', get label() { return uiT("ui.f90ee1af108e") } }
] as const

const EVENT_CHOICES = HERALD_EVENTS.filter(event => event.automation)

/** Events that can be narrowed down, and the detail they match on. */
const MATCHES: Partial<Record<HeraldEventName, { key: string; label: string; placeholder: string }>> = {
  crash: { key: 'app', get label() { return uiT("ui.39fbdddc20fa") }, get placeholder() { return uiT("ui.1089065879e4") } },
  'network-change': { key: 'wifi', get label() { return uiT("ui.f1bd65ed5dfb") }, get placeholder() { return uiT("ui.759b99801d66") } }
}

/** Inline "New automation" form shown in the detail column. */
export function NewAutomationForm({ targets, creating, onCreate, onCancel }: { targets: readonly DeliveryTarget[]; creating: boolean; onCreate: (draft: CronJobDraft, trigger?: EventTrigger) => Promise<boolean>; onCancel: () => void }) {
  useUiT()
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'schedule' | 'event'>('schedule')
  const [schedule, setSchedule] = useState('')
  const [event, setEvent] = useState<HeraldEventName>('login')
  const [matchValue, setMatchValue] = useState('')
  const [prompt, setPrompt] = useState('')
  const [deliver, setDeliver] = useState('local')

  const canCreate = (mode === 'event' || schedule.trim().length > 0) && prompt.trim().length > 0 && !creating
  const preview = humanizeCronExpr(schedule.trim())
  const matcher = MATCHES[event]

  const submit = async () => {
    if (!canCreate) {
      return
    }

    const draft = { name: name.trim(), schedule: schedule.trim(), prompt: prompt.trim(), deliver }

    await (mode === 'event' ? onCreate(draft, { event, match: matcher && matchValue.trim() ? { [matcher.key]: matchValue.trim() } : undefined }) : onCreate(draft))
  }

  return (
    <GlassCard className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3.5 px-5 pt-5 pb-4">
        <GlyphTile icon={<IconSparkles />} size={44} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[18px] leading-tight font-semibold text-fg">{uiT("ui.db87a63d537e")}</h2>
          <p className="mt-1 text-[12.5px] text-fg-3">{uiT("ui.f54047a322c8")}</p>
        </div>
        <GlassButton size="icon" variant="ghost" onClick={onCancel} aria-label={uiT("ui.1660a4c0d46d")} className="-mt-1 -mr-2">
          <IconX />
        </GlassButton>
      </div>

      <form
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="new-automation-name">{uiT("ui.dcd1d5223f73")}</FieldLabel>
          <TextInput id="new-automation-name" value={name} onChange={e => setName(e.target.value)} placeholder={uiT("ui.88fce6dd8cd8")} autoFocus />
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="new-automation-schedule">{uiT("ui.cf9c7aa24a26")}</FieldLabel>
          <Chips items={TRIGGER_MODES} value={mode} onChange={setMode} className="self-start" />
          {mode === 'schedule' ? (
            <>
              <TextInput id="new-automation-schedule" value={schedule} onChange={e => setSchedule(e.target.value)} placeholder={SCHEDULE_PLACEHOLDER} required />
              <Hint>
                {preview ? (
                  <span className="text-accent-strong">{preview}</span>
                ) : (
                  <>
                    {uiT("ui.b725653d5469")}{SCHEDULE_FORMATS_HINT}.
                  </>
                )}
              </Hint>
            </>
          ) : (
            <>
              <SelectInput id="new-automation-schedule" value={event} onChange={e => setEvent(e.target.value as HeraldEventName)}>
                {EVENT_CHOICES.map(choice => (
                  <option key={choice.name} value={choice.name}>
                    {choice.label}
                  </option>
                ))}
              </SelectInput>
              {matcher && <TextInput aria-label={matcher.label} value={matchValue} onChange={e => setMatchValue(e.target.value)} placeholder={matcher.placeholder} />}
              <Hint>{uiT("ui.9c451b92f7c9")}</Hint>
            </>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="new-automation-prompt">{uiT("ui.82eec8b85481")}</FieldLabel>
          <TextArea id="new-automation-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} rows={6} placeholder={uiT("ui.6c391157575d")} required />
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="new-automation-deliver">{uiT("ui.cf61d6227120")}</FieldLabel>
          <SelectInput id="new-automation-deliver" value={deliver} onChange={e => setDeliver(e.target.value)}>
            {targets.map(target => (
              <option key={target.id} value={target.id} disabled={target.home_target_set === false}>
                {target.name}
                {target.home_target_set === false ? uiT("ui.b264f4488053") : ''}
              </option>
            ))}
          </SelectInput>
          <Hint>{isLocalDelivery(deliver) ? uiT("ui.106598d8ada8") : uiT("ui.998e856a3dc3")}</Hint>
        </div>
      </form>

      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5">
        <GlassButton
          variant="secondary"
          onClick={() => {
            showPage('hermes')
            void sendPrompt(DESCRIBE_PROMPT)
          }}
        >
          <IconMessageChatbot />
          {uiT("ui.3259df2b14db")}</GlassButton>
        <GlassButton variant="primary" disabled={!canCreate} onClick={() => void submit()} aria-label={uiT("ui.779471949aa3")}>
          <IconPlus />
          {creating ? uiT("ui.c79ed9492e3c") : uiT("ui.4759498ac2a7")}
        </GlassButton>
      </div>
    </GlassCard>
  )
}
