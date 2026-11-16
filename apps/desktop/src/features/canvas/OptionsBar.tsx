import { t as uiT, useT as useUiT } from '../../store/i18n.ts'
import { useStore } from '@nanostores/react'
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconArrowsExchange,
  IconCheck,
  IconCircle,
  IconItalic,
  IconBackground,
  IconLayersIntersect,
  IconLayersSubtract,
  IconLayersUnion,
  IconLayoutAlignBottom,
  IconLayoutAlignCenter,
  IconLayoutAlignLeft,
  IconLayoutAlignMiddle,
  IconLayoutAlignRight,
  IconLayoutAlignTop,
  IconLayoutDistributeHorizontal,
  IconLayoutDistributeVertical,
  IconLine,
  IconRulerMeasure,
  IconSquare,
  IconSquareRounded,
  IconSquareToggle,
  IconX
} from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { RANGES, type TextAlignment } from '../../../shared/canvas/comp-format.ts'
import { GlassButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { cssOf, type RGB } from './color.ts'
import { ColorPicker } from './ColorPicker.tsx'
import type { CanvasDocument } from './engine/document.ts'
import { $fontFamilies, loadFonts } from './fonts.ts'
import type { SelectionMode } from './engine/selection.ts'
import { useRevision } from './hooks.ts'
import { alignPicked, distributePicked } from './actions.ts'
import { cannotSegment } from './ai/subject.ts'
import { type AlignEdge, type AlignTo, type DistributeMode } from './engine/align.ts'
import { $dialog } from './menus.ts'
import { CROP_RATIOS, type CropRatio } from './engine/crop.ts'
import { GRADIENT_STYLES } from './engine/gradient.ts'
import { GradientField, stylePreview } from './GradientEditor.tsx'
import { $crop, $cropOptions, $straighten, applyCrop, cancelCrop, cropAngle, cropRect, setCropOptions } from './tools/crop.ts'
import { warmObjectSelect } from './tools/object-select.ts'
import {
  $alignTo,
  $autoSelect,
  $brush,
  $bucket,
  $clone,
  $eraser,
  $eyedropper,
  $foreground,
  $gradient,
  $heal,
  $healing,
  $marquee,
  $objectSelect,
  $refineBrush,
  $selectionMode,
  $shape,
  $showTransform,
  $tool,
  $type,
  $wand,
  type BrushOptions,
  type CloneOptions,
  type ShapeTool,
  toolDef,
  type TypeOptions
} from './tools/state.ts'
import { paintsMask } from './tools/target.ts'
import { $transform, cancelTransform, commitTransform, sessionFor } from './tools/transform.ts'
import { $typing, applyTypeOptions, cancelTyping, commitTyping, optionsFrom } from './tools/type.ts'
import { actualPixels, fitToScreen } from './view-state.ts'

const stop = (event: React.KeyboardEvent) => {
  if (event.key === 'Enter') {
    ;(event.target as HTMLInputElement).blur()
  }

  event.stopPropagation()
}

const ALIGN_LABELS_KEYS = {"left":"canvas.align_labels.left","center":"canvas.align_labels.center","right":"canvas.align_labels.right","top":"canvas.align_labels.top","middle":"canvas.align_labels.middle","bottom":"canvas.align_labels.bottom"} as const
const DISTRIBUTE_LABELS_KEYS = {"left":"canvas.distribute_labels.left","center":"canvas.distribute_labels.center","right":"canvas.distribute_labels.right","top":"canvas.distribute_labels.top","middle":"canvas.distribute_labels.middle","bottom":"canvas.distribute_labels.bottom","horizontal":"canvas.distribute_labels.horizontal","vertical":"canvas.distribute_labels.vertical"} as const
const GRADIENT_STYLE_LABELS_KEYS = {"linear":"canvas.gradient_style_labels.linear","radial":"canvas.gradient_style_labels.radial","angle":"canvas.gradient_style_labels.angle","reflected":"canvas.gradient_style_labels.reflected","diamond":"canvas.gradient_style_labels.diamond"} as const
const CROP_RATIO_LABELS_KEYS = {"free":"canvas.crop_ratio_labels.free","original":"canvas.crop_ratio_labels.original","1:1":"canvas.crop_ratio_labels.1:1","4:5":"canvas.crop_ratio_labels.4:5","3:2":"canvas.crop_ratio_labels.3:2","16:9":"canvas.crop_ratio_labels.16:9","9:16":"canvas.crop_ratio_labels.9:16","custom":"canvas.crop_ratio_labels.custom"} as const

/** A small labelled number field; it takes a value only when it is a number in range. */
function NumberField({ label, value, onChange, min = 0, max = 10_000, step = 1, unit, width = 'w-14', title }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; unit?: string; width?: string; title?: string }) {
  useUiT()
  const [draft, setDraft] = useState(String(value))

  useEffect(() => setDraft(String(Math.round(value * 100) / 100)), [value])

  return (
    <label className="flex items-center gap-1.5 text-fg-3" title={title}>
      {label}
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          setDraft(event.target.value)
          const number = Number(event.target.value)

          if (event.target.value !== '' && Number.isFinite(number) && number >= min && number <= max) {
            onChange(number)
          }
        }}
        onBlur={() => setDraft(String(Math.round(value * 100) / 100))}
        onKeyDown={stop}
        className={cn('glass-input h-6 rounded-md px-1.5 text-[12px] text-fg tabular-nums outline-none', width)}
      />
      {unit && <span>{unit}</span>}
    </label>
  )
}

