import { t as uiT, useT as useUiT } from '../../store/i18n.ts'
import { useStore } from '@nanostores/react'
import { GlassButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { REFINE_RANGES, REFINE_VIEWS, type RefineSettings, type RefineView } from './engine/refine-edge.ts'
import { $selectMask, applySelectMask, cancelSelectMask, REFINE_OUTPUTS, type RefineOutput, updateSelectMask } from './select-mask.ts'
import { $refineBrush } from './tools/state.ts'

/*
 * Select and Mask's panel, over the canvas so the picture stays in view and the Refine Edge brush
 * can paint on it: view mode, edge detection, global refinements and output.
 */

function Slider({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (value: number) => void }) {
  useUiT()
  return (
    <label className="grid grid-cols-[6.5rem_1fr_3.5rem] items-center gap-2 text-[12px] text-fg-2">
      {label}
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="accent-(--color-accent)" />
      <span className="text-right text-fg-3 tabular-nums">
        {value}
        {unit}
      </span>
    </label>
  )
}

function Heading({ children }: { children: React.ReactNode }) {
  useUiT()
  return <div className="mt-1 text-[10.5px] font-medium tracking-wide text-fg-3 uppercase">{children}</div>
}

export function SelectMaskPanel() {
  useUiT()
  const session = useStore($selectMask)
  const brush = useStore($refineBrush)

  if (!session) {
    return null
  }

  const settings = session.settings
  const set = (change: Partial<RefineSettings>) => updateSelectMask({ settings: { ...settings, ...change } })
  const pixelsOut = session.output === 'layer' || session.output === 'layerMask'

  return (
    <div role="dialog" aria-label={uiT("ui.0e794170058e")} className="float menu-surface absolute top-12 right-2 z-40 flex max-h-[calc(100%-4rem)] w-72 flex-col gap-2.5 overflow-y-auto rounded-2xl p-4 animate-pop" onKeyDown={(event) => event.stopPropagation()}>
      <div className="flex items-center justify-between">
        <div className="text-[14px] font-medium text-fg">{uiT("ui.0e794170058e")}</div>
        <span className="text-[11px] text-fg-3">{session.busy ? uiT("ui.5474eef8d0f1") : session.scale < 1 ? uiT("ui.e364e9dbb140") : ''}</span>
      </div>
      <label className="flex items-center justify-between gap-2 text-[12px] text-fg-2">
        {uiT("ui.9a92a27a2688")}<select aria-label={uiT("ui.dcc839a4015c")} value={session.view} onChange={(event) => updateSelectMask({ view: event.target.value as RefineView })} className="glass-input h-7 w-44 rounded-md px-1.5 text-[12px] text-fg outline-none">
          {REFINE_VIEWS.map((view) => (
            <option key={view.id} value={view.id}>
              {view.label}
            </option>
          ))}
        </select>
      </label>
      <Heading>{uiT("ui.945176a0ae81")}</Heading>
      <Slider label={uiT("ui.6fe0661c82d1")} value={settings.radius} min={REFINE_RANGES.radius[0]} max={60} unit=" px" onChange={(radius) => set({ radius })} />
      <label className="flex items-center gap-2 text-[12px] text-fg-2">
        <input type="checkbox" checked={settings.smartRadius} onChange={(event) => set({ smartRadius: event.target.checked })} className="accent-(--color-accent)" />
        {uiT("ui.c5254939d9cc")}</label>
      <Slider label={uiT("ui.3f5e57ac13af")} value={brush.size} min={4} max={400} unit=" px" onChange={(size) => $refineBrush.set({ size })} />
      <p className="-mt-1 text-[11px] text-fg-3">{uiT("ui.0b265248eb43")}</p>
      <Heading>{uiT("ui.9e0c1cee7846")}</Heading>
      <Slider label={uiT("ui.da5193877772")} value={settings.smooth} min={REFINE_RANGES.smooth[0]} max={REFINE_RANGES.smooth[1]} onChange={(smooth) => set({ smooth })} />
      <Slider label={uiT("ui.b6898405df49")} value={settings.feather} min={REFINE_RANGES.feather[0]} max={100} step={0.5} unit=" px" onChange={(feather) => set({ feather })} />
      <Slider label={uiT("ui.08795ba031bc")} value={settings.contrast} min={REFINE_RANGES.contrast[0]} max={REFINE_RANGES.contrast[1]} unit="%" onChange={(contrast) => set({ contrast })} />
      <Slider label={uiT("ui.925de844986b")} value={settings.shiftEdge} min={REFINE_RANGES.shiftEdge[0]} max={REFINE_RANGES.shiftEdge[1]} unit="%" onChange={(shiftEdge) => set({ shiftEdge })} />
      <Heading>{uiT("ui.b2439bcb8dee")}</Heading>
      <label className={cn('flex items-center gap-2 text-[12px] text-fg-2', !pixelsOut && 'opacity-50')}>
        <input type="checkbox" disabled={!pixelsOut} checked={session.decontaminate} onChange={(event) => updateSelectMask({ decontaminate: event.target.checked })} className="accent-(--color-accent)" />
        {uiT("ui.98e6c9a9a75e")}</label>
      {pixelsOut && session.decontaminate && <Slider label={uiT("ui.49e96d7cdf58")} value={session.amount} min={0} max={100} unit="%" onChange={(amount) => updateSelectMask({ amount })} />}
      <label className="flex items-center justify-between gap-2 text-[12px] text-fg-2">
        {uiT("ui.201b1a1fe65a")}<select aria-label={uiT("ui.f71d9615bbd5")} value={session.output} onChange={(event) => updateSelectMask({ output: event.target.value as RefineOutput })} className="glass-input h-7 w-44 rounded-md px-1.5 text-[12px] text-fg outline-none">
          {REFINE_OUTPUTS.map((output) => (
            <option key={output.id} value={output.id}>
              {output.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-[12px] text-fg-2">
        <input type="checkbox" checked={session.sampleAll} onChange={(event) => updateSelectMask({ sampleAll: event.target.checked })} className="accent-(--color-accent)" />
        {uiT("ui.281e6cdbd6f5")}</label>
      <div className="mt-1 flex justify-end gap-2">
        <GlassButton variant="ghost" onClick={cancelSelectMask}>
          {uiT("ui.0ef70263b054")}</GlassButton>
        <GlassButton variant="primary" onClick={() => void applySelectMask()}>
          OK
        </GlassButton>
      </div>
    </div>
  )
}
