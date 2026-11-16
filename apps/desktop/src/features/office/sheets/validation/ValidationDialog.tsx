import { t as uiT, useT as useUiT, $language as $uiLanguage } from '../../../../store/i18n.ts'
import { useMemo, useState } from 'react'
import { GlassButton } from '../../../../components/ui/glass.tsx'
import { cn } from '../../../../lib/cn.ts'
import { messageOf } from '../../../canvas/errors.ts'
import { Modal } from '../../shell/dialogs.tsx'
import { liveTarget } from '../live.ts'
import { closeDialog, openDialog } from '../ui/overlay.tsx'
import { clearValidation, type ErrorStyle, getValidation, type Operator, OPERATORS, setValidation, type ValidationSettings } from './model.ts'

/* Data → Data validation…: what the selected cells take, with the message shown when one is selected and the alert after a value they do not take. */

type Kind = 'any' | 'whole' | 'decimal' | 'list' | 'date' | 'textLength' | 'custom'

const KINDS: [Kind, string][] = [
  ['any', 'Any value'],
  ['whole', 'Whole number'],
  ['decimal', 'Decimal'],
  ['list', 'List'],
  ['date', 'Date'],
  ['textLength', 'Text length'],
  ['custom', 'Custom formula']
]

const OPERATOR_NAMES: Record<Operator, string> = {
  between: 'between',
  notBetween: 'not between',
  equal: 'equal to',
  notEqual: 'not equal to',
  greaterThan: 'greater than',
  lessThan: 'less than',
  greaterThanOrEqual: 'greater than or equal to',
  lessThanOrEqual: 'less than or equal to'
}

const STYLE_NAMES: [ErrorStyle, string][] = [
  ['stop', 'Stop: the value is refused'],
  ['warning', 'Warning: the value may stay'],
  ['information', 'Information: the value stays']
]

interface Form {
  kind: Kind
  operator: Operator
  value: string
  min: string
  max: string
  listFrom: 'items' | 'cells'
  items: string
  source: string
  formula: string
  allowBlank: boolean
  dropdown: boolean
  showInput: boolean
  inputTitle: string
  inputMessage: string
  showError: boolean
  errorStyle: ErrorStyle
  errorTitle: string
  errorMessage: string
}

const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value))

/** The form for a rule the cells have, or for a new one. */
function formOf(settings: ValidationSettings | undefined): Form {
  const rule = (settings?.rule ?? { type: 'any' }) as Record<string, unknown>
  const kind = (KINDS.some(([id]) => id === rule.type) ? rule.type : 'any') as Kind

  return {
    kind,
    operator: (rule.operator as Operator) ?? 'between',
    value: text(rule.value),
    min: text(rule.min),
    max: text(rule.max),
    listFrom: rule.source ? 'cells' : 'items',
    items: Array.isArray(rule.items) ? rule.items.join('\n') : '',
    source: text(rule.source),
    formula: text(rule.formula),
    allowBlank: settings?.allowBlank ?? true,
    dropdown: settings?.dropdown ?? true,
    showInput: Boolean(settings?.input),
    inputTitle: settings?.input?.title ?? '',
    inputMessage: settings?.input?.message ?? '',
    showError: settings ? Boolean(settings.error) : true,
    errorStyle: settings?.error?.style ?? 'stop',
    errorTitle: settings?.error?.title ?? '',
    errorMessage: settings?.error?.message ?? ''
  }
}

/** The rule of a form, as setValidation takes it. */
function ruleOf(form: Form): Record<string, unknown> {
  if (form.kind === 'list') {
    return form.listFrom === 'cells' ? { type: 'list', source: form.source } : { type: 'list', items: form.items.split(/\n/).map((item) => item.trim()).filter(Boolean) }
  }

  if (form.kind === 'custom') {
    return { type: 'custom', formula: form.formula }
  }

  if (form.kind === 'any') {
    return { type: 'any' }
  }

  const two = form.operator === 'between' || form.operator === 'notBetween'

  return { type: form.kind, operator: form.operator, ...(two ? { min: form.min, max: form.max } : { value: form.value }) }
}

const field = 'glass-input h-8 min-w-0 rounded-lg px-2.5 text-[12.5px] text-fg outline-none'

function Heading({ children }: { children: React.ReactNode }) {
  useUiT()
  return <div className="mb-1.5 text-[11.5px] font-medium tracking-wide text-fg-3 uppercase">{children}</div>
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: React.ReactNode }) {
  useUiT()
  return (
    <label className="flex items-center gap-2 text-[12px] text-fg-2">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="accent-(--color-accent)" />
      {children}
    </label>
  )
}

