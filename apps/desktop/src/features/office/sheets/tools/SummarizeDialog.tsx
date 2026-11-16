import { t as uiT, useT as useUiT, $language as $uiLanguage } from '../../../../store/i18n.ts'
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import { quoteSheet } from '../../../../../shared/office/xlsx/address.ts'
import type { CellInput } from '../model.ts'
import { openDialog } from '../ui/overlay.tsx'
import { labelKey, previewRows, SUMMARY_FUNCTIONS, type SummaryFunction, summarize, summarySource, valueName } from './summary.ts'
import { Check, Choices, counted, Heading, Note, PreviewGrid, RemoveButton, Select, TextField, ToolDialog, useLive } from './ui.tsx'

/* Data → Summarize…: a pivot-style summary of the table, its fields from the header row put in rows, columns, values and filters. */

type Field = ReturnType<typeof summarySource>['fields'][number]

const FUNCTION_NAMES: Record<SummaryFunction, string> = { get sum() { return uiT('sheets.summary.sum') }, get count() { return uiT('sheets.summary.count') }, get average() { return uiT('sheets.summary.average') }, get min() { return uiT('sheets.summary.min') }, get max() { return uiT('sheets.summary.max') } }

/** A list to add a field to, then remove it from. */
function FieldList({ title, fields, chosen, onChange }: { title: string; fields: Field[]; chosen: string[]; onChange: (chosen: string[]) => void }) {
  useUiT()
  const free = fields.filter((field) => !chosen.includes(field.name))

  return (
    <section>
      <Heading
        action={
          <Select label={uiT("ui.333333d3b471", { value1: String(title.toLowerCase()) })} value="" disabled={!free.length} onChange={(event) => event.target.value && onChange([...chosen, event.target.value])} className="h-6 w-36">
            <option value="">{uiT("ui.2e5df7fde3db")}</option>
            {free.map((field) => (
              <option key={field.name} value={field.name}>
                {field.name}
              </option>
            ))}
          </Select>
        }
      >
        {title}
      </Heading>
      {chosen.length ? (
        <div className="flex flex-col gap-1">
          {chosen.map((name) => (
            <div key={name} className="flex min-h-7 items-center gap-2 rounded-md bg-white/4 pl-2 text-[12.5px] text-fg">
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <RemoveButton label={uiT("ui.ffae4f8b510b", { value1: String(name), value2: String(title.toLowerCase()) })} onClick={() => onChange(chosen.filter((other) => other !== name))} />
            </div>
          ))}
        </div>
      ) : (
        <Note>{uiT("ui.dc937b598926")}</Note>
      )}
    </section>
  )
}

/** A filter's values, each kept or not. */
function FilterValues({ field, kept, onChange }: { field: Field; kept: CellInput[]; onChange: (kept: CellInput[]) => void }) {
  useUiT()
  const keys = new Set(kept.map(labelKey))

  return (
    <div className="mt-1 ml-2 flex max-h-32 flex-col gap-1 overflow-y-auto rounded-md border border-line p-1.5">
      <div className="flex gap-3 text-[11.5px]">
        <button type="button" className="text-accent-strong hover:underline" onClick={() => onChange(field.values.map((entry) => entry.value))}>
          {uiT("ui.6b2fd69ca13a")}</button>
        <button type="button" className="text-accent-strong hover:underline" onClick={() => onChange([])}>
          {uiT("ui.d53fca1b220d")}</button>
      </div>
      {field.values.map((entry) => (
        <Check key={labelKey(entry.value)} checked={keys.has(labelKey(entry.value))} onChange={(on) => onChange(on ? [...kept, entry.value] : kept.filter((value) => labelKey(value) !== labelKey(entry.value)))}>
          {entry.text}
        </Check>
      ))}
    </div>
  )
}

