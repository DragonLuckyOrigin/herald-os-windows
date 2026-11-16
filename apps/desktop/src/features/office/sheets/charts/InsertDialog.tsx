import { t as uiT, useT as useUiT, $language } from '../../../../store/i18n.ts'
import { useEffect, useMemo, useState } from 'react'
import { CHART_KINDS, type ChartKind, type ChartSpec } from '../../../../../shared/office/charts.ts'
import { GlassButton } from '../../../../components/ui/glass.tsx'
import { cn } from '../../../../lib/cn.ts'
import { messageOf } from '../../../canvas/errors.ts'
import { Modal } from '../../shell/dialogs.tsx'
import { liveTarget } from '../live.ts'
import { closeDialog, openDialog } from '../ui/overlay.tsx'
import { readGrid } from './cells.ts'
import { type ChartValues, chartValues } from './data.ts'
import { KindIcon } from './kinds.tsx'
import { insertChart } from './model.ts'
import { ChartPreview } from './Preview.tsx'
import { KIND_REASONS, recommend } from './recommend.ts'
import { selectChart } from './select.ts'
import { newChart, rangeText } from './spec.ts'

const CHART_LABELS = {"column":"sheets.chart.kind.column","bar":"sheets.chart.kind.bar","line":"sheets.chart.kind.line","area":"sheets.chart.kind.area","pie":"sheets.chart.kind.pie","doughnut":"sheets.chart.kind.doughnut","scatter":"sheets.chart.kind.scatter","combo":"sheets.chart.kind.combo"} as const
const REASON_KEYS = {"Compares values across categories":"sheets.chart.reason.0","Compares values; long category names read well beside bars":"sheets.chart.reason.1","Shows a trend over time or along ordered categories":"sheets.chart.reason.2","Shows a trend and how much it amounts to":"sheets.chart.reason.3","Shows the shares of one whole (the first series)":"sheets.chart.reason.4","Shows the shares of a whole, with room in the middle":"sheets.chart.reason.5","Shows how two sets of numbers relate, one point per row":"sheets.chart.reason.6","Columns and lines together, with a second axis for another scale":"sheets.chart.reason.7","Two columns of numbers: each row is a point, the first number across and the second up":"sheets.chart.reason.8","Dates along the bottom: a line shows how the values move over time":"sheets.chart.reason.9","The values are shares of a whole: each one is a slice":"sheets.chart.reason.10","Shares of a whole, as a ring":"sheets.chart.reason.11","Many points: a line shows their shape":"sheets.chart.reason.12","Long category names read well beside bars":"sheets.chart.reason.13","Columns compare the values side by side":"sheets.chart.reason.14","Bars compare the values, one below the other":"sheets.chart.reason.15","Each value as a slice of the total":"sheets.chart.reason.16","A line shows how the values change from one to the next":"sheets.chart.reason.17","The series are on very different scales: the smaller ones get an axis of their own on the right":"sheets.chart.reason.18","Many points: lines show how each series moves":"sheets.chart.reason.19","Columns compare the series category by category":"sheets.chart.reason.20","Lines show how each series changes":"sheets.chart.reason.21","Stacked columns show each category’s total and its parts":"sheets.chart.reason.22","Stacked areas show how the parts add up along the way":"sheets.chart.reason.23","Bars compare the series, one category below the other":"sheets.chart.reason.24"} as const
export const chartReason = (reason: string): string => Object.hasOwn(REASON_KEYS, reason) ? uiT(REASON_KEYS[reason as keyof typeof REASON_KEYS]) : reason

/* Insert → Chart…: the kinds of chart that suit the selection first, each pictured with its data, then every kind. */

interface Choice {
  key: string
  kind: ChartKind
  stacking?: 'stacked' | 'percent'
  reason: string
  preview?: { spec: ChartSpec; values: ChartValues }
}

interface Plan {
  /** The cells charted, the table around a single cell included. */
  cells: string
  recommended: Choice[]
  all: Choice[]
  error: string
}

function planFor(docKey: string, range: string): Plan {
  const target = liveTarget(docKey)

  if (!target) {
    return { cells: '', recommended: [], all: [], error: 'This workbook is not on screen' }
  }

  try {
    const { block } = newChart(target, { range })
    const read = (cells: Parameters<typeof readGrid>[1]) => readGrid(target.workbook, cells)
    const pictured = (kind: ChartKind, stacking?: 'stacked' | 'percent') => {
      const { spec } = newChart(target, { range, kind, settings: stacking ? { stacking } : {} })

      return { spec, values: chartValues(spec, read) }
    }

    return {
      cells: rangeText(target.workbook, { sheet: block.sheet.getSheetId(), ...block.cells }),
      recommended: recommend(block.grid).map((entry) => ({ key: `${entry.kind} ${entry.stacking ?? ''}`, ...entry, preview: pictured(entry.kind, entry.stacking) })),
      all: CHART_KINDS.map((kind) => ({ key: kind, kind, reason: KIND_REASONS[kind] })),
      error: ''
    }
  } catch (error) {
    return { cells: '', recommended: [], all: [], error: messageOf(error) }
  }
}

