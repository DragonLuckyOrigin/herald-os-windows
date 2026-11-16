import { t as uiT, useT as useUiT } from '../../store/i18n.ts'
import { IconArrowsShuffle } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { GlassButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { Modal } from './dialogs.tsx'
import { checkFilter, FILTER_DEFAULTS, FILTER_FIELDS, type FilterField, type FilterKind, type FilterSpec } from './engine/filters.ts'
import { applyFilterToDocument, type FilterTask, type PreviewBase, previewBase, previewState } from './filter-run.ts'
import type { CanvasDocument } from './engine/document.ts'
import { $dialog } from './menus.ts'
import { notify } from './store.ts'

/*
 * A filter's dialog: its settings, previewed on the canvas as they change (on a reduced copy of a
 * large layer, which the dialog says), and OK applies it at full size as one undoable step.
 */

/** The settings each filter was last used with, so the dialog opens where the person left it. */
const remembered = new Map<FilterKind, Record<string, number | boolean>>()

const FILTER_DISPLAY_KEYS = {"gaussianBlur":"canvas.filter.gaussianBlur","motionBlur":"canvas.filter.motionBlur","highPass":"canvas.filter.highPass","unsharpMask":"canvas.filter.unsharpMask","smartSharpen":"canvas.filter.smartSharpen","reduceNoise":"canvas.filter.reduceNoise","addNoise":"canvas.filter.addNoise","median":"canvas.filter.median"} as const
const FIELD_DISPLAY_KEYS = {"radius":"canvas.filter.field.radius","angle":"canvas.filter.field.angle","distance":"canvas.filter.field.distance","amount":"canvas.filter.field.amount","threshold":"canvas.filter.field.threshold","reduceNoise":"canvas.filter.field.reduceNoise","strength":"canvas.filter.field.strength","preserveDetails":"canvas.filter.field.preserveDetails","colorNoise":"canvas.filter.field.colorNoise","seed":"canvas.filter.field.seed"} as const
const filterName = (kind: FilterKind) => uiT(FILTER_DISPLAY_KEYS[kind])
const fieldName = (name: string, fallback: string) => name in FIELD_DISPLAY_KEYS ? uiT(FIELD_DISPLAY_KEYS[name as keyof typeof FIELD_DISPLAY_KEYS]) : fallback

const PREVIEW_DELAY = 120

function FieldRow({ name, field, value, onChange }: { name: string; field: FilterField; value: number; onChange: (value: number) => void }) {
  useUiT()
  const toSlider = (v: number) => {
    const t = (v - field.min) / (field.max - field.min)

    return Math.round((field.curve === 'square' ? Math.sqrt(t) : t) * 1000)
  }
  const fromSlider = (p: number) => {
    const t = p / 1000
    const raw = field.min + (field.max - field.min) * (field.curve === 'square' ? t * t : t)

    return Math.round(raw / field.step) * field.step
  }

  return (
    <label className="grid grid-cols-[7rem_1fr_5rem] items-center gap-3 text-[12px] text-fg-2">
      {fieldName(name, field.label)}
      <input type="range" aria-label={uiT("ui.105ec2f522a5", { value1: fieldName(name, field.label) })} min={0} max={1000} value={toSlider(value)} onChange={(event) => onChange(fromSlider(Number(event.target.value)))} className="accent-(--color-accent)" />
      <span className="flex items-center gap-1">
        <input
          aria-label={fieldName(name, field.label)}
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          value={Number(value.toFixed(field.step < 1 ? 1 : 0))}
          onChange={(event) => {
            const number = Number(event.target.value)

            if (event.target.value !== '' && Number.isFinite(number) && number >= field.min && number <= field.max) {
              onChange(number)
            }
          }}
          className="glass-input h-6 w-14 rounded-md px-1.5 text-right text-[12px] text-fg tabular-nums outline-none"
        />
        <span className="text-[11px] text-fg-3">{field.unit === "levels" ? uiT("canvas.filter.levels") : field.unit}</span>
      </span>
    </label>
  )
}

export function FilterDialog({ doc, kind }: { doc: CanvasDocument; kind: FilterKind }) {
  useUiT()
  const [settings, setSettings] = useState<Record<string, number | boolean>>(() => ({ ...(FILTER_DEFAULTS[kind] as unknown as Record<string, number | boolean>), ...remembered.get(kind) }))
  const [preview, setPreview] = useState(true)
  const [phase, setPhase] = useState<'idle' | 'previewing' | 'applying'>('idle')
  const base = useRef<PreviewBase | null | undefined>(undefined)
  const task = useRef<FilterTask | null>(null)
  const finished = useRef(false)

  if (base.current === undefined) {
    base.current = previewBase(doc)
  }

  const close = (apply: boolean) => {
    finished.current = true
    task.current?.cancel()
    const current = base.current

    if (current && doc.state !== current.before) {
      doc.preview(current.before)
    }

    doc.interacting = false

    if (!apply) {
      $dialog.set(null)

      return
    }

    let spec: FilterSpec

    try {
      spec = checkFilter(kind, settings)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')

      return
    }

    remembered.set(kind, settings)
    setPhase('applying')
    notify(uiT("canvas.filter.applying", { name: filterName(kind) }))
    applyFilterToDocument(doc, spec, (running) => (task.current = running))
      .then((changed) => notify(uiT(changed ? "canvas.filter.applied" : "canvas.filter.unchanged", { name: filterName(kind) })))
      .catch((error: unknown) => notify(uiT("canvas.filter.applyError", { name: filterName(kind), error: error instanceof Error ? error.message : String(error) }), 'error'))
      .finally(() => $dialog.set(null))
  }

  // No layer to filter: the reason was shown, and the dialog goes.
  useEffect(() => {
    if (!base.current) {
      $dialog.set(null)

      return
    }

    doc.interacting = true

    return () => {
      if (!finished.current) {
        task.current?.cancel()
        doc.interacting = false

        if (base.current && doc.state !== base.current.before) {
          doc.preview(base.current.before)
        }
      }
    }
  }, [])

  // The preview follows the settings, a moment after they stop changing.
  useEffect(() => {
    const current = base.current

    if (!current || finished.current) {
      return
    }

    if (!preview) {
      task.current?.cancel()
      doc.preview(current.before)
      setPhase('idle')

      return
    }

    let live = true
    const timer = setTimeout(() => {
      task.current?.cancel()
      setPhase('previewing')
      previewState(current, checkFilter(kind, settings), (running) => (task.current = running))
        .then((state) => {
          if (live && !finished.current) {
            doc.preview(state ?? current.before)
            setPhase('idle')
          }
        })
        .catch((error: unknown) => {
          if (live && !(error instanceof Error && error.message === 'cancelled')) {
            notify(uiT("canvas.filter.previewError", { name: filterName(kind), error: error instanceof Error ? error.message : String(error) }), 'error')
          }
        })
    }, PREVIEW_DELAY)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [settings, preview])

  if (!base.current) {
    return null
  }

  const fields = FILTER_FIELDS[kind] as Record<string, FilterField | undefined>
  const put = (key: string, value: number | boolean) => setSettings((current) => ({ ...current, [key]: value }))
  const reduced = base.current.scale < 1

  return (
    <Modal aside title={filterName(kind)} onClose={() => close(false)}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          close(true)
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {Object.entries(fields).map(([key, field]) =>
          key === 'seed' || !field ? null : <FieldRow key={key} name={key} field={field} value={settings[key] as number} onChange={(value) => put(key, value)} />
        )}
        {kind === 'addNoise' && (
          <>
            <div className="flex rounded-md bg-white/5 p-0.5 ring-1 ring-line" role="radiogroup" aria-label={uiT("ui.72a23e549d09")}>
              {(['uniform', 'gaussian'] as const).map((id) => (
                <button key={id} type="button" role="radio" aria-checked={(settings.gaussian === true) === (id === 'gaussian')} onClick={() => put('gaussian', id === 'gaussian')} className={cn('h-7 flex-1 rounded text-[12px] capitalize', (settings.gaussian === true) === (id === 'gaussian') ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}>
                  {uiT(id === "uniform" ? "canvas.filter.uniform" : "canvas.filter.gaussian")}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between text-[12px] text-fg-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={settings.monochromatic === true} onChange={(event) => put('monochromatic', event.target.checked)} className="accent-(--color-accent)" />
                {uiT("ui.72776d479470")}</label>
              <button type="button" onClick={() => put('seed', crypto.getRandomValues(new Uint32Array(1))[0])} className="flex items-center gap-1 text-fg-3 hover:text-fg">
                <IconArrowsShuffle size={13} />{uiT("ui.7729c097a114")}</button>
            </div>
          </>
        )}
        <div className="flex items-center justify-between text-[11.5px] text-fg-3">
          <label className="flex items-center gap-2 text-[12px] text-fg-2">
            <input type="checkbox" checked={preview} onChange={(event) => setPreview(event.target.checked)} className="accent-(--color-accent)" />
            {uiT("ui.4b55d106344f")}</label>
          <span>{phase === 'applying' ? uiT("ui.4a962cf3b506") : phase === 'previewing' ? uiT("ui.5474eef8d0f1") : reduced ? uiT("ui.60549b96453e") : doc.state.selection ? uiT("ui.95ebf4a6b75a") : ''}</span>
        </div>
        <div className="flex justify-end gap-2">
          <GlassButton type="button" variant="ghost" onClick={() => close(false)}>
            {uiT("ui.0ef70263b054")}</GlassButton>
          <GlassButton type="submit" variant="primary" disabled={phase === 'applying'}>
            OK
          </GlassButton>
        </div>
      </form>
    </Modal>
  )
}
