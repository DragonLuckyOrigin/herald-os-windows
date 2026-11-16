import { t as uiT, useT as useUiT } from '../../../../store/i18n.ts'
import { useEffect, useState } from 'react'
import { openDialog } from '../ui/overlay.tsx'
import { convertToDates } from './model.ts'
import { DATE_FORMATS, DATE_ORDERS, type DateOrder } from './text.ts'
import { Choices, counted, Heading, Note, Select, ToolDialog, useLive } from './ui.tsx'

/* Data → Convert text to dates…: the order the dates are written in, with examples from the cells, and the format they get. */

const ORDER_EXAMPLES: Record<DateOrder, string> = { DMY: '31/12/2025', MDY: '12/31/2025', YMD: '2025/12/31' }
const MONTH_NAMES = 'January February March April May June July August September October November December'.split(' ')

/** A date serial in one of the dialog's date formats, as the sheet will show it. */
function shown(serial: number, format: string): string {
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000)
  const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()]
  const two = (n: number) => String(n).padStart(2, '0')
  const parts: Record<string, string> = { yyyy: String(year), mmmm: MONTH_NAMES[month], mmm: MONTH_NAMES[month].slice(0, 3), mm: two(month + 1), dd: two(day), d: String(day) }

  return format.replace(/yyyy|mmmm|mmm|mm|dd|d/g, (token) => parts[token])
}

function DatesDialog({ docKey, range, sheet }: { docKey: string; range: string; sheet: string }) {
  useUiT()
  const counts = useLive(docKey, async (target) => Promise.all(DATE_ORDERS.map((order) => convertToDates(target, { range, sheet, order, preview: true }))), [range, sheet])
  const [order, setOrder] = useState<DateOrder>('DMY')
  const [format, setFormat] = useState<string>(DATE_FORMATS[0])
  const [guessed, setGuessed] = useState(false)

  // The order that reads the most cells as dates; day first when the cells read either way.
  useEffect(() => {
    if (counts.value && !guessed) {
      const best = counts.value.reduce((top, result) => (result.converted > top.converted ? result : top))
      setOrder(best.order)
      setGuessed(true)
    }
  }, [counts.value])

  const result = counts.value?.find((entry) => entry.order === order)
  const [dayFirst, monthFirst] = counts.value ?? []
  const either = Boolean(dayFirst && monthFirst && dayFirst.converted === monthFirst.converted && dayFirst.examples.some((example, index) => example.value !== monthFirst.examples[index]?.value))

  return (
    <ToolDialog
      docKey={docKey}
      title={uiT("ui.533adfd68807")}
      action={uiT('sheets.action.convert')}
      ready={Boolean(result?.converted)}
      confirm={async (target) => {
        const done = await convertToDates(target, { range, sheet, order, format })
        const left = done.failed ? uiT('sheets.datesFailed', { cells: counted(done.failed, 'cell'), examples: done.notConverted.slice(0, 3).map((entry) => `${entry.cell} “${entry.text}”`).join(', ') + (done.failed > 3 ? '…' : '') }) : ''

        return uiT('sheets.datesDone', { cells: counted(done.converted, 'cell'), range: done.range, left })
      }}
    >
      <section>
        <Heading>{uiT("ui.9260eb929d77")}</Heading>
        <Choices label={uiT("ui.1fb09c0edb54")} value={order} onChange={setOrder} autoFocus options={DATE_ORDERS.map((id) => ({ id, label: id === 'DMY' ? uiT('sheets.dateOrder.day') : id === 'MDY' ? uiT('sheets.dateOrder.month') : uiT('sheets.dateOrder.year'), detail: ORDER_EXAMPLES[id] }))} />
      </section>
      {result && (
        <section>
          <Heading>{result.converted ? uiT("ui.98e1d8eeafd1", { value1: String(counted(result.converted, 'cell')), value2: String(result.range) }) : uiT("ui.e3159ad8f048", { value1: String(result.range) })}</Heading>
          <div className="flex flex-col gap-0.5 text-[12px]">
            {result.examples.map((example) => (
              <div key={example.cell} className="flex gap-2">
                <span className="w-10 shrink-0 text-fg-3">{example.cell}</span>
                <span className="min-w-0 flex-1 truncate text-fg-2">{example.text}</span>
                <span className="shrink-0 text-fg">{shown(example.value, 'd mmmm yyyy')}</span>
              </div>
            ))}
          </div>
          {result.failed > 0 && <Note tone="warn">{counted(result.failed, 'cell')}{uiT("ui.a6f301975300")}{result.notConverted.slice(0, 3).map((entry) => `${entry.cell} “${entry.text}”`).join(', ')}</Note>}
          {either && <Note>{uiT("ui.3e6af4ddd759")}</Note>}
        </section>
      )}
      <label className="flex items-center gap-2 text-[12px] text-fg-2">
        <span className="shrink-0">{uiT("ui.6380dba9f992")}</span>
        <Select label={uiT("ui.43123f5ccaa8")} value={format} onChange={(event) => setFormat(event.target.value)} className="flex-1">
          {DATE_FORMATS.map((pattern) => (
            <option key={pattern} value={pattern}>
              {shown(46022, pattern)}
            </option>
          ))}
        </Select>
      </label>
      {counts.error && <Note tone="warn">{counts.error}</Note>}
    </ToolDialog>
  )
}

/** Open Convert text to dates for the selection (or the table around a single cell) in a document. */
export function openConvertDates(docKey: string, selection: { sheet: string; range: string }): void {
  openDialog(docKey, <DatesDialog docKey={docKey} range={selection.range} sheet={selection.sheet} />)
}
