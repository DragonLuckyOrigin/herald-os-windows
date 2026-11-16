import { t as uiT, useT as useUiT } from '../../store/i18n.ts'
/*
 * The gradient editor, opened from the Gradient tool's options: presets and saved gradients, the
 * gradient with its opacity stops above and colour stops below, and the picked stop's settings.
 * Click above or below the strip to add a stop; drag one along to move it, or away to take it off;
 * drag the diamond between two stops to move where they mix half way.
 */

import { useStore } from '@nanostores/react'
import { IconTrash, IconX } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn.ts'
import { cssOf, type RGB } from './color.ts'
import { ColorPicker } from './ColorPicker.tsx'
import { paintGradient } from './engine/fill.ts'
import { type ColourStop, colourOf, type Gradient, type GradientLine, GRADIENT_PRESETS, type GradientStyle, gradientAt, gradientTable, MID_LIMITS, type OpacityStop, sortedStops } from './engine/gradient.ts'
import { Raster } from './engine/raster.ts'
import { $savedGradients, forgetGradient, saveGradient } from './gradient-presets.ts'
import { $background, $foreground, $gradient } from './tools/state.ts'

/** Under transparent parts of a preview. */
const CHECKER = 'repeating-conic-gradient(#8a8a8a 0 25%, #c8c8c8 0 50%) 0 0 / 8px 8px'