/** A 0 to 1 setting shown as a percentage. */
const Percent = ({ label, value, onChange, title }: { label: string; value: number; onChange: (value: number) => void; title?: string }) => (
  <NumberField label={label} title={title} value={Math.round(value * 100)} min={0} max={100} unit="%" width="w-12" onChange={(percent) => onChange(percent / 100)} />
)

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  useUiT()
  return (
    <label className="flex items-center gap-1.5">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  )
}

function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (value: T) => void; options: { id: T; label: string; icon?: React.ReactNode }[]; label: string }) {
  useUiT()
  return (
    <div className="flex items-center rounded-md bg-white/5 p-0.5 ring-1 ring-line" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          title={option.label}
          aria-label={option.label}
          onClick={() => onChange(option.id)}
          className={cn('grid h-5 min-w-6 place-items-center rounded px-1 text-[11.5px]', value === option.id ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}
        >
          {option.icon ?? option.label}
        </button>
      ))}
    </div>
  )
}

const MODES: { id: SelectionMode; label: string; icon: React.ReactNode }[] = [
  { id: 'new', get label() { return uiT("ui.3f1a2c73953d") }, icon: <IconSquare size={13} /> },
  { id: 'add', get label() { return uiT("ui.ff00290f0b48") }, icon: <IconLayersUnion size={13} /> },
  { id: 'subtract', get label() { return uiT("ui.3be7376b2e94") }, icon: <IconLayersSubtract size={13} /> },
  { id: 'intersect', get label() { return uiT("ui.db7949ac8060") }, icon: <IconLayersIntersect size={13} /> }
]

function SelectionModes() {
  useUiT()
  const mode = useStore($selectionMode)

  return <Segmented label={uiT("ui.1935ae17c67a")} value={mode} onChange={(next) => $selectionMode.set(next)} options={MODES} />
}

const patch = <T extends object>(store: { get(): T; set(value: T): void }, change: Partial<T>) => store.set({ ...store.get(), ...change })

