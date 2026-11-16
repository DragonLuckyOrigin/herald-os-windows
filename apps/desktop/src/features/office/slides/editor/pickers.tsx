import { t as uiT, useT as useUiT, $language as $uiLanguage } from '../../../../store/i18n.ts'
import { IconArrowRight, IconCheck, IconCircleDot } from '@tabler/icons-react'
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../../../lib/cn.ts'
import type { Color, Deck, Fill, FontRef, LayoutId, Slide, Theme } from '../deck.ts'
import { LAYOUTS, SLOTS } from '../deck.ts'
import { gradientFill } from '../elements.ts'
import { newSlide } from '../layouts.ts'
import { COMMON_FONTS, fontStack, isSlot, normalHex, resolveColor } from '../themes.ts'
import { gradientCss } from '../view/paint.tsx'
import { SlideView } from '../view/SlideView.tsx'

/*
 * The formatting bar's pop-up choosers: colours (the theme's slots first, so a colour follows the
 * theme), fills (a colour or a gradient between two), fonts (the theme's, then the computer's),
 * sizes, a table's rows and columns, layouts and themes, each drawn as it will look. They are
 * marked like the bar, so picking from them keeps the text being typed into.
 */

/**
 * A pop-up under its button; closes on Escape and on a press outside both. It is drawn over the
 * window, since the bar scrolls sideways and so would clip anything hanging below it.
 */
export function Popover({ open, onClose, anchor, children, className, align = 'left' }: { open: boolean; onClose: () => void; anchor: React.RefObject<HTMLElement | null>; children: ReactNode; className?: string; align?: 'left' | 'right' }) {
  useUiT()
  const panel = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const onDown = (event: PointerEvent) => {
      const target = event.target as Node

      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) {
        onClose()
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)

    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose, anchor])

  useLayoutEffect(() => {
    if (!open) {
      return
    }

    const place = () => {
      const box = anchor.current?.getBoundingClientRect()
      const self = panel.current

      if (!box || !self) {
        return
      }

      const left = align === 'right' ? box.right - self.offsetWidth : box.left
      setAt({ left: Math.max(8, Math.min(left, window.innerWidth - self.offsetWidth - 8)), top: Math.max(8, Math.min(box.bottom + 4, window.innerHeight - self.offsetHeight - 8)) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)

    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, align])

  if (!open) {
    return null
  }

  return createPortal(
    <div ref={panel} role="dialog" data-slides-keep-editing="" className={cn('float menu-surface fixed z-50 rounded-xl p-2 animate-pop', className)} style={at ?? { left: 0, top: 0, visibility: 'hidden' }} onMouseDown={(event) => event.preventDefault()}>
      {children}
    </div>,
    document.body
  )
}

/** A bar button that opens a pop-up. */
export function PopoverButton({ label, children, panel, className, active, disabled, align, panelClassName }: { label: string; children: ReactNode; panel: (close: () => void) => ReactNode; className?: string; active?: boolean; disabled?: boolean; align?: 'left' | 'right'; panelClassName?: string }) {
  useUiT()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const close = () => setOpen(false)

  return (
    <div className="relative">
      <button
        ref={anchor}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen(!open)}
        className={cn('flex h-7 items-center gap-1 rounded-md px-1.5 text-fg-2 hover:bg-white/8 hover:text-fg disabled:opacity-40 [&_svg]:size-4', (open || active) && 'bg-white/12 text-fg', className)}
      >
        {children}
      </button>
      <Popover open={open} onClose={close} anchor={anchor} align={align} className={panelClassName}>
        {panel(close)}
      </Popover>
    </div>
  )
}

const STANDARD = ['#000000', '#404040', '#7f7f7f', '#bfbfbf', '#ffffff', '#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0']