/** A gradient as CSS for previews, sampled finely enough to show its midpoints. */
export function gradientCss(gradient: Gradient, foreground: RGB, background: RGB, reverse = false): string {
  const steps = 48
  const parts = Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps
    const [r, g, b, a] = gradientAt(gradient, reverse ? 1 - t : t, foreground, background)

    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${(a / 255).toFixed(3)}) ${(t * 100).toFixed(1)}%`
  })

  return `linear-gradient(to right, ${parts.join(', ')}), ${CHECKER}`
}

type Track = 'colours' | 'opacities'

interface Picked {
  track: Track
  index: number
  /** The stop itself, or the midpoint between it and the next. */
  part: 'stop' | 'mid'
}

/** How far from its row a stop is dragged to take it off. */
const TEAR_OFF = 28

const EDITOR_WIDTH = 368

const clamp = (value: number, low = 0, high = 1): number => Math.max(low, Math.min(high, value))

/** A number field for a percentage; it takes a value only when it is a number in range. */
function PercentField({ label, value, onChange, min = 0, max = 100 }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number }) {
  useUiT()
  const [draft, setDraft] = useState(String(Math.round(value * 100)))

  useEffect(() => setDraft(String(Math.round(value * 100))), [value])

  return (
    <label className="flex items-center gap-1.5 text-fg-3">
      {label}
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        onChange={(event) => {
          setDraft(event.target.value)
          const number = Number(event.target.value)

          if (event.target.value !== '' && Number.isFinite(number) && number >= min && number <= max) {
            onChange(number / 100)
          }
        }}
        onBlur={() => setDraft(String(Math.round(value * 100)))}
        onKeyDown={(event) => event.stopPropagation()}
        className="glass-input h-6 w-12 rounded-md px-1.5 text-[12px] text-fg tabular-nums outline-none"
      />
      %
    </label>
  )
}

function GradientEditor({ onClose, at }: { onClose: () => void; at: { left: number; top: number } }) {
  useUiT()
  const { gradient } = useStore($gradient)
  const foreground = useStore($foreground)
  const background = useStore($background)
  const saved = useStore($savedGradients)
  const root = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const [picked, setPicked] = useState<Picked | null>({ track: 'colours', index: 0, part: 'stop' })
  const [tearing, setTearing] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [name, setName] = useState('')
  const colours = sortedStops(gradient.colours)
  const opacities = sortedStops(gradient.opacities)

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        onClose()
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)

    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  /** Change one track; an edited preset becomes the person's own gradient. */
  const edit = (track: Track, stops: (ColourStop | OpacityStop)[]) => {
    const current = $gradient.get()
    $gradient.set({ ...current, gradient: { ...current.gradient, name: 'Custom', [track]: stops } })
  }

  const choose = (next: Gradient) => {
    $gradient.set({ ...$gradient.get(), gradient: structuredClone(next) })
    setPicked({ track: 'colours', index: 0, part: 'stop' })
  }

  const positionOf = (clientX: number): number => {
    const rect = strip.current!.getBoundingClientRect()

    return clamp((clientX - rect.left) / rect.width)
  }

  /** Follow the pointer with a stop (or a midpoint) until it lifts; far from the row, the stop comes off. */
  const drag = (track: Track, index: number, part: Picked['part'], start: { clientY: number }) => {
    const latest = $gradient.get().gradient
    let stops: (ColourStop | OpacityStop)[] = sortedStops<ColourStop | OpacityStop>(track === 'colours' ? latest.colours : latest.opacities)
    let current = index
    const away = (clientY: number) => part === 'stop' && stops.length > 2 && Math.abs(clientY - start.clientY) > TEAR_OFF
    setPicked({ track, index, part })

    const move = (event: PointerEvent) => {
      const t = positionOf(event.clientX)

      if (part === 'mid') {
        const a = stops[current]
        const b = stops[current + 1]
        const mid = clamp((t - a.at) / Math.max(1e-6, b.at - a.at), MID_LIMITS[0], MID_LIMITS[1])
        stops = stops.map((entry, i) => (i === current ? { ...entry, mid } : entry))
        edit(track, stops)

        return
      }

      const moved = { ...stops[current], at: t }
      stops = stops.map((entry, i) => (i === current ? moved : entry)).sort((p, q) => p.at - q.at)
      current = stops.indexOf(moved)
      const off = away(event.clientY)
      setTearing(off)
      setPicked({ track, index: current, part })
      edit(track, off ? stops.filter((_, i) => i !== current) : stops)
    }
    const up = (event: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setTearing(false)

      if (away(event.clientY)) {
        setPicked(null)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** A press on a row away from its stops adds one there, mixed from its neighbours, and drags it. */
  const add = (track: Track, event: React.PointerEvent) => {
    if (event.target !== event.currentTarget) {
      return
    }

    event.preventDefault()
    const t = positionOf(event.clientX)
    const [r, g, b, a] = gradientAt(gradient, t, foreground, background)
    const entry = track === 'colours' ? { at: t, colour: [Math.round(r), Math.round(g), Math.round(b)] as RGB, mid: 0.5 } : { at: t, opacity: Math.round((a / 255) * 100) / 100, mid: 0.5 }
    const stops = [...(track === 'colours' ? colours : opacities), entry].sort((p, q) => p.at - q.at)
    edit(track, stops)
    // The new stop moves with the pointer from here.
    drag(track, stops.indexOf(entry), 'stop', event)
  }

  const removePicked = () => {
    if (!picked || picked.part !== 'stop') {
      return
    }

    const stops = picked.track === 'colours' ? colours : opacities

    if (stops.length > 2) {
      edit(picked.track, stops.filter((_, i) => i !== picked.index))
      setPicked(null)
    }
  }

  const pickedColour = picked?.track === 'colours' ? colours[picked.index] : undefined
  const pickedOpacity = picked?.track === 'opacities' ? opacities[picked.index] : undefined
  const pickedStops = picked ? (picked.track === 'colours' ? colours : opacities) : []

  const setPickedStop = (change: Partial<ColourStop> & Partial<OpacityStop>) => {
    if (!picked) {
      return
    }

    const stops = (picked.track === 'colours' ? colours : opacities).map((entry, i) => (i === picked.index ? { ...entry, ...change } : entry))
    const moved = stops[picked.index]
    const sorted = [...stops].sort((p, q) => p.at - q.at)
    edit(picked.track, sorted)
    setPicked({ ...picked, index: sorted.indexOf(moved) })
  }

  /** A row of stops with the midpoints of the picked track between them. */
  const row = (track: Track, stops: (ColourStop | OpacityStop)[]) => (
    <div className="relative h-4 cursor-copy touch-none" onPointerDown={(event) => add(track, event)} aria-label={track === 'colours' ? uiT("ui.c5a5ee8acd75") : uiT("ui.7cffd92dface")}>
      {stops.map((entry, i) => {
        const isPicked = picked?.track === track && picked.index === i && picked.part === 'stop'
        const fill = track === 'colours' ? cssOf(colourOf((entry as ColourStop).colour, foreground, background)) : `hsl(0 0% ${Math.round((1 - (entry as OpacityStop).opacity) * 100)}%)`

        return (
          <button
            key={`${track}-${i}`}
            type="button"
            title={track === 'colours' ? uiT("ui.9b51a2c92fe4", { value1: String(Math.round(entry.at * 100)) }) : uiT("ui.ff8e400f246a", { value1: String(Math.round(entry.at * 100)), value2: String(Math.round((entry as OpacityStop).opacity * 100)) })}
            aria-label={track === 'colours' ? uiT("ui.846ee6da7b71", { value1: String(i + 1) }) : uiT("ui.2cda701415d0", { value1: String(i + 1) })}
            aria-pressed={isPicked}
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              drag(track, i, 'stop', event)
            }}
            className={cn('absolute top-0.5 size-3 -translate-x-1/2 cursor-ew-resize rounded-[3px] ring-1', isPicked ? 'ring-2 ring-accent' : 'ring-white/70', isPicked && tearing && 'opacity-30')}
            style={{ left: `${entry.at * 100}%`, background: fill }}
          />
        )
      })}
      {picked?.track === track &&
        stops.slice(0, -1).map((entry, i) => {
          const next = stops[i + 1]

          if (next.at - entry.at < 0.04) {
            return null
          }

          const isPicked = picked.index === i && picked.part === 'mid'

          return (
            <button
              key={`mid-${i}`}
              type="button"
              title={uiT("ui.af894f837006", { value1: String(Math.round(entry.mid * 100)) })}
              aria-label={uiT("ui.5c468989929a", { value1: String(i + 1) })}
              aria-pressed={isPicked}
              onPointerDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
                drag(track, i, 'mid', event)
              }}
              className={cn('absolute top-1 size-2 -translate-x-1/2 rotate-45 cursor-ew-resize ring-1', isPicked ? 'bg-accent ring-accent' : 'bg-transparent ring-white/70')}
              style={{ left: `${(entry.at + (next.at - entry.at) * entry.mid) * 100}%` }}
            />
          )
        })}
    </div>
  )

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={uiT("ui.0a0d142434d2")}
      className="float menu-surface fixed z-50 rounded-xl p-3 text-[12px] text-fg-2 animate-pop"
      style={{ left: at.left, top: at.top, width: EDITOR_WIDTH }}
      onMouseDown={(event) => event.stopPropagation()}
      // Keys stay in the editor: the canvas's shortcuts would otherwise act on the document.
      onKeyDown={(event) => {
        event.stopPropagation()

        if ((event.key === 'Delete' || event.key === 'Backspace') && !(event.target instanceof HTMLInputElement)) {
          removePicked()
        }
      }}
    >
      <div className="mb-2 flex items-center justify-between text-[11.5px] text-fg-3">
        <span>{uiT("ui.260c2efee9d0")}{gradient.name}</span>
        <button type="button" aria-label={uiT("ui.7d9eb7acb13e")} title={uiT("ui.7d9eb7acb13e")} onClick={onClose} className="grid size-5 place-items-center rounded text-fg-3 hover:bg-white/10 hover:text-fg">
          <IconX size={12} />
        </button>
      </div>
      <div className="grid grid-cols-8 gap-1.5" role="listbox" aria-label={uiT("ui.17c1c1fe8461")}>
        {[...GRADIENT_PRESETS, ...saved].map((preset, i) => (
          <div key={`${preset.name}-${i}`} className="group/reveal-row relative">
            <button
              type="button"
              role="option"
              aria-selected={preset.name === gradient.name}
              title={preset.name}
              aria-label={preset.name}
              onClick={() => choose(preset)}
              className={cn('block h-6 w-full rounded-md ring-1', preset.name === gradient.name ? 'ring-2 ring-accent' : 'ring-line hover:ring-white/50')}
              style={{ background: gradientCss(preset, foreground, background) }}
            />
            {i >= GRADIENT_PRESETS.length && (
              <button
                type="button"
                title={uiT("ui.5492466ecfe5", { value1: String(preset.name) })}
                aria-label={uiT("ui.5492466ecfe5", { value1: String(preset.name) })}
                onClick={() => forgetGradient(preset.name)}
                className="reveal absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-bg-elevated text-fg-2 ring-1 ring-line hover:text-fg"
              >
                <IconX size={9} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 px-1.5">
        {row('opacities', opacities)}
        <div ref={strip} className="my-0.5 h-7 rounded-md ring-1 ring-line" style={{ background: gradientCss(gradient, foreground, background) }} />
        {row('colours', colours)}
      </div>
      <div className="mt-3 flex min-h-7 flex-wrap items-center gap-x-3 gap-y-2">
        {pickedColour && picked?.part === 'stop' && (
          <>
            <div className="relative">
              <button
                type="button"
                title={uiT("ui.c4c07acbe911")}
                aria-label={uiT("ui.23ed921cf80a")}
                onClick={() => setChoosing(true)}
                className="block size-6 rounded-md ring-1 ring-white/40"
                style={{ background: cssOf(colourOf(pickedColour.colour, foreground, background)) }}
              />
              {choosing && (
                <ColorPicker
                  title={uiT("ui.23ed921cf80a")}
                  colour={colourOf(pickedColour.colour, foreground, background)}
                  onChange={(colour) => setPickedStop({ colour })}
                  onClose={() => setChoosing(false)}
                  className="top-full left-0 mt-2"
                />
              )}
            </div>
            <select
              aria-label={uiT("ui.be291c001a67")}
              value={typeof pickedColour.colour === 'string' ? pickedColour.colour : 'own'}
              onChange={(event) => setPickedStop({ colour: event.target.value === 'own' ? ([...colourOf(pickedColour.colour, foreground, background)] as RGB) : (event.target.value as 'foreground' | 'background') })}
              className="glass-input h-6 rounded-md px-1 text-[12px] text-fg outline-none"
            >
              <option value="own">{uiT("ui.5baaeb6e4a3e")}</option>
              <option value="foreground">{uiT("ui.482aa087e5c1")}</option>
              <option value="background">{uiT("ui.743baa308f66")}</option>
            </select>
          </>
        )}
        {pickedOpacity && picked?.part === 'stop' && <PercentField label={uiT("ui.6062652e10dd")} value={pickedOpacity.opacity} onChange={(opacity) => setPickedStop({ opacity })} />}
        {picked?.part === 'stop' && pickedStops[picked.index] && <PercentField label={uiT("ui.15b61974b270")} value={pickedStops[picked.index].at} onChange={(at) => setPickedStop({ at })} />}
        {picked?.part === 'mid' && pickedStops[picked.index] && <PercentField label={uiT("ui.10f69a3669c8")} value={pickedStops[picked.index].mid} min={MID_LIMITS[0] * 100} max={MID_LIMITS[1] * 100} onChange={(mid) => setPickedStop({ mid })} />}
        {picked?.part === 'stop' && (
          <button
            type="button"
            title={uiT("ui.18a654066778")}
            aria-label={uiT("ui.1aebc4a195f1")}
            disabled={pickedStops.length <= 2}
            onClick={removePicked}
            className="ml-auto grid size-6 place-items-center rounded-md text-fg-3 ring-1 ring-line hover:text-fg disabled:opacity-40"
          >
            <IconTrash size={13} />
          </button>
        )}
        {!picked && <span className="text-fg-3">{uiT("ui.33efb511dbb3")}</span>}
      </div>
      <form
        className="mt-3 flex items-center gap-2 border-t border-line pt-3"
        onSubmit={(event) => {
          event.preventDefault()
          const title = name.trim()

          if (title) {
            const named = { ...gradient, name: title }
            saveGradient(named)
            $gradient.set({ ...$gradient.get(), gradient: named })
            setName('')
          }
        }}
      >
        <input
          aria-label={uiT("ui.fbdb4f4a0469")}
          placeholder={uiT("ui.cadce5a7ee8b")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          className="glass-input h-6 min-w-0 flex-1 rounded-md px-2 text-[12px] text-fg outline-none"
        />
        <button type="submit" disabled={!name.trim()} className="h-6 rounded-md px-2.5 text-[12px] text-fg ring-1 ring-line hover:bg-white/8 disabled:opacity-40">
          {uiT("ui.f5f25c5769e6")}</button>
      </form>
    </div>
  )
}

const previews = new Map<GradientStyle, string>()

/** A small black-to-white swatch of a style, drawn as the tool lays it, for the style's button. */
export function stylePreview(style: GradientStyle): string {
  let url = previews.get(style)

  if (!url) {
    const size = 28
    const raster = new Raster(size, size)
    const line: GradientLine = style === 'linear' ? { style, from: [3, 0], to: [25, 0] } : style === 'reflected' ? { style, from: [14, 0], to: [26, 0] } : { style, from: [14, 14], to: [27, 14] }
    const ramp = GRADIENT_PRESETS.find((preset) => preset.name === 'Black to White')!
    paintGradient(raster, raster.bounds, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, { ...line, table: gradientTable(ramp, [0, 0, 0], [255, 255, 255]) }, () => 1)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(raster.data), size, size), 0, 0)
    url = canvas.toDataURL()
    previews.set(style, url)
  }

  return url
}

/** The gradient's preview in the options bar; a click opens the editor under it. */
export function GradientField() {
  useUiT()
  const options = useStore($gradient)
  const foreground = useStore($foreground)
  const background = useStore($background)
  const button = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  const toggle = () => {
    if (at) {
      setAt(null)

      return
    }

    const rect = button.current!.getBoundingClientRect()
    setAt({ left: Math.max(8, Math.min(window.innerWidth - EDITOR_WIDTH - 8, rect.left)), top: rect.bottom + 6 })
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        title={uiT("ui.e8e6c63c9a73", { value1: String(options.gradient.name) })}
        aria-label={uiT("ui.669c34052884")}
        aria-expanded={Boolean(at)}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={toggle}
        className="block h-6 w-28 shrink-0 rounded-md ring-1 ring-white/40"
        style={{ background: gradientCss(options.gradient, foreground, background, options.reverse) }}
      />
      {at && createPortal(<GradientEditor at={at} onClose={() => setAt(null)} />, document.body)}
    </>
  )
}
