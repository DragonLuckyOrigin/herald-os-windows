import { t as uiT, useT as useUiT } from '../../store/i18n.ts'
import { useEffect, useState } from 'react'
import { LIMITS } from '../../../shared/canvas/comp-format.ts'
import { GlassButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import type { Background } from './engine/project.ts'
import { $dialog } from './menus.ts'
import { $documents, closeDocument, createDocument, save } from './store.ts'

/**
 * A dialog over the Canvas window (not the whole desktop). Beside the canvas (`aside`), it leaves
 * the picture in view for a dialog that previews its change there, and a click outside does not
 * close it.
 */
export function Modal({ title, children, onClose, className, aside }: { title: string; children: React.ReactNode; onClose: () => void; className?: string; aside?: boolean }) {
  useUiT()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)

    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className={cn('absolute inset-0 z-40 p-6', aside ? 'flex items-start justify-end pt-24 pr-80' : 'grid place-items-center bg-black/35')} onMouseDown={aside ? undefined : onClose}>
      <div role="dialog" aria-label={title} className={cn('float menu-surface w-full max-w-md rounded-2xl p-5 animate-pop', aside && 'max-w-sm', className)} onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 text-[14px] font-medium text-fg">{title}</div>
        {children}
      </div>
    </div>
  )
}

const PRESETS: { label: string; width: number; height: number; resolution?: number }[] = [
  { label: 'Full HD', width: 1920, height: 1080 },
  { label: '4K', width: 3840, height: 2160 },
  { get label() { return uiT("ui.f2648c8a97d4") }, width: 1080, height: 1080 },
  { get label() { return uiT("ui.e9e509dcd358") }, width: 1080, height: 1920 },
  { get label() { return uiT("ui.8a384071c2ef") }, width: 2480, height: 3508, resolution: 300 },
  { get label() { return uiT("ui.a35abcd6dac9") }, width: 1024, height: 1024 }
]

export function NumberField({ label, value, onChange, unit, min = 1, max = LIMITS.side, autoFocus }: { label: string; value: number; onChange: (value: number) => void; unit: string; min?: number; max?: number; autoFocus?: boolean }) {
  useUiT()
  return (
    <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
      {label}
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          autoFocus={autoFocus}
          onFocus={(event) => autoFocus && event.target.select()}
          min={min}
          max={max}
          value={Number.isFinite(value) ? value : ''}
          onChange={(event) => onChange(Math.round(Number(event.target.value)))}
          className="glass-input h-8 w-full rounded-lg px-2 text-[13px] text-fg tabular-nums outline-none"
        />
        <span className="w-6 shrink-0">{unit}</span>
      </div>
    </label>
  )
}

export function NewDocumentDialog() {
  useUiT()
  const [width, setWidth] = useState(1920)
  const [height, setHeight] = useState(1080)
  const [resolution, setResolution] = useState(72)
  const [background, setBackground] = useState<Background>('white')
  const valid = width >= 1 && height >= 1 && width <= LIMITS.side && height <= LIMITS.side && width * height <= LIMITS.sourcePixels && resolution >= 1
  const close = () => $dialog.set(null)

  const create = () => {
    if (valid) {
      createDocument(width, height, background, resolution)
      close()
    }
  }

  return (
    <Modal title={uiT("ui.1699c3199088")} onClose={close}>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => {
              setWidth(preset.width)
              setHeight(preset.height)
              setResolution(preset.resolution ?? 72)
            }}
            className={cn(
              'rounded-full border px-2.5 py-1 text-[11.5px]',
              width === preset.width && height === preset.height ? 'border-accent bg-accent/15 text-fg' : 'border-line text-fg-2 hover:bg-white/6'
            )}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <form
        className="grid grid-cols-3 gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          create()
        }}
      >
        <NumberField label={uiT("ui.3019947b6daf")} value={width} onChange={setWidth} unit="px" />
        <NumberField label={uiT("ui.bfe2eca40179")} value={height} onChange={setHeight} unit="px" />
        <NumberField label={uiT("ui.d4055fafa379")} value={resolution} onChange={setResolution} unit="ppi" max={10_000} />
        <div className="col-span-3 flex items-center gap-2 text-[12px] text-fg-2">
          <span className="text-fg-3">{uiT("ui.ea2b8a878841")}</span>
          {(['white', 'black', 'transparent'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => setBackground(kind)}
              className={cn('rounded-full border px-2.5 py-1 capitalize', background === kind ? 'border-accent bg-accent/15 text-fg' : 'border-line hover:bg-white/6')}
            >
              {kind}
            </button>
          ))}
        </div>
        {!valid && <div className="col-span-3 text-[11.5px] text-danger">{uiT("ui.08c05eadf48e")}{LIMITS.side.toLocaleString()}{uiT("ui.5af212077913")}{(LIMITS.sourcePixels / 1_000_000).toLocaleString()}{uiT("ui.0c56abda5672")}</div>}
        <div className="col-span-3 mt-1 flex justify-end gap-2">
          <GlassButton type="button" variant="ghost" onClick={close}>
            {uiT("ui.0ef70263b054")}</GlassButton>
          <GlassButton type="submit" variant="primary" disabled={!valid}>
            {uiT("ui.672ffa473180")}</GlassButton>
        </div>
      </form>
    </Modal>
  )
}

/** What an import or an export could not carry over exactly, listed once it is done. */
export function NotesDialog({ title, notes }: { title: string; notes: string[] }) {
  useUiT()
  const close = () => $dialog.set(null)

  return (
    <Modal title={title} onClose={close}>
      <p className="mb-2 text-[12.5px] text-fg-2">{uiT("ui.08e68622f9b2")}</p>
      <ul className="mb-5 flex max-h-72 list-disc flex-col gap-1.5 overflow-y-auto pl-5 text-[12px] text-fg-2">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <div className="flex justify-end">
        <GlassButton variant="primary" autoFocus onClick={close}>
          OK
        </GlassButton>
      </div>
    </Modal>
  )
}

/** Close a document, asking first when it has unsaved edits. */
export function CloseDialog({ docKey }: { docKey: string }) {
  useUiT()
  const doc = $documents.get().find((entry) => entry.key === docKey)
  const close = () => $dialog.set(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!doc) {
      close()
    } else if (!doc.modified) {
      closeDocument(doc.key)
      close()
    }
  }, [doc])

  if (!doc?.modified) {
    return null
  }

  return (
    <Modal title={uiT("ui.13ba9400425f", { value1: String(doc.name) })} onClose={close}>
      <p className="mb-5 text-[12.5px] text-fg-2">{doc.path ? uiT("ui.7db60e5246ee") : uiT("ui.ddd5871fe28b")}</p>
      <div className="flex justify-end gap-2">
        <GlassButton
          variant="danger"
          onClick={() => {
            closeDocument(doc.key)
            close()
          }}
        >
          {uiT("ui.037bcb60247d")}</GlassButton>
        <GlassButton variant="ghost" onClick={close}>
          {uiT("ui.0ef70263b054")}</GlassButton>
        <GlassButton
          variant="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            save(doc)
              .then((saved) => {
                if (saved) {
                  closeDocument(doc.key)
                  close()
                }
              })
              .catch(() => {})
              .finally(() => setBusy(false))
          }}
        >
          {uiT("ui.f5f25c5769e6")}</GlassButton>
      </div>
    </Modal>
  )
}