export function ColorGrid({ theme, value, onPick, none, noneLabel = uiT('slides.arrowNone') }: { theme: Theme; value: Color | null; onPick: (color: Color | null) => void; none?: boolean; noneLabel?: string }) {
  useUiT()
  const custom = useRef<HTMLInputElement>(null)
  const swatch = (color: Color, title: string) => (
    <button
      key={color}
      type="button"
      title={title}
      aria-label={title}
      onClick={() => onPick(color)}
      className={cn('grid size-6 place-items-center rounded-md border border-black/10', value === color && 'ring-2 ring-accent ring-offset-1 ring-offset-transparent')}
      style={{ background: resolveColor(color, theme) }}
    />
  )

  return (
    <div className="flex w-[232px] flex-col gap-2">
      <div className="text-[11px] font-medium tracking-wide text-fg-3 uppercase">{uiT("ui.efb52e7172b7")}</div>
      <div className="grid grid-cols-8 gap-1.5">{SLOTS.map((slot) => swatch(slot, `${slotLabel(slot)} (${theme.name})`))}</div>
      <div className="text-[11px] font-medium tracking-wide text-fg-3 uppercase">{uiT("ui.ef6691545d2c")}</div>
      <div className="grid grid-cols-8 gap-1.5">{STANDARD.map((hex) => swatch(hex as Color, hex))}</div>
      <div className="flex items-center gap-2 pt-1">
        {none && (
          <button type="button" onClick={() => onPick(null)} className={cn('h-7 flex-1 rounded-md border border-line text-[12px] text-fg-2 hover:bg-white/8', value === null && 'border-accent text-fg')}>
            {noneLabel}
          </button>
        )}
        <button type="button" onClick={() => custom.current?.click()} className="h-7 flex-1 rounded-md border border-line text-[12px] text-fg-2 hover:bg-white/8">
          {uiT("ui.c2dc74cc7f90")}</button>
        <input
          ref={custom}
          type="color"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          defaultValue={value && !isSlot(value) ? value : '#2f7dff'}
          onChange={(event) => {
            const hex = normalHex(event.target.value)

            if (hex) {
              onPick(hex)
            }
          }}
        />
      </div>
    </div>
  )
}

/** A fill's look for a swatch: its gradient, or its colour (nothing for no fill). */
export const fillCss = (fill: Fill | null, theme: Theme): string => (fill?.gradient ? gradientCss(fill.gradient, theme) : fill ? resolveColor(fill.color, theme) : 'transparent')

const ANGLES = [0, 45, 90, 135, 180, 225, 270, 315]

interface GradientSettings {
  from: Color
  to: Color
  angle: number
  radial: boolean
}

function gradientOf(settings: GradientSettings): Fill {
  const fill = gradientFill(settings.from, settings.to, settings.angle)

  return settings.radial && fill.gradient ? { ...fill, gradient: { ...fill.gradient, radial: true } } : fill
}

/** Where a gradient panel starts: the fill's own gradient, else from its colour to the background (or the first accent). */
function startingGradient(value: Fill | null): GradientSettings {
  const stops = [...(value?.gradient?.stops ?? [])].sort((a, b) => a.at - b.at)
  const from = stops[0]?.color ?? value?.color ?? 'accent1'

  return { from, to: stops[stops.length - 1]?.color ?? (from === 'bg1' ? 'accent1' : 'bg1'), angle: value?.gradient?.angle ?? 90, radial: Boolean(value?.gradient?.radial) }
}

/**
 * A fill: a colour, or a gradient between two colours of the palette along an angle or out from
 * the middle. A colour is picked once; a gradient changes as it is tuned, from the moment Gradient
 * is chosen.
 */