export const chartName = (choice: Pick<Choice, 'kind' | 'stacking'>): string => {
  const name = uiT(CHART_LABELS[choice.kind])
  return choice.stacking ? uiT(choice.stacking === 'stacked' ? 'sheets.chart.stacked' : 'sheets.chart.percent', { name: $language.get() === 'de-DE' ? name : name.toLowerCase() }) : name
}

function InsertChartDialog({ docKey, range: initial }: { docKey: string; range: string }) {
  useUiT()
  const [range, setRange] = useState(initial)
  const [typed, setTyped] = useState(initial)
  const plan = useMemo(() => planFor(docKey, range), [docKey, range])
  const [picked, setPicked] = useState<Choice | null>(plan.recommended[0] ?? null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setPicked(plan.recommended[0] ?? plan.all[0] ?? null)
    setTyped(plan.cells || range)
  }, [plan])

  const insert = async (choice: Choice | null) => {
    const target = liveTarget(docKey)

    if (!target || !choice || busy) {
      return
    }

    setBusy(true)
    setError('')

    try {
      const { chart } = await insertChart(target, { range: plan.cells || range, kind: choice.kind, ...(choice.stacking ? { stacking: choice.stacking } : {}) })
      closeDialog()
      selectChart(target, chart)
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={uiT("ui.d26f30df8e97")} onClose={closeDialog}>
      <label className="mb-3 flex items-center gap-2 text-[12px] text-fg-2">
        <span className="shrink-0">{uiT("ui.cec3a9b89b2e")}</span>
        <input
          value={typed}
          aria-label={uiT("ui.7b56773a6cbb")}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={() => setRange(typed)}
          onKeyDown={(event) => event.key === 'Enter' && setRange(typed)}
          className="glass-input h-7 min-w-0 flex-1 rounded-md px-2 text-[12px] text-fg outline-none"
        />
      </label>
      <div className="-mx-1 flex max-h-[min(30rem,60vh)] flex-col gap-3 overflow-y-auto px-1">
        {plan.error ? (
          <p className="text-[12.5px] text-fg-2">{plan.error === 'This workbook is not on screen' ? uiT('sheets.notOnScreen') : plan.error}</p>
        ) : (
          <>
            <section>
              <div className="mb-1.5 text-[11.5px] font-medium tracking-wide text-fg-3 uppercase">{uiT("ui.d70604e84304")}</div>
              <div className="grid grid-cols-3 gap-2">
                {plan.recommended.map((choice) => (
                  <button
                    key={choice.key}
                    type="button"
                    onClick={() => setPicked(choice)}
                    onDoubleClick={() => void insert(choice)}
                    className={cn('flex flex-col gap-1 rounded-lg border p-1.5 text-left transition-colors duration-120', picked?.key === choice.key ? 'border-accent bg-accent-soft' : 'border-line hover:bg-white/8')}
                  >
                    {choice.preview && <ChartPreview spec={choice.preview.spec} values={choice.preview.values} className="h-16 w-full" />}
                    <span className="px-0.5 text-[12px] text-fg">{chartName(choice)}</span>
                    <span className="line-clamp-2 px-0.5 text-[11px] leading-snug text-fg-3">{chartReason(choice.reason)}</span>
                  </button>
                ))}
              </div>
            </section>
            <section>
              <div className="mb-1.5 text-[11.5px] font-medium tracking-wide text-fg-3 uppercase">{uiT("ui.cf717207a3ab")}</div>
              <div className="flex flex-col gap-0.5">
                {plan.all.map((choice) => (
                  <button
                    key={choice.key}
                    type="button"
                    onClick={() => setPicked(choice)}
                    onDoubleClick={() => void insert(choice)}
                    className={cn('flex h-8 items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-120', picked?.key === choice.key ? 'bg-accent-soft text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg')}
                  >
                    <KindIcon kind={choice.kind} size={16} className="shrink-0 text-fg-2" />
                    <span className="w-16 shrink-0 text-[12px] text-fg">{uiT(CHART_LABELS[choice.kind])}</span>
                    <span className="truncate text-[11.5px] text-fg-3">{chartReason(choice.reason)}</span>
                  </button>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
      {error && <p className="mt-3 text-[12px] text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <GlassButton variant="ghost" onClick={closeDialog}>
          {uiT("ui.0ef70263b054")}</GlassButton>
        <GlassButton variant="primary" disabled={!picked || Boolean(plan.error) || busy} onClick={() => void insert(picked)}>
          {uiT("ui.24cda0a084a8")}</GlassButton>
      </div>
    </Modal>
  )
}

/** Open Insert chart for `range` (the selection, or a cell in a table) in a document. */
export function openInsertChart(docKey: string, range: string): void {
  openDialog(docKey, <InsertChartDialog docKey={docKey} range={range} />)
}
