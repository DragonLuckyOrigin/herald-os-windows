import { t as uiT, useT as useUiT } from '../../store/i18n.ts'
import { IconRefresh, IconSparkles } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'
import { cn } from '../../lib/cn.ts'
import type { CanvasDocument } from './engine/document.ts'
import type { HistoryStep } from './engine/history.ts'
import { useRevision } from './hooks.ts'
import { Thumb } from './LayersPanel.tsx'
import { settleTools } from './tools/sessions.ts'

/*
 * The History panel: every step of the document's history by name, the opening state at the top.
 * A click goes back or forward to a step; steps after the current one stay listed, dimmed, until
 * a new edit drops them.
 */

const ORIGIN: Record<NonNullable<HistoryStep['origin']>, { title: string; icon: React.ReactNode }> = {
  command: { get title() { return uiT("ui.56070a03d255") }, icon: <IconSparkles size={12} /> },
  outside: { get title() { return uiT("ui.399f42a9c016") }, icon: <IconRefresh size={12} /> }
}

function Row({ label, current, undone, onClick, children }: { label: string; current: boolean; undone: boolean; onClick: () => void; children?: React.ReactNode }) {
  useUiT()
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (current) {
      ref.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [current])

  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={current}
      onClick={onClick}
      className={cn('flex h-7 w-full shrink-0 items-center gap-2 px-3 text-left text-[12px]', current ? 'bg-accent/20 text-fg' : 'text-fg-2 hover:bg-white/6', undone && 'opacity-45')}
    >
      {children}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

export function HistoryPanel({ doc, header }: { doc: CanvasDocument; header?: React.ReactNode }) {
  useUiT()
  useRevision(doc)
  const { history } = doc
  const steps = history.steps
  const applied = history.applied
  const goTo = (count: number) => {
    // A Free Transform or text being typed is put in first, as a step of its own.
    settleTools(doc)
    doc.goTo(count)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 px-2 text-[11px] text-fg-3">
        {header}
        <span className="ml-auto pr-1 tabular-nums">{steps.length ? uiT("ui.882c45b86bd7", { value1: String(applied), value2: String(steps.length) }) : ''}</span>
      </div>
      <div role="listbox" aria-label={uiT("ui.0e7696009337")} className="min-h-0 flex-1 overflow-y-auto pb-1">
        <Row label={history.dropped ? uiT("ui.5f80c7c0789f") : uiT("ui.df7761f08610", { value1: String(doc.name) })} current={applied === 0} undone={false} onClick={() => goTo(0)}>
          <Thumb raster={history.dropped ? null : doc.openingThumb} version={doc.openingThumb?.version ?? 0} size={20} />
        </Row>
        {history.dropped > 0 && <div className="px-3 py-1 text-[11px] text-fg-3">{uiT("ui.103c5169871d")}{history.dropped === 1 ? uiT("ui.31cf6787ef2a") : uiT("ui.120deb3c4284", { value1: String(history.dropped) })}{uiT("ui.f7154880eedf")}</div>}
        {steps.map((step, i) => (
          <Row key={step.id} label={step.label} current={applied === i + 1} undone={i + 1 > applied} onClick={() => goTo(i + 1)}>
            <span className="grid size-5 shrink-0 place-items-center text-fg-3" title={step.origin ? ORIGIN[step.origin].title : undefined}>
              {step.origin ? ORIGIN[step.origin].icon : <span className="size-1.5 rounded-full bg-current opacity-60" />}
            </span>
          </Row>
        ))}
        {!steps.length && <div className="px-3 py-2 text-[12px] text-fg-3">{uiT("ui.249f27e66c9f")}</div>}
      </div>
    </div>
  )
}