export function FillPanel({ theme, value, onColor, onGradient, noneLabel }: { theme: Theme; value: Fill | null; onColor: (color: Color | null) => void; onGradient: (fill: Fill) => void; noneLabel: string }) {
  useUiT()
  const [mode, setMode] = useState<'solid' | 'gradient'>(value?.gradient ? 'gradient' : 'solid')
  const [settings, setSettings] = useState(() => startingGradient(value))
  const [stop, setStop] = useState<'from' | 'to'>('from')
  const tune = (patch: Partial<GradientSettings>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    onGradient(gradientOf(next))
  }
  const tab = (which: 'solid' | 'gradient', label: string) => (
    <button
      type="button"
      aria-pressed={mode === which}
      onClick={() => {
        setMode(which)

        if (which === 'gradient' && !value?.gradient) {
          onGradient(gradientOf(settings))
        }
      }}
      className={cn('h-6 flex-1 rounded-md text-[12px] text-fg-2 hover:text-fg', mode === which && 'bg-white/12 text-fg')}
    >
      {label}
    </button>
  )

  return (
    <div className="flex w-[232px] flex-col gap-2">
      <div className="flex gap-1 rounded-lg bg-white/5 p-0.5">
        {tab('solid', 'Solid')}
        {tab('gradient', 'Gradient')}
      </div>
      {mode === 'solid' ? (
        <ColorGrid theme={theme} value={value && !value.gradient ? value.color : null} none noneLabel={noneLabel} onPick={onColor} />
      ) : (
        <>
          <div className="h-6 rounded-md border border-black/10" style={{ background: fillCss(gradientOf(settings), theme) }} />
          <div className="flex gap-1.5 text-[12px] text-fg-2">
            {(['from', 'to'] as const).map((which) => (
              <button key={which} type="button" aria-pressed={stop === which} onClick={() => setStop(which)} className={cn('flex h-7 flex-1 items-center gap-2 rounded-md border border-line px-2 hover:bg-white/8', stop === which && 'border-accent text-fg')}>
                <span className="size-3.5 rounded-sm border border-black/10" style={{ background: resolveColor(settings[which], theme) }} />
                {which === 'from' ? uiT("ui.218197693424") : uiT("ui.f4b06ef6d3c8")}
              </button>
            ))}
          </div>
          <ColorGrid theme={theme} value={settings[stop]} onPick={(color) => color && tune({ [stop]: color })} />
          <div className="flex items-center justify-between">
            {ANGLES.map((angle) => (
              <button
                key={angle}
                type="button"
                title={`${angle}°`}
                aria-label={uiT("ui.3999500366e9", { value1: String(angle) })}
                aria-pressed={!settings.radial && settings.angle === angle}
                disabled={settings.radial}
                onClick={() => tune({ angle })}
                className={cn('grid size-6 place-items-center rounded-md text-fg-2 hover:bg-white/8 hover:text-fg disabled:opacity-40', !settings.radial && settings.angle === angle && 'bg-white/12 text-fg')}
              >
                <IconArrowRight size={14} style={{ transform: `rotate(${angle}deg)` }} />
              </button>
            ))}
            <button type="button" title={uiT("ui.02693d5af964")} aria-label={uiT("ui.02693d5af964")} aria-pressed={settings.radial} onClick={() => tune({ radial: !settings.radial })} className={cn('grid size-6 place-items-center rounded-md text-fg-2 hover:bg-white/8 hover:text-fg', settings.radial && 'bg-white/12 text-fg')}>
              <IconCircleDot size={14} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}

let systemFonts: Promise<string[]> | null = null

const loadSystemFonts = (): Promise<string[]> => {
  systemFonts ??= window.heraldOS.fonts
    .list()
    .then((fonts) => [...new Set(fonts)].sort((a, b) => a.localeCompare(b)))
    .catch(() => [])

  return systemFonts
}

export function FontList({ theme, value, onPick }: { theme: Theme; value: FontRef; onPick: (font: FontRef) => void }) {
  useUiT()
  const [fonts, setFonts] = useState<string[]>([])
  const [filter, setFilter] = useState('')

  useEffect(() => {
    void loadSystemFonts().then(setFonts)
  }, [])

  const families = useMemo(() => {
    const all = [...new Set([...COMMON_FONTS, ...fonts])]
    const wanted = filter.trim().toLowerCase()

    return wanted ? all.filter((family) => family.toLowerCase().includes(wanted)) : all
  }, [$uiLanguage.get(), fonts, filter])

  const row = (font: FontRef, label: string, family: string, hint?: string) => (
    <button key={font} type="button" onClick={() => onPick(font)} className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-fg-2 hover:bg-white/8 hover:text-fg">
      <span className="min-w-0 flex-1 truncate" style={{ fontFamily: fontStack(family) }}>
        {label}
      </span>
      {hint && <span className="text-[11px] text-fg-3">{hint}</span>}
      {value === font && <IconCheck size={14} className="text-accent-strong" />}
    </button>
  )

  return (
    <div className="flex w-64 flex-col gap-1">
      <input autoFocus value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={uiT("ui.e7f3334c7daf")} aria-label={uiT("ui.e7f3334c7daf")} className="glass-input mb-1 h-7 rounded-md px-2 text-[12px] text-fg outline-none placeholder:text-fg-4" />
      {!filter && (
        <>
          {row('+heading', theme.fonts.heading, theme.fonts.heading, uiT('slides.font.headings'))}
          {row('+body', theme.fonts.body, theme.fonts.body, uiT('slides.font.body'))}
          <div className="my-1 h-px bg-line" />
        </>
      )}
      <div className="max-h-72 overflow-y-auto">{families.map((family) => row(family, family, family))}</div>
    </div>
  )
}

export const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 72, 88, 96, 120]

export function SizeList({ value, onPick }: { value: number; onPick: (size: number) => void }) {
  useUiT()
  return (
    <div className="grid w-44 grid-cols-4 gap-1">
      {SIZES.map((size) => (
        <button key={size} type="button" onClick={() => onPick(size)} className={cn('h-7 rounded-md text-[12px] tabular-nums text-fg-2 hover:bg-white/8 hover:text-fg', Math.abs(size - value) < 0.01 && 'bg-white/12 text-fg')}>
          {size}
        </button>
      ))}
    </div>
  )
}

const GRID_ROWS = 8
const GRID_COLUMNS = 10

/** Rows and columns for a new table, picked on a grid from its top left as in PowerPoint. */
export function TableGrid({ onPick }: { onPick: (rows: number, columns: number) => void }) {
  useUiT()
  const [over, setOver] = useState({ rows: 0, columns: 0 })

  return (
    <div className="flex flex-col gap-2" onMouseLeave={() => setOver({ rows: 0, columns: 0 })}>
      <div className="grid grid-cols-10 gap-[3px]">
        {Array.from({ length: GRID_ROWS * GRID_COLUMNS }, (_, index) => {
          const rows = Math.floor(index / GRID_COLUMNS) + 1
          const columns = (index % GRID_COLUMNS) + 1
          const lit = rows <= over.rows && columns <= over.columns

          return (
            <button
              key={index}
              type="button"
              aria-label={uiT("ui.abeb000eca67", { value1: String(rows), value2: String(columns) })}
              onMouseEnter={() => setOver({ rows, columns })}
              onFocus={() => setOver({ rows, columns })}
              onClick={() => onPick(rows, columns)}
              className={cn('size-4 rounded-[2px] border', lit ? 'border-accent bg-accent/30' : 'border-line bg-white/5')}
            />
          )
        })}
      </div>
      <span className="text-[11.5px] text-fg-3 tabular-nums">{over.rows ? `${over.rows} ${over.rows === 1 ? 'row' : 'rows'}, ${over.columns} ${over.columns === 1 ? 'column' : 'columns'}` : uiT("ui.c7d4495b55db")}</span>
    </div>
  )
}

/** A slide's look in miniature, for choosers. */
function Miniature({ deck, slide, width }: { deck: Pick<Deck, 'size' | 'theme'>; slide: Slide; width: number }) {
  useUiT()
  return <SlideView deck={deck} slide={slide} scale={width / deck.size.width} mode="edit" className="pointer-events-none rounded-[3px] ring-1 ring-black/10" />
}

export function LayoutGrid({ deck, onPick, current }: { deck: Pick<Deck, 'size' | 'theme'>; onPick: (layout: LayoutId) => void; current?: LayoutId }) {
  useUiT()
  const slides = useMemo(() => LAYOUTS.map((layout) => newSlide(layout, deck.size)), [$uiLanguage.get(), deck.size])

  return (
    <div className="grid w-[452px] grid-cols-4 gap-2">
      {LAYOUTS.map((layout, index) => (
        <button key={layout} type="button" onClick={() => onPick(layout)} className={cn('flex flex-col items-center gap-1 rounded-lg p-1.5 text-[11px] text-fg-2 hover:bg-white/8 hover:text-fg', current === layout && 'bg-white/10 text-fg')}>
          <Miniature deck={deck} slide={slides[index]} width={96} />
          <span className="w-24 truncate text-center">{layoutDisplayName(layout)}</span>
        </button>
      ))}
    </div>
  )
}

/** Localized presentation; layout IDs and saved names remain unchanged. */
export const layoutDisplayName = (id: LayoutId): string => uiT(({"title":"office.layout.title","title-content":"office.layout.title-content","two-content":"office.layout.two-content","section":"office.layout.section","title-only":"office.layout.title-only","blank":"office.layout.blank","picture-caption":"office.layout.picture-caption","comparison":"office.layout.comparison"} as const)[id])

// Display names only: document IDs, model values and undo history keep their original contracts.
const SHAPE_KEYS = {
  "rect": "slides.label.shape.rect",
  "roundRect": "slides.label.shape.roundRect",
  "ellipse": "slides.label.shape.ellipse",
  "triangle": "slides.label.shape.triangle",
  "rtTriangle": "slides.label.shape.rtTriangle",
  "diamond": "slides.label.shape.diamond",
  "parallelogram": "slides.label.shape.parallelogram",
  "trapezoid": "slides.label.shape.trapezoid",
  "pentagon": "slides.label.shape.pentagon",
  "hexagon": "slides.label.shape.hexagon",
  "octagon": "slides.label.shape.octagon",
  "plus": "slides.label.shape.plus",
  "star5": "slides.label.shape.star5",
  "rightArrow": "slides.label.shape.rightArrow",
  "leftArrow": "slides.label.shape.leftArrow",
  "upArrow": "slides.label.shape.upArrow",
  "downArrow": "slides.label.shape.downArrow",
  "leftRightArrow": "slides.label.shape.leftRightArrow",
  "chevron": "slides.label.shape.chevron",
  "homePlate": "slides.label.shape.homePlate",
  "wedgeRectCallout": "slides.label.shape.wedgeRectCallout",
  "wedgeRoundRectCallout": "slides.label.shape.wedgeRoundRectCallout",
  "snip1Rect": "slides.label.shape.snip1Rect",
  "snip2SameRect": "slides.label.shape.snip2SameRect",
  "round1Rect": "slides.label.shape.round1Rect",
  "round2SameRect": "slides.label.shape.round2SameRect",
  "plaque": "slides.label.shape.plaque",
  "foldedCorner": "slides.label.shape.foldedCorner",
  "frame": "slides.label.shape.frame",
  "halfFrame": "slides.label.shape.halfFrame",
  "corner": "slides.label.shape.corner",
  "diagStripe": "slides.label.shape.diagStripe",
  "bevel": "slides.label.shape.bevel",
  "heptagon": "slides.label.shape.heptagon",
  "decagon": "slides.label.shape.decagon",
  "dodecagon": "slides.label.shape.dodecagon",
  "star4": "slides.label.shape.star4",
  "star6": "slides.label.shape.star6",
  "star8": "slides.label.shape.star8",
  "star10": "slides.label.shape.star10",
  "star12": "slides.label.shape.star12",
  "donut": "slides.label.shape.donut",
  "noSmoking": "slides.label.shape.noSmoking",
  "blockArc": "slides.label.shape.blockArc",
  "pie": "slides.label.shape.pie",
  "chord": "slides.label.shape.chord",
  "teardrop": "slides.label.shape.teardrop",
  "heart": "slides.label.shape.heart",
  "lightningBolt": "slides.label.shape.lightningBolt",
  "sun": "slides.label.shape.sun",
  "moon": "slides.label.shape.moon",
  "cloud": "slides.label.shape.cloud",
  "smileyFace": "slides.label.shape.smileyFace",
  "can": "slides.label.shape.can",
  "cube": "slides.label.shape.cube",
  "bracketPair": "slides.label.shape.bracketPair",
  "bracePair": "slides.label.shape.bracePair",
  "leftBracket": "slides.label.shape.leftBracket",
  "rightBracket": "slides.label.shape.rightBracket",
  "leftBrace": "slides.label.shape.leftBrace",
  "rightBrace": "slides.label.shape.rightBrace",
  "upDownArrow": "slides.label.shape.upDownArrow",
  "quadArrow": "slides.label.shape.quadArrow",
  "notchedRightArrow": "slides.label.shape.notchedRightArrow",
  "stripedRightArrow": "slides.label.shape.stripedRightArrow",
  "bentArrow": "slides.label.shape.bentArrow",
  "uturnArrow": "slides.label.shape.uturnArrow",
  "wedgeEllipseCallout": "slides.label.shape.wedgeEllipseCallout",
  "cloudCallout": "slides.label.shape.cloudCallout",
  "mathPlus": "slides.label.shape.mathPlus",
  "mathMinus": "slides.label.shape.mathMinus",
  "mathMultiply": "slides.label.shape.mathMultiply",
  "mathDivide": "slides.label.shape.mathDivide",
  "mathEqual": "slides.label.shape.mathEqual",
  "mathNotEqual": "slides.label.shape.mathNotEqual",
  "wave": "slides.label.shape.wave",
  "doubleWave": "slides.label.shape.doubleWave",
  "flowChartProcess": "slides.label.shape.flowChartProcess",
  "flowChartAlternateProcess": "slides.label.shape.flowChartAlternateProcess",
  "flowChartDecision": "slides.label.shape.flowChartDecision",
  "flowChartInputOutput": "slides.label.shape.flowChartInputOutput",
  "flowChartPredefinedProcess": "slides.label.shape.flowChartPredefinedProcess",
  "flowChartInternalStorage": "slides.label.shape.flowChartInternalStorage",
  "flowChartDocument": "slides.label.shape.flowChartDocument",
  "flowChartMultidocument": "slides.label.shape.flowChartMultidocument",
  "flowChartTerminator": "slides.label.shape.flowChartTerminator",
  "flowChartPreparation": "slides.label.shape.flowChartPreparation",
  "flowChartManualInput": "slides.label.shape.flowChartManualInput",
  "flowChartManualOperation": "slides.label.shape.flowChartManualOperation",
  "flowChartConnector": "slides.label.shape.flowChartConnector",
  "flowChartOffpageConnector": "slides.label.shape.flowChartOffpageConnector",
  "flowChartPunchedCard": "slides.label.shape.flowChartPunchedCard",
  "flowChartPunchedTape": "slides.label.shape.flowChartPunchedTape",
  "flowChartSummingJunction": "slides.label.shape.flowChartSummingJunction",
  "flowChartOr": "slides.label.shape.flowChartOr",
  "flowChartCollate": "slides.label.shape.flowChartCollate",
  "flowChartSort": "slides.label.shape.flowChartSort",
  "flowChartExtract": "slides.label.shape.flowChartExtract",
  "flowChartMerge": "slides.label.shape.flowChartMerge",
  "flowChartOnlineStorage": "slides.label.shape.flowChartOnlineStorage",
  "flowChartDelay": "slides.label.shape.flowChartDelay",
  "flowChartMagneticDisk": "slides.label.shape.flowChartMagneticDisk",
  "flowChartDisplay": "slides.label.shape.flowChartDisplay"
} as const
export const shapeLabel = (value: keyof typeof SHAPE_KEYS): string => uiT(SHAPE_KEYS[value])
const DASH_KEYS = {
  "solid": "slides.label.dash.solid",
  "dash": "slides.label.dash.dash",
  "dot": "slides.label.dash.dot",
  "dashDot": "slides.label.dash.dashDot",
  "longDash": "slides.label.dash.longDash"
} as const
export const dashLabel = (value: keyof typeof DASH_KEYS): string => uiT(DASH_KEYS[value])
const ARROW_KEYS = {
  "none": "slides.label.arrow.none",
  "triangle": "slides.label.arrow.triangle",
  "arrow": "slides.label.arrow.arrow",
  "stealth": "slides.label.arrow.stealth",
  "oval": "slides.label.arrow.oval",
  "diamond": "slides.label.arrow.diamond"
} as const
export const arrowLabel = (value: keyof typeof ARROW_KEYS): string => uiT(ARROW_KEYS[value])
const SLOT_KEYS = {
  "bg1": "slides.label.slot.bg1",
  "tx1": "slides.label.slot.tx1",
  "bg2": "slides.label.slot.bg2",
  "tx2": "slides.label.slot.tx2",
  "accent1": "slides.label.slot.accent1",
  "accent2": "slides.label.slot.accent2",
  "accent3": "slides.label.slot.accent3",
  "accent4": "slides.label.slot.accent4",
  "accent5": "slides.label.slot.accent5",
  "accent6": "slides.label.slot.accent6"
} as const
export const slotLabel = (value: keyof typeof SLOT_KEYS): string => uiT(SLOT_KEYS[value])
const ARRANGE_KEYS = {
  "front": "slides.label.arrange.front",
  "back": "slides.label.arrange.back",
  "forward": "slides.label.arrange.forward",
  "backward": "slides.label.arrange.backward"
} as const
export const arrangeLabel = (value: keyof typeof ARRANGE_KEYS): string => uiT(ARRANGE_KEYS[value])
const ALIGN_KEYS = {
  "left": "slides.label.align.left",
  "center": "slides.label.align.center",
  "right": "slides.label.align.right",
  "top": "slides.label.align.top",
  "middle": "slides.label.align.middle",
  "bottom": "slides.label.align.bottom"
} as const
export const alignLabel = (value: keyof typeof ALIGN_KEYS): string => uiT(ALIGN_KEYS[value])
const BORDER_KEYS = {
  "all": "slides.label.border.all",
  "outer": "slides.label.border.outer",
  "inner": "slides.label.border.inner",
  "top": "slides.label.border.top",
  "bottom": "slides.label.border.bottom",
  "left": "slides.label.border.left",
  "right": "slides.label.border.right",
  "none": "slides.label.border.none"
} as const
export const borderLabel = (value: keyof typeof BORDER_KEYS): string => uiT(BORDER_KEYS[value])

const SHAPE_GROUP_KEYS = {
  "Rectangles": "slides.shapeGroup.0",
  "Basic shapes": "slides.shapeGroup.1",
  "Arrows": "slides.shapeGroup.2",
  "Equation shapes": "slides.shapeGroup.3",
  "Flowchart": "slides.shapeGroup.4",
  "Stars and banners": "slides.shapeGroup.5",
  "Callouts": "slides.shapeGroup.6"
} as const
export const shapeGroupLabel = (name: string): string => Object.hasOwn(SHAPE_GROUP_KEYS, name) ? uiT(SHAPE_GROUP_KEYS[name as keyof typeof SHAPE_GROUP_KEYS]) : name