/** A bound of a rule: a date picker for dates (a formula such as =TODAY() in a plain field), else a plain field. */
function Bound({ label, value, kind, onChange }: { label: string; value: string; kind: Kind; onChange: (value: string) => void }) {
  useUiT()
  const picker = kind === 'date' && (!value || /^\d{4}-\d{2}-\d{2}$/.test(value))

  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11.5px] text-fg-3">
      {label}
      <input type={picker ? 'date' : 'text'} value={value} onChange={(event) => onChange(event.target.value)} placeholder={kind === 'date' ? '=TODAY()' : kind === 'textLength' ? uiT("ui.6fac39e2845b") : '0'} className={field} />
    </label>
  )
}

function ValidationDialog({ docKey, sheet, range: initial }: { docKey: string; sheet: string; range: string }) {
  useUiT()
  const [range, setRange] = useState(initial)
  const existing = useMemo(() => {
    const target = liveTarget(docKey)

    try {
      return target ? getValidation(target, { range: initial, sheet }).rules : []
    } catch {
      return []
    }
  }, [$uiLanguage.get(), docKey, sheet, initial])
  const [form, setForm] = useState<Form>(() => formOf(existing.length === 1 ? existing[0] : undefined))
  const [error, setError] = useState('')
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }))
  const two = form.operator === 'between' || form.operator === 'notBetween'
  const compared = form.kind === 'whole' || form.kind === 'decimal' || form.kind === 'date' || form.kind === 'textLength'

  const act = async (clear: boolean) => {
    const target = liveTarget(docKey)

    if (!target) {
      return
    }

    try {
      if (clear || (form.kind === 'any' && !form.showInput)) {
        await clearValidation(target, { range, sheet })
      } else {
        await setValidation(target, {
          range,
          sheet,
          rule: ruleOf(form),
          allowBlank: form.allowBlank,
          dropdown: form.dropdown,
          input: form.showInput ? { title: form.inputTitle, message: form.inputMessage } : undefined,
          error: form.showError ? { style: form.errorStyle, title: form.errorTitle, message: form.errorMessage } : false
        })
      }

      closeDialog()
    } catch (failure) {
      setError(messageOf(failure))
    }
  }

  return (
    <Modal title={uiT("ui.8b3355abe78b")} onClose={closeDialog}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void act(false)
        }}
      >
        <div className="-mx-1 flex max-h-[min(32rem,62vh)] flex-col gap-4 overflow-y-auto px-1">
          <label className="flex items-center gap-2 text-[12px] text-fg-2">
            <span className="w-14 shrink-0">{uiT("ui.6e0aea0573b9")}</span>
            <input value={range} onChange={(event) => setRange(event.target.value)} aria-label={uiT("ui.6e0aea0573b9")} className={cn(field, 'flex-1 font-mono text-[12px]')} />
            <span className="max-w-28 shrink-0 truncate text-[11.5px] text-fg-3">{uiT("ui.0816446dcc92")}{sheet}</span>
          </label>
          {existing.length > 1 && <p className="-mt-2 text-[11.5px] text-fg-3">{uiT("ui.05a3b502f23f")}{existing.length}{uiT("ui.2c3a47a3ebb8")}</p>}
          {existing.length === 1 && existing[0].range !== initial && <p className="-mt-2 text-[11.5px] text-fg-3">{uiT("ui.a39eedc7dd6e")}{existing[0].range}{uiT("ui.7a6df21551d0")}</p>}
          <section className="flex flex-col gap-2">
            <Heading>{uiT("ui.e213c161d5ce")}</Heading>
            <div className="flex gap-2">
              <select value={form.kind} aria-label={uiT("ui.e213c161d5ce")} onChange={(event) => set('kind', event.target.value as Kind)} className={cn(field, 'flex-1')}>
                {KINDS.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              {compared && (
                <select value={form.operator} aria-label={uiT("ui.571527339d0e")} onChange={(event) => set('operator', event.target.value as Operator)} className={cn(field, 'flex-1')}>
                  {OPERATORS.map((operator) => (
                    <option key={operator} value={operator}>
                      {OPERATOR_NAMES[operator]}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {compared &&
              (two ? (
                <div className="flex gap-2">
                  <Bound label={form.kind === 'date' ? uiT("ui.8169693101a4") : form.kind === 'textLength' ? uiT("ui.3be807632d67") : uiT("ui.735beee2e390")} value={form.min} kind={form.kind} onChange={(value) => set('min', value)} />
                  <Bound label={form.kind === 'date' ? uiT("ui.14303aa0c4a0") : form.kind === 'textLength' ? uiT("ui.802803c78884") : uiT("ui.66c9ab177708")} value={form.max} kind={form.kind} onChange={(value) => set('max', value)} />
                </div>
              ) : (
                <Bound label={form.kind === 'date' ? uiT("ui.99c40ab40592") : form.kind === 'textLength' ? uiT("ui.adc95605a1b3") : uiT("ui.8e37953d23da")} value={form.value} kind={form.kind} onChange={(value) => set('value', value)} />
              ))}
            {form.kind === 'list' && (
              <>
                <div className="flex gap-4 text-[12px] text-fg-2">
                  {(['items', 'cells'] as const).map((from) => (
                    <label key={from} className="flex items-center gap-1.5">
                      <input type="radio" name="list-from" checked={form.listFrom === from} onChange={() => set('listFrom', from)} className="accent-(--color-accent)" />
                      {from === 'items' ? uiT("ui.fb8e7a1a3cb7") : uiT("ui.6a3cf61d7601")}
                    </label>
                  ))}
                </div>
                {form.listFrom === 'items' ? (
                  <textarea value={form.items} onChange={(event) => set('items', event.target.value)} rows={4} placeholder={uiT("ui.51dfa9f6446a")} aria-label={uiT("ui.70d9505eebaf")} className="glass-input min-w-0 resize-none rounded-lg px-2.5 py-1.5 text-[12.5px] text-fg outline-none" />
                ) : (
                  <input value={form.source} onChange={(event) => set('source', event.target.value)} placeholder="Lists!A2:A9" aria-label={uiT("ui.ff14826e4271")} className={cn(field, 'font-mono text-[12px]')} />
                )}
                <Check checked={form.dropdown} onChange={(value) => set('dropdown', value)}>
                  {uiT("ui.0d90df8511fd")}</Check>
              </>
            )}
            {form.kind === 'custom' && <input value={form.formula} onChange={(event) => set('formula', event.target.value)} placeholder="=B2<=C2 (true for the first cell’s allowed values)" aria-label={uiT("ui.d00bd4ec32e4")} className={cn(field, 'font-mono text-[12px]')} />}
            {form.kind !== 'any' && (
              <Check checked={form.allowBlank} onChange={(value) => set('allowBlank', value)}>
                {uiT("ui.d0f972dcfc7b")}</Check>
            )}
          </section>
          <section className="flex flex-col gap-2">
            <Heading>{uiT("ui.49cee1d9389f")}</Heading>
            <Check checked={form.showInput} onChange={(value) => set('showInput', value)}>
              {uiT("ui.95984632e90d")}</Check>
            {form.showInput && (
              <>
                <input value={form.inputTitle} onChange={(event) => set('inputTitle', event.target.value)} maxLength={32} placeholder={uiT("ui.7e8cd2056da7")} aria-label={uiT("ui.d47f9254ecec")} className={field} />
                <textarea value={form.inputMessage} onChange={(event) => set('inputMessage', event.target.value)} maxLength={255} rows={2} placeholder={uiT("ui.2f77668a9dfb")} aria-label={uiT("ui.49cee1d9389f")} className="glass-input min-w-0 resize-none rounded-lg px-2.5 py-1.5 text-[12.5px] text-fg outline-none" />
              </>
            )}
          </section>
          {form.kind !== 'any' && (
            <section className="flex flex-col gap-2">
              <Heading>{uiT("ui.ef8565ee4060")}</Heading>
              <Check checked={form.showError} onChange={(value) => set('showError', value)}>
                {uiT("ui.5b7d953d2c40")}</Check>
              {form.showError && (
                <>
                  <select value={form.errorStyle} aria-label={uiT("ui.903bf244f381")} onChange={(event) => set('errorStyle', event.target.value as ErrorStyle)} className={field}>
                    {STYLE_NAMES.map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <input value={form.errorTitle} onChange={(event) => set('errorTitle', event.target.value)} maxLength={32} placeholder={uiT("ui.7e8cd2056da7")} aria-label={uiT("ui.780aaa3b9822")} className={field} />
                  <textarea value={form.errorMessage} onChange={(event) => set('errorMessage', event.target.value)} maxLength={225} rows={2} placeholder={uiT("ui.2f77668a9dfb")} aria-label={uiT("ui.a5dc35f1ff42")} className="glass-input min-w-0 resize-none rounded-lg px-2.5 py-1.5 text-[12.5px] text-fg outline-none" />
                </>
              )}
            </section>
          )}
        </div>
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <div className="flex items-center gap-2">
          <GlassButton variant="ghost" onClick={() => void act(true)}>
            {uiT("ui.50ad5f03e532")}</GlassButton>
          <GlassButton variant="ghost" className="ml-auto" onClick={closeDialog}>
            {uiT("ui.0ef70263b054")}</GlassButton>
          <GlassButton variant="primary" type="submit">
            {uiT("ui.d0b4b04a552c")}</GlassButton>
        </div>
      </form>
    </Modal>
  )
}

/** Open Data validation for cells of a document's sheet. */
export function openValidationDialog(docKey: string, sheet: string, range: string): void {
  openDialog(docKey, <ValidationDialog key={Date.now()} docKey={docKey} sheet={sheet} range={range} />)
}