function CloneFields({ store, doc, healing }: { store: typeof $clone; doc: CanvasDocument; healing: boolean }) {
  useUiT()
  const options = useStore(store)
  const set = (change: Partial<CloneOptions>) => patch(store, change)

  return (
    <>
      <BrushFields store={store} doc={doc} />
      <Check label={uiT("ui.370c4c1eb2cd")} checked={options.aligned} onChange={(aligned) => set({ aligned })} />
      <select aria-label={uiT("ui.95a2f1edb08a")} title={uiT("ui.27a186f279c3")} value={options.allLayers ? 'all' : 'current'} onChange={(event) => set({ allLayers: event.target.value === 'all' })} className="glass-input h-6 rounded-md px-1 text-[12px] text-fg outline-none">
        <option value="current">{uiT("ui.842b4fcc6ff5")}</option>
        <option value="all">{uiT("ui.86bb760029da")}</option>
      </select>
      <span className="text-fg-3">{healing ? uiT("ui.81b1e825d761") : uiT("ui.5b86425368fd")}</span>
    </>
  )
}

function BrushFields({ store, doc }: { store: typeof $brush; doc: CanvasDocument }) {
  useUiT()
  const options = useStore(store) as BrushOptions
  const set = (change: Partial<BrushOptions>) => patch(store, change)

  return (
    <>
      <NumberField label={uiT("ui.1af851907331")} title={uiT("ui.535749713ac4")} value={options.size} min={1} max={5000} unit="px" onChange={(size) => set({ size })} />
      <Percent label={uiT("ui.c5f4f8b1a039")} title={uiT("ui.aae845e7d5fe")} value={options.hardness} onChange={(hardness) => set({ hardness })} />
      <Percent label={uiT("ui.6062652e10dd")} title={uiT("ui.2cc4f03f229e")} value={options.opacity} onChange={(opacity) => set({ opacity })} />
      <Percent label={uiT("ui.f1273dc72c95")} value={options.flow} onChange={(flow) => set({ flow })} />
      <NumberField label={uiT("ui.62a822a58309")} value={Math.round(options.spacing * 100)} min={1} max={200} unit="%" width="w-12" onChange={(spacing) => set({ spacing: spacing / 100 })} />
      {paintsMask(doc) && <span className="rounded-full bg-white/8 px-2 py-0.5 text-[11px] text-fg-2">{uiT("ui.f33c9605edbd")}</span>}
    </>
  )
}

const WEIGHTS: { value: number; label: string }[] = [
  { value: 100, get label() { return uiT("ui.da68daaecfea") } },
  { value: 200, get label() { return uiT("ui.c55da3af0796") } },
  { value: 300, get label() { return uiT("ui.dbcd5e7bb7a0") } },
  { value: 400, get label() { return uiT("ui.b455784ab530") } },
  { value: 500, get label() { return uiT("ui.8e588cd18774") } },
  { value: 600, get label() { return uiT("ui.d442655c0643") } },
  { value: 700, get label() { return uiT("ui.94fee62e68e2") } },
  { value: 800, get label() { return uiT("ui.59322b4f8854") } },
  { value: 900, get label() { return uiT("ui.c6cfe6e4f129") } }
]