function SummarizeDialog({ docKey, range }: { docKey: string; range: string }) {
  useUiT()
  const [source, setSource] = useState(range)
  // The table as read ("Sales!A1:D11"), and what the person typed over it.
  const [shown, setShown] = useState(range)
  const [typed, setTyped] = useState(range)
  const table = useLive(docKey, (target) => summarySource(target, { source }), [source])
  const fields = table.value?.fields ?? []
  const [rows, setRows] = useState<string[]>([])
  const [columns, setColumns] = useState<string[]>([])
  const [values, setValues] = useState<{ field: string; fn: SummaryFunction }[]>([])
  const [filters, setFilters] = useState<{ field: string; values: CellInput[] }[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [where, setWhere] = useState<'new' | 'cell'>('new')
  const [cell, setCell] = useState('')

  // A table read afresh starts with a likely summary: its first text field down, its first number field added up.
  useEffect(() => {
    if (!table.value) {
      return
    }

    const label = fields.find((field) => !field.numeric) ?? fields[0]
    const number = fields.find((field) => field.numeric && field.name !== label?.name)
    const read = `${quoteSheet(table.value.sheet)}!${table.value.range}`
    setShown(read)
    setTyped(read)
    setRows(label ? [label.name] : [])
    setColumns([])
    setValues(number ? [{ field: number.name, fn: 'sum' }] : label ? [{ field: label.name, fn: 'count' }] : [])
    setFilters([])
  }, [table.value])

  const definition = useMemo(() => ({ source, rows, columns, values, filters: filters.filter((filter) => filter.values.length), destination: where === 'new' ? 'new' : cell }), [$uiLanguage.get(), source, rows, columns, values, filters, where, cell])
  const ready = Boolean(table.value && rows.length && values.length && (where === 'new' || cell.trim()))
  const preview = useLive(docKey, (target) => (ready ? summarize(target, { ...definition, preview: true }) : null), [definition, ready])
  const fieldOf = (name: string) => fields.find((field) => field.name === name)
  const apply = () => {
    setShown(typed)
    setSource(typed)
  }
  const setFn = (field: string, fn: SummaryFunction) => setValues(values.map((value) => (value.field === field ? { ...value, fn } : value)))

  return (
    <ToolDialog
      docKey={docKey}
      title={uiT("ui.e2683724d3ee")}
      action={uiT('sheets.action.summarize')}
      ready={ready && !preview.error}
      confirm={async (target) => {
        const made = await summarize(target, definition)
        const across = made.columns ? uiT('sheets.summary.across', { columns: counted(made.columns, 'column label') }) : ''

        return uiT('sheets.summary.done', { source: made.source, newSheet: made.newSheet ? uiT('sheets.summary.newSheet') : '', sheet: made.sheet, rows: counted(made.rows, 'row label'), across })
      }}
    >
      <label className="flex items-center gap-2 text-[12px] text-fg-2">
        <span className="w-12 shrink-0">{uiT("ui.16d1c9050a0b")}</span>
        <TextField
          label={uiT("ui.1243538b872e")}
          autoFocus
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={() => typed !== shown && apply()}
          onKeyDown={(event) => {
            // Enter reads a table typed afresh; on the table as read, it summarizes.
            if (event.key === 'Enter' && typed !== shown) {
              event.stopPropagation()
              event.preventDefault()
              apply()
            }
          }}
          className="flex-1"
        />
        {table.value && <span className="shrink-0 text-fg-3">{table.value.rows.toLocaleString('en-US')}{uiT("ui.dc601c4a4752")}</span>}
      </label>
      {table.error ? (
        <Note tone="warn">{table.error}</Note>
      ) : (
        <div className="-mx-1 flex max-h-[min(26rem,52vh)] flex-col gap-3 overflow-y-auto px-1">
          <FieldList title={uiT("ui.101f2ff3de22")} fields={fields.filter((field) => !columns.includes(field.name))} chosen={rows} onChange={setRows} />
          <FieldList title={uiT("ui.53aade77cd69")} fields={fields.filter((field) => !rows.includes(field.name))} chosen={columns} onChange={setColumns} />
          <section>
            <Heading
              action={
                <Select label={uiT("ui.e2f9f33fe2df")} value="" onChange={(event) => event.target.value && setValues([...values, { field: event.target.value, fn: fieldOf(event.target.value)?.numeric ? 'sum' : 'count' }])} className="h-6 w-36">
                  <option value="">{uiT("ui.2e5df7fde3db")}</option>
                  {fields.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.name}
                    </option>
                  ))}
                </Select>
              }
            >
              {uiT("ui.f16e5a470cc4")}</Heading>
            {values.length ? (
              <div className="flex flex-col gap-1">
                {values.map((value, index) => (
                  <div key={`${value.field} ${index}`} className="flex min-h-7 items-center gap-2 rounded-md bg-white/4 pl-2 text-[12.5px] text-fg">
                    <span className="min-w-0 flex-1 truncate">{valueName(value)}</span>
                    <Select label={uiT("ui.2f4a1be11340", { value1: String(value.field) })} value={value.fn} onChange={(event) => setFn(value.field, event.target.value as SummaryFunction)} className="h-6">
                      {SUMMARY_FUNCTIONS.map((fn) => (
                        <option key={fn} value={fn}>
                          {FUNCTION_NAMES[fn]}
                        </option>
                      ))}
                    </Select>
                    <RemoveButton label={uiT("ui.0ab4d0cee3a1", { value1: String(valueName(value)) })} onClick={() => setValues(values.filter((_, other) => other !== index))} />
                  </div>
                ))}
              </div>
            ) : (
              <Note>{uiT("ui.9910d526c4cf")}</Note>
            )}
          </section>
          <section>
            <Heading
              action={
                <Select
                  label={uiT("ui.a2885524d4e7")}
                  value=""
                  onChange={(event) => {
                    const field = fieldOf(event.target.value)

                    if (field) {
                      setFilters([...filters, { field: field.name, values: field.values.map((entry) => entry.value) }])
                      setOpen(field.name)
                    }
                  }}
                  className="h-6 w-36"
                >
                  <option value="">{uiT("ui.2e5df7fde3db")}</option>
                  {fields
                    .filter((field) => !filters.some((filter) => filter.field === field.name) && field.values.length === field.distinct)
                    .map((field) => (
                      <option key={field.name} value={field.name}>
                        {field.name}
                      </option>
                    ))}
                </Select>
              }
            >
              {uiT("ui.49d4313ad323")}</Heading>
            {filters.length ? (
              <div className="flex flex-col gap-1">
                {filters.map((filter) => {
                  const field = fieldOf(filter.field)

                  return (
                    <div key={filter.field}>
                      <div className="flex min-h-7 items-center gap-1 rounded-md bg-white/4 pl-1 text-[12.5px] text-fg">
                        <button type="button" aria-expanded={open === filter.field} onClick={() => setOpen(open === filter.field ? null : filter.field)} className="flex min-w-0 flex-1 items-center gap-1 text-left">
                          {open === filter.field ? <IconChevronDown size={13} className="shrink-0 text-fg-3" /> : <IconChevronRight size={13} className="shrink-0 text-fg-3" />}
                          <span className="truncate">{filter.field}</span>
                          <span className="shrink-0 text-[11.5px] text-fg-3">
                            {filter.values.length}{uiT("ui.a4282e4b2298")}{field?.distinct ?? 0}
                          </span>
                        </button>
                        <RemoveButton label={uiT("ui.69c300c14fe9", { value1: String(filter.field) })} onClick={() => setFilters(filters.filter((other) => other !== filter))} />
                      </div>
                      {open === filter.field && field && <FilterValues field={field} kept={filter.values} onChange={(kept) => setFilters(filters.map((other) => (other === filter ? { ...other, values: kept } : other)))} />}
                    </div>
                  )
                })}
              </div>
            ) : (
              <Note>{uiT("ui.0e11471c5001")}</Note>
            )}
          </section>
          <section>
            <Heading>{uiT("ui.26a628aef58c")}</Heading>
            <div className="flex items-center gap-2">
              <div className="w-52 shrink-0">
                <Choices
                  label={uiT("ui.2982253e738e")}
                  value={where}
                  options={[
                    { id: 'new', label: uiT("ui.5bfad4d01947") },
                    { id: 'cell', label: uiT("ui.6202ef195012") }
                  ]}
                  onChange={setWhere}
                />
              </div>
              {where === 'cell' && <TextField label={uiT("ui.b87ac127cbd0")} placeholder="Sheet2!A1" value={cell} onChange={(event) => setCell(event.target.value)} className="w-32" />}
            </div>
          </section>
        </div>
      )}
      {preview.value && (
        <section>
          <Heading>
            {preview.value.range}{uiT("ui.0f580db40fe2")}{preview.value.newSheet ? uiT("ui.22f337fa321f") : preview.value.sheet}
          </Heading>
          <PreviewGrid rows={previewRows(preview.value)} />
        </section>
      )}
      {preview.error && <Note tone="warn">{preview.error}</Note>}
    </ToolDialog>
  )
}

/** Open Summarize for the selection (or the table around a single cell) in a document. */
export function openSummarize(docKey: string, range: string): void {
  openDialog(docKey, <SummarizeDialog docKey={docKey} range={range} />)
}