function TypeFields({ doc }: { doc: CanvasDocument }) {
  useUiT()
  const options = useStore($type)
  const typing = useStore($typing)
  const foreground = useStore($foreground)
  const fonts = useStore($fontFamilies)
  const [picking, setPicking] = useState(false)
  const [family, setFamily] = useState(options.family)
  const session = typing?.docKey === doc.key ? typing : null
  const layer = !session && doc.active?.text ? doc.active : null
  const style = session?.style ?? layer?.text
  const colour: RGB = style ? [Math.round(style.red * 255), Math.round(style.green * 255), Math.round(style.blue * 255)] : foreground

  useEffect(() => void loadFonts(), [])
  useEffect(() => setFamily(options.family), [options.family])

  // A text layer picked with the Type tool in hand shows its own style here.
  const picked = layer?.text

  useEffect(() => {
    if (picked) {
      $type.set(optionsFrom(picked))
    }
  }, [picked])

  const set = (change: Partial<TypeOptions>) => {
    const next = { ...$type.get(), ...change }
    $type.set(next)

    if (session || layer) {
      applyTypeOptions(doc, next)
    }
  }

  // A family takes effect once it is picked from the list, or typed and confirmed.
  const takeFamily = (value: string) => {
    const name = value.trim()

    if (name && name !== $type.get().family) {
      set({ family: name })
    }
  }

  return (
    <>
      <label className="flex items-center gap-1.5 text-fg-3">
        {uiT("ui.d54f50c583f2")}<input
          list="herald-canvas-fonts"
          value={family}
          onChange={(event) => {
            setFamily(event.target.value)

            if (fonts?.includes(event.target.value)) {
              takeFamily(event.target.value)
            }
          }}
          onBlur={() => takeFamily(family)}
          onKeyDown={stop}
          className="glass-input h-6 w-36 rounded-md px-1.5 text-[12px] text-fg outline-none"
        />
        <datalist id="herald-canvas-fonts">
          {(fonts ?? []).map((family) => (
            <option key={family} value={family} />
          ))}
        </datalist>
      </label>
      <select aria-label={uiT("ui.81d27ef6d503")} value={options.weight} onChange={(event) => set({ weight: Number(event.target.value) })} className="glass-input h-6 rounded-md px-1 text-[12px] text-fg outline-none">
        {WEIGHTS.map((weight) => (
          <option key={weight.value} value={weight.value}>
            {weight.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        title={uiT("ui.9bf37cb58a69")}
        aria-label={uiT("ui.9bf37cb58a69")}
        aria-pressed={options.italic}
        onClick={() => set({ italic: !options.italic })}
        className={cn('grid size-6 place-items-center rounded-md ring-1 ring-line', options.italic ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}
      >
        <IconItalic size={13} />
      </button>
      <NumberField label={uiT("ui.1af851907331")} value={options.size} min={RANGES.fontSize[0]} max={RANGES.fontSize[1]} unit="px" onChange={(size) => set({ size })} />
      <div className="relative">
        <button type="button" title={uiT("ui.25e9c8090de7")} aria-label={uiT("ui.25e9c8090de7")} onClick={() => setPicking(true)} className="block size-6 rounded-md ring-1 ring-white/40" style={{ background: cssOf(colour) }} />
        {picking && (
          <ColorPicker
            title={uiT("ui.25e9c8090de7")}
            colour={colour}
            onChange={(next) => {
              if (session || layer) {
                applyTypeOptions(doc, $type.get(), next)
              } else {
                $foreground.set(next)
              }
            }}
            onClose={() => setPicking(false)}
            className="top-full left-0 mt-2"
          />
        )}
      </div>
      <Segmented<TextAlignment>
        label={uiT("ui.9d597870c4b3")}
        value={options.alignment}
        onChange={(alignment) => set({ alignment })}
        options={[
          { id: 'Left', label: uiT("ui.eac0f9c3da59"), icon: <IconAlignLeft size={13} /> },
          { id: 'Center', label: uiT("ui.45c19322f7b9"), icon: <IconAlignCenter size={13} /> },
          { id: 'Right', label: uiT("ui.8f4f8efcbee1"), icon: <IconAlignRight size={13} /> }
        ]}
      />
      <NumberField label={uiT("ui.36b6ca188619")} title={uiT("ui.1a7b4876c848")} value={options.tracking} min={RANGES.tracking[0]} max={RANGES.tracking[1]} step={0.5} unit="px" width="w-12" onChange={(tracking) => set({ tracking })} />
      <NumberField label={uiT("ui.dd424b34d747")} title={uiT("ui.40e8b5ec0ec9")} value={options.leading} min={RANGES.leading[0]} max={RANGES.leading[1]} step={1} unit="px" width="w-12" onChange={(leading) => set({ leading })} />
      {session && <Confirm onApply={() => void commitTyping(doc)} onCancel={cancelTyping} />}
    </>
  )
}

function Confirm({ onApply, onCancel }: { onApply: () => void; onCancel: () => void }) {
  useUiT()
  return (
    <div className="ml-auto flex items-center gap-1">
      <button type="button" title={uiT("ui.862c2324686b")} aria-label={uiT("ui.19766ed6ccb2")} onClick={onCancel} className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg">
        <IconX size={15} />
      </button>
      <button type="button" title={uiT("ui.08ca52635aab")} aria-label={uiT("ui.31e392d1c037")} onClick={onApply} className="grid size-6 place-items-center rounded-md bg-accent/25 text-fg hover:bg-accent/40">
        <IconCheck size={15} />
      </button>
    </div>
  )
}

const ALIGN_BUTTONS: { edge: AlignEdge; icon: React.ReactNode }[] = [
  { edge: 'left', icon: <IconLayoutAlignLeft size={14} /> },
  { edge: 'center', icon: <IconLayoutAlignCenter size={14} /> },
  { edge: 'right', icon: <IconLayoutAlignRight size={14} /> },
  { edge: 'top', icon: <IconLayoutAlignTop size={14} /> },
  { edge: 'middle', icon: <IconLayoutAlignMiddle size={14} /> },
  { edge: 'bottom', icon: <IconLayoutAlignBottom size={14} /> }
]

const DISTRIBUTE_BUTTONS: { mode: DistributeMode; icon: React.ReactNode }[] = [
  { mode: 'horizontal', icon: <IconLayoutDistributeVertical size={14} /> },
  { mode: 'vertical', icon: <IconLayoutDistributeHorizontal size={14} /> }
]

function IconButton({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  useUiT()
  return (
    <button type="button" title={title} aria-label={title} disabled={disabled} onClick={onClick} className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent">
      {children}
    </button>
  )
}

/** The Move tool's align and distribute buttons, and what the layers line up with. */
function AlignControls({ doc }: { doc: CanvasDocument }) {
  useUiT()
  const to = useStore($alignTo)
  const count = doc.picked.length

  return (
    <div className="flex items-center gap-0.5" role="group" aria-label={uiT("ui.edfac2a81d99")}>
      {ALIGN_BUTTONS.map(({ edge, icon }) => (
        <IconButton key={edge} title={uiT(ALIGN_LABELS_KEYS[edge])} disabled={!count} onClick={() => alignPicked(doc, edge)}>
          {icon}
        </IconButton>
      ))}
      <span className="mx-1 h-4 w-px bg-line" />
      {DISTRIBUTE_BUTTONS.map(({ mode, icon }) => (
        <IconButton key={mode} title={uiT("ui.b6a4843b67e8", { value1: String(uiT(DISTRIBUTE_LABELS_KEYS[mode])) })} disabled={count < 3} onClick={() => distributePicked(doc, mode)}>
          {icon}
        </IconButton>
      ))}
      <select aria-label={uiT("ui.deeb6f87c51b")} title={uiT("ui.4ab908b9ce5b")} value={to} onChange={(event) => $alignTo.set(event.target.value as AlignTo | 'auto')} className="glass-input ml-1 h-6 rounded-md px-1 text-[12px] text-fg outline-none">
        <option value="auto">{uiT("ui.d5f58ab5e38e")}</option>
        <option value="layers">{uiT("ui.2de736ee9d88")}</option>
        <option value="selection">{uiT("ui.b37e6a0c6a49")}</option>
        <option value="canvas">{uiT("ui.50e09328679d")}</option>
      </select>
    </div>
  )
}

function MoveFields({ doc }: { doc: CanvasDocument }) {
  useUiT()
  const autoSelect = useStore($autoSelect)
  const showTransform = useStore($showTransform)
  useStore($transform)
  const session = sessionFor(doc)

  if (session && !session.transient) {
    const { frame } = session

    return (
      <>
        <span className="text-fg-2">{session.quad ? uiT("ui.383eb192e27a") : session.distort ? uiT("ui.4fa1654c2a40") : uiT("ui.0c2693e9555d")}</span>
        {!session.quad && (
          <span className="tabular-nums text-fg-3">
            {Math.round(frame.size[0])} × {Math.round(frame.size[1])} px · {Math.round(frame.rotation * 10) / 10}°
          </span>
        )}
        <span className="text-fg-3">{uiT("ui.a3f259062e9e")}</span>
        <Confirm onApply={() => commitTransform(doc)} onCancel={() => cancelTransform(doc)} />
      </>
    )
  }

  return (
    <>
      <Check label={uiT("ui.04f47d9dcc81")} checked={autoSelect} onChange={(checked) => $autoSelect.set(checked)} />
      <Check label={uiT("ui.0097363067cd")} checked={showTransform} onChange={(checked) => $showTransform.set(checked)} />
      <AlignControls doc={doc} />
      <GlassButton size="sm" variant="ghost" disabled={Boolean(cannotSegment(doc.active))} title={uiT("ui.a0cc55688245")} onClick={() => $dialog.set({ kind: 'remove-background' })}>
        <IconBackground size={14} />{uiT("ui.786510368c94")}</GlassButton>
    </>
  )
}

function ObjectSelectFields({ doc }: { doc: CanvasDocument }) {
  useUiT()
  const options = useStore($objectSelect)

  // The picture is looked at once, as soon as the tool is in hand.
  useEffect(() => warmObjectSelect(doc), [doc, options.allLayers, doc.state.activeLayerId])

  return (
    <>
      <SelectionModes />
      <Check label={uiT("ui.af71e6271c11")} checked={options.allLayers} onChange={(allLayers) => $objectSelect.set({ allLayers })} />
      <span className="text-fg-3">{uiT("ui.861a682d8a64")}</span>
    </>
  )
}

function HealFields() {
  useUiT()
  const options = useStore($heal)

  return (
    <>
      <NumberField label={uiT("ui.1af851907331")} title={uiT("ui.535749713ac4")} value={options.size} min={1} max={2000} unit="px" onChange={(size) => $heal.set({ size })} />
      <span className="text-fg-3">{uiT("ui.f162a8d82700")}</span>
    </>
  )
}

function CropFields({ doc }: { doc: CanvasDocument }) {
  useUiT()
  useStore($crop)
  const options = useStore($cropOptions)
  const straightening = useStore($straighten)
  const rect = cropRect(doc)
  const angle = cropAngle(doc)

  return (
    <>
      <select aria-label={uiT("ui.1348beb03ed9")} title={uiT("ui.cf15d92ad174")} value={options.ratio} onChange={(event) => setCropOptions(doc, { ratio: event.target.value as CropRatio })} className="glass-input h-6 rounded-md px-1 text-[12px] text-fg outline-none">
        {CROP_RATIOS.map((ratio) => (
          <option key={ratio} value={ratio}>
            {uiT(CROP_RATIO_LABELS_KEYS[ratio])}
          </option>
        ))}
      </select>
      {options.ratio === 'custom' && (
        <>
          <NumberField label="W" value={options.custom[0]} min={0.01} max={10_000} step={0.1} width="w-12" onChange={(value) => setCropOptions(doc, { custom: [value, options.custom[1]] })} />
          <NumberField label="H" value={options.custom[1]} min={0.01} max={10_000} step={0.1} width="w-12" onChange={(value) => setCropOptions(doc, { custom: [options.custom[0], value] })} />
        </>
      )}
      <button
        type="button"
        title={uiT("ui.b7171a9b9ae4")}
        aria-label={uiT("ui.46494f401f46")}
        aria-pressed={options.swapped}
        disabled={options.ratio === 'free'}
        onClick={() => setCropOptions(doc, { swapped: !options.swapped })}
        className={cn('grid size-6 place-items-center rounded-md ring-1 ring-line disabled:opacity-35', options.swapped ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}
      >
        <IconArrowsExchange size={13} />
      </button>
      <button
        type="button"
        title={uiT("ui.c338067c1c07")}
        aria-pressed={straightening}
        onClick={() => $straighten.set(!straightening)}
        className={cn('flex h-6 items-center gap-1 rounded-md px-1.5 ring-1 ring-line', straightening ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}
      >
        <IconRulerMeasure size={13} />{uiT("ui.f1318f4c9716")}</button>
      <span className="tabular-nums text-fg-2">
        {rect.width} × {rect.height} px{angle ? uiT("ui.fc2fecd83b0d", { value1: String(angle) }) : ''}
      </span>
      <span className="text-fg-3">{straightening ? uiT("ui.c3d7afa5abf7") : uiT("ui.f4acb29d1495")}</span>
      <Confirm onApply={() => applyCrop(doc)} onCancel={cancelCrop} />
    </>
  )
}

const SHAPES: { id: ShapeTool; label: string; icon: React.ReactNode }[] = [
  { id: 'rectangle', get label() { return uiT("ui.0306996228eb") }, icon: <IconSquare size={13} /> },
  { id: 'rounded', get label() { return uiT("ui.c93421a7b10b") }, icon: <IconSquareRounded size={13} /> },
  { id: 'ellipse', get label() { return uiT("ui.cb1ee8cb964f") }, icon: <IconCircle size={13} /> },
  { id: 'line', get label() { return uiT("ui.d7852cd0d245") }, icon: <IconLine size={13} /> }
]

export function OptionsBar({ doc }: { doc: CanvasDocument }) {
  useUiT()
  useRevision(doc)
  const tool = useStore($tool)
  const marquee = useStore($marquee)
  const wand = useStore($wand)
  const bucket = useStore($bucket)
  const gradient = useStore($gradient)
  const eyedropper = useStore($eyedropper)
  const shape = useStore($shape)
  const refineBrush = useStore($refineBrush)

  return (
    <div className="flex h-9 shrink-0 items-center gap-3 overflow-x-auto border-b border-line px-3 text-[12px] whitespace-nowrap text-fg-2">
      <span className="text-fg-3">{toolDef(tool).label}</span>
      {tool === 'move' && <MoveFields doc={doc} />}
      {(tool === 'marquee' || tool === 'ellipse-marquee') && (
        <>
          <SelectionModes />
          <NumberField label={uiT("ui.b6898405df49")} value={marquee.feather} min={0} max={1000} unit="px" width="w-12" onChange={(feather) => $marquee.set({ feather })} />
        </>
      )}
      {(tool === 'lasso' || tool === 'polygon-lasso') && (
        <>
          <SelectionModes />
          {tool === 'polygon-lasso' && <span className="text-fg-3">{uiT("ui.7daf94322377")}</span>}
        </>
      )}
      {tool === 'wand' && (
        <>
          <SelectionModes />
          <NumberField label={uiT("ui.f71041bb481f")} value={wand.tolerance} min={0} max={255} width="w-12" onChange={(tolerance) => patch($wand, { tolerance })} />
          <Check label={uiT("ui.ac0e773103db")} checked={wand.contiguous} onChange={(contiguous) => patch($wand, { contiguous })} />
          <Check label={uiT("ui.af71e6271c11")} checked={wand.allLayers} onChange={(allLayers) => patch($wand, { allLayers })} />
        </>
      )}
      {tool === 'object-select' && <ObjectSelectFields doc={doc} />}
      {tool === 'heal' && <HealFields />}
      {tool === 'refine' && (
        <>
          <NumberField label={uiT("ui.1af851907331")} title={uiT("ui.535749713ac4")} value={refineBrush.size} min={1} max={2000} unit="px" onChange={(size) => $refineBrush.set({ size })} />
          <span className="text-fg-3">{uiT("ui.41fa735620b3")}</span>
        </>
      )}
      {tool === 'crop' && <CropFields doc={doc} />}
      {tool === 'eyedropper' && (
        <Segmented
          label={uiT("ui.95a2f1edb08a")}
          value={eyedropper.allLayers ? 'all' : 'layer'}
          onChange={(value) => $eyedropper.set({ allLayers: value === 'all' })}
          options={[
            { id: 'all', label: uiT("ui.af71e6271c11") },
            { id: 'layer', label: uiT("ui.ec42e0227c20") }
          ]}
        />
      )}
      {tool === 'brush' && <BrushFields store={$brush} doc={doc} />}
      {tool === 'eraser' && <BrushFields store={$eraser} doc={doc} />}
      {tool === 'clone' && <CloneFields store={$clone} doc={doc} healing={false} />}
      {tool === 'healing' && <CloneFields store={$healing} doc={doc} healing />}
      {tool === 'bucket' && (
        <>
          <NumberField label={uiT("ui.f71041bb481f")} value={bucket.tolerance} min={0} max={255} width="w-12" onChange={(tolerance) => patch($bucket, { tolerance })} />
          <Check label={uiT("ui.ac0e773103db")} checked={bucket.contiguous} onChange={(contiguous) => patch($bucket, { contiguous })} />
          <Check label={uiT("ui.af71e6271c11")} checked={bucket.allLayers} onChange={(allLayers) => patch($bucket, { allLayers })} />
          <Percent label={uiT("ui.6062652e10dd")} value={bucket.opacity} onChange={(opacity) => patch($bucket, { opacity })} />
        </>
      )}
      {tool === 'gradient' && (
        <>
          <GradientField />
          <Segmented
            label={uiT("ui.5dbccb422e95")}
            value={gradient.style}
            onChange={(style) => patch($gradient, { style })}
            options={GRADIENT_STYLES.map((style) => ({ id: style, label: uiT(GRADIENT_STYLE_LABELS_KEYS[style]), icon: <img src={stylePreview(style)} alt="" className="size-3.5 rounded-[2px]" /> }))}
          />
          <button
            type="button"
            title={uiT("ui.fae1c6f105d6")}
            aria-label={uiT("ui.fae1c6f105d6")}
            aria-pressed={gradient.reverse}
            onClick={() => patch($gradient, { reverse: !gradient.reverse })}
            className={cn('grid size-6 place-items-center rounded-md ring-1 ring-line', gradient.reverse ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}
          >
            <IconSquareToggle size={13} />
          </button>
          <Percent label={uiT("ui.6062652e10dd")} value={gradient.opacity} onChange={(opacity) => patch($gradient, { opacity })} />
        </>
      )}
      {tool === 'type' && <TypeFields doc={doc} />}
      {tool === 'shape' && (
        <>
          <Segmented label={uiT("ui.e0e492707f85")} value={shape.kind} onChange={(kind) => patch($shape, { kind })} options={SHAPES} />
          {shape.kind === 'rounded' && <NumberField label={uiT("ui.6fe0661c82d1")} value={shape.radius} min={0} max={5000} unit="px" width="w-12" onChange={(radius) => patch($shape, { radius })} />}
          {shape.kind === 'line' && <NumberField label={uiT("ui.3019947b6daf")} value={shape.lineWidth} min={1} max={1000} unit="px" width="w-12" onChange={(lineWidth) => patch($shape, { lineWidth })} />}
          <span className="text-fg-3">{uiT("ui.34cf06a7f078")}</span>
        </>
      )}
      {(tool === 'zoom' || tool === 'hand') && (
        <div className="flex items-center gap-1.5">
          <GlassButton size="sm" variant="ghost" onClick={() => fitToScreen(doc)}>
            {uiT("ui.dfb6187cfdaa")}</GlassButton>
          <GlassButton size="sm" variant="ghost" onClick={() => actualPixels(doc)}>
            100%
          </GlassButton>
        </div>
      )}
    </div>
  )
}
