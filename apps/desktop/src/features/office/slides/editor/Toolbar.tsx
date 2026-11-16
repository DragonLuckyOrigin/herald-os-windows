import { shapeGroupLabel, shapeLabel, borderLabel, dashLabel, arrowLabel } from './pickers.tsx'
import { t as uiT, useT as useUiT } from '../../../../store/i18n.ts'
import { useStore } from '@nanostores/react'
import {
  type Icon,
  IconAlignCenter,
  IconAlignJustified,
  IconAlignLeft,
  IconAlignRight,
  IconArrowNarrowRight,
  IconBackground,
  IconBold,
  IconBorderAll,
  IconBorderBottom,
  IconBorderInner,
  IconBorderLeft,
  IconBorderNone,
  IconBorderOuter,
  IconBorderRight,
  IconBorderTop,
  IconChevronDown,
  IconCircle,
  IconColumnInsertLeft,
  IconColumnInsertRight,
  IconColumnRemove,
  IconIndentDecrease,
  IconIndentIncrease,
  IconItalic,
  IconLayoutBoardSplit,
  IconLetterT,
  IconLineDashed,
  IconLineHeight,
  IconList,
  IconListNumbers,
  IconPalette,
  IconPhoto,
  IconPlayerPlay,
  IconPlus,
  IconPresentation,
  IconRowInsertBottom,
  IconRowInsertTop,
  IconRowRemove,
  IconSquare,
  IconStrikethrough,
  IconTable,
  IconTransitionRight,
  IconTriangle,
  IconUnderline
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { cn } from '../../../../lib/cn.ts'
import { ARROW_HEADS, type ArrowHead, type Color, type Dash, DASHES, type Fill, type LineElement, type ShapeElement, type TableElement, type TextElement, type Theme } from '../deck.ts'
import type { SlidesDocument } from '../document.ts'
import { SHAPE_GROUPS, shapePath } from '../shapes.ts'
import { resolveColor, resolveFont } from '../themes.ts'
import { $textRevision, $textSession } from './active.ts'
import { BackgroundPanel } from './BackgroundPanel.tsx'
import { $borderPen, BORDER_CHOICES, type BorderChoice } from './borders.ts'
import * as commands from './commands.ts'
import { ColorGrid, FillPanel, fillCss, FontList, LayoutGrid, PopoverButton, SizeList, TableGrid } from './pickers.tsx'
import { presenterView } from './slides-menus.ts'
import { useDeck } from './Stage.tsx'
import { ThemePanel } from './ThemePanel.tsx'
import { TransitionPanel } from './TransitionPanel.tsx'

/*
 * The formatting bar over the slide: new slides with their layout, things to insert, and the tools
 * for what is selected (text, shapes, lines, pictures, tables' borders, kept SmartArt), then the
 * theme and Present. Text tools format the selected words while typing and whole boxes otherwise.
 */

function Tool({ label, onClick, active, children, disabled, className }: { label: string; onClick: () => void; active?: boolean; children: ReactNode; disabled?: boolean; className?: string }) {
  useUiT()
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn('grid h-7 min-w-7 place-items-center rounded-md px-1.5 text-fg-2 hover:bg-white/8 hover:text-fg disabled:opacity-40 [&_svg]:size-4', active && 'bg-white/12 text-fg', className)}
    >
      {children}
    </button>
  )
}

const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-line" />

function ShapeIcon({ kind }: { kind: Parameters<typeof shapePath>[0] }) {
  useUiT()
  return (
    <svg viewBox="-1 -1 22 16" className="h-4 w-5" aria-hidden="true">
      <path d={shapePath(kind, 20, 14)} fill="none" stroke="currentColor" strokeWidth={1.4} />
    </svg>
  )
}

/** A colour under a tool's icon; a fill's gradient when given one. */
function Swatch({ color, theme, fill }: { color: Color | null; theme: Theme; fill?: Fill | null }) {
  useUiT()
  const empty = fill === undefined ? !color : !fill

  return <span className="h-[3px] w-4 rounded-full" style={{ background: fill === undefined ? (color ? resolveColor(color, theme) : 'transparent') : fillCss(fill, theme), outline: empty ? '1px dashed currentColor' : undefined }} />
}

const CONNECTOR_PATHS: Record<keyof typeof commands.CONNECTOR_NAMES, string> = { straightConnector1: 'M3 12 L17 2', bentConnector3: 'M3 12 H10 V2 H17', curvedConnector3: 'M3 12 C11 12 9 2 17 2' }

function ConnectorIcon({ preset }: { preset: keyof typeof commands.CONNECTOR_NAMES }) {
  useUiT()
  return (
    <svg viewBox="0 0 20 14" className="h-4 w-5" aria-hidden="true">
      <path d={CONNECTOR_PATHS[preset]} fill="none" stroke="currentColor" strokeWidth={1.4} />
      <circle cx={3} cy={12} r={1.7} fill="currentColor" />
      <circle cx={17} cy={2} r={1.7} fill="currentColor" />
    </svg>
  )
}

function ShapeSection({ name, children }: { name: string; children: ReactNode }) {
  useUiT()
  return (
    <section className="flex flex-col gap-1">
      <div className="text-[11px] font-medium tracking-wide text-fg-3 uppercase">{name}</div>
      <div className="grid grid-cols-7 gap-0.5">{children}</div>
    </section>
  )
}

/** Every shape by its gallery's groups, lines and connectors first. */
function ShapeGallery({ doc, onDone }: { doc: SlidesDocument; onDone: () => void }) {
  useUiT()
  const pick = (run: () => void) => () => {
    run()
    onDone()
  }

  return (
    <div className="flex max-h-[min(460px,70vh)] w-[262px] flex-col gap-2.5 overflow-y-auto pr-1">
      <ShapeSection name="Lines">
        <Tool label={uiT("ui.d7852cd0d245")} onClick={pick(() => commands.insertLine('none'))}>
          <svg viewBox="0 0 20 14" className="h-4 w-5" aria-hidden="true">
            <line x1="2" y1="12" x2="18" y2="2" stroke="currentColor" strokeWidth={1.6} />
          </svg>
        </Tool>
        <Tool label={uiT("ui.05800e70aa10")} onClick={pick(() => commands.insertLine('triangle'))}>
          <IconArrowNarrowRight />
        </Tool>
        {(Object.keys(commands.CONNECTOR_NAMES) as (keyof typeof commands.CONNECTOR_NAMES)[]).map((preset) => (
          <Tool key={preset} label={uiT("ui.e5424b7a8424", { value1: String(commands.CONNECTOR_NAMES[preset]) })} onClick={pick(() => commands.drawConnector(preset, doc))}>
            <ConnectorIcon preset={preset} />
          </Tool>
        ))}
      </ShapeSection>
      {SHAPE_GROUPS.map((group) => (
        <ShapeSection key={shapeGroupLabel(group.name)} name={shapeGroupLabel(group.name)}>
          {group.kinds.map((kind) => (
            <Tool key={kind} label={shapeLabel(kind)} onClick={pick(() => commands.insertShape(kind))}>
              <ShapeIcon kind={kind} />
            </Tool>
          ))}
        </ShapeSection>
      ))}
    </div>
  )
}

function TextTools({ doc }: { doc: SlidesDocument }) {
  useUiT()
  useStore($textRevision)
  const format = commands.currentFormat(doc)
  const theme = doc.deck.theme
  const fontName = resolveFont(format.font, theme)

  return (
    <>
      <PopoverButton label={uiT("ui.64d0b3adcd2d")} className="w-[132px] justify-between text-[12px]" panel={(close) => <FontList theme={theme} value={format.font} onPick={(font) => (commands.setRunStyle({ font }), close())} />}>
        <span className="truncate">{fontName}</span>
        <IconChevronDown size={12} />
      </PopoverButton>
      <PopoverButton label={uiT("ui.d68761cc1eb2")} className="w-[54px] justify-between text-[12px] tabular-nums" panel={(close) => <SizeList value={format.size} onPick={(size) => (commands.setRunStyle({ size }), close())} />}>
        <span>{Math.round(format.size * 10) / 10}</span>
        <IconChevronDown size={12} />
      </PopoverButton>
      <Tool label={uiT("ui.94fee62e68e2")} active={format.bold} onClick={() => commands.toggleSwitch('bold')}>
        <IconBold />
      </Tool>
      <Tool label={uiT("ui.9bf37cb58a69")} active={format.italic} onClick={() => commands.toggleSwitch('italic')}>
        <IconItalic />
      </Tool>
      <Tool label={uiT("ui.02f843261112")} active={format.underline} onClick={() => commands.toggleSwitch('underline')}>
        <IconUnderline />
      </Tool>
      <Tool label={uiT("ui.9aabbcb2c18d")} active={format.strike} onClick={() => commands.toggleSwitch('strike')}>
        <IconStrikethrough />
      </Tool>
      <PopoverButton label={uiT("ui.25e9c8090de7")} panel={(close) => <ColorGrid theme={theme} value={format.color} onPick={(color) => (commands.setRunStyle({ color: color ?? 'tx1' }), close())} />}>
        <span className="flex flex-col items-center gap-[2px] text-[12px] leading-none font-semibold">
          A
          <Swatch color={format.color} theme={theme} />
        </span>
      </PopoverButton>
      <PopoverButton label={uiT("ui.07ccd15df32a")} panel={(close) => <ColorGrid theme={theme} value={format.highlight} none noneLabel={uiT('slides.action.noHighlight')} onPick={(highlight) => (commands.setRunStyle({ highlight }), close())} />}>
        <span className="flex flex-col items-center gap-[2px]">
          <IconPalette size={14} />
          <Swatch color={format.highlight} theme={theme} />
        </span>
      </PopoverButton>
      <Divider />
      <PopoverButton
        label={uiT("ui.ef082d68360c")}
        panel={(close) => (
          <div className="flex gap-1">
            {(
              [
                ['left', IconAlignLeft, 'Align left'],
                ['center', IconAlignCenter, 'Centre'],
                ['right', IconAlignRight, 'Align right'],
                ['justify', IconAlignJustified, 'Justify']
              ] as const
            ).map(([align, Icon, label]) => (
              <Tool key={align} label={label} active={format.align === align} onClick={() => (commands.setAlign(align), close())}>
                <Icon />
              </Tool>
            ))}
          </div>
        )}
      >
        {format.align === 'center' ? <IconAlignCenter /> : format.align === 'right' ? <IconAlignRight /> : format.align === 'justify' ? <IconAlignJustified /> : <IconAlignLeft />}
      </PopoverButton>
      <Tool label={uiT("ui.20c579c3da98")} active={format.list === 'bullet'} onClick={() => commands.toggleListKind('bullet')}>
        <IconList />
      </Tool>
      <Tool label={uiT("ui.7b3ffc4c2065")} active={format.list === 'number'} onClick={() => commands.toggleListKind('number')}>
        <IconListNumbers />
      </Tool>
      <Tool label={uiT("ui.7cfcda36d6c2")} onClick={() => commands.shiftLevels(-1)}>
        <IconIndentDecrease />
      </Tool>
      <Tool label={uiT("ui.4051693816d7")} onClick={() => commands.shiftLevels(1)}>
        <IconIndentIncrease />
      </Tool>
      <PopoverButton
        label={uiT("ui.0db45da1214b")}
        panel={(close) => (
          <div className="flex w-28 flex-col">
            {[1, 1.15, 1.5, 2, 2.5, 3].map((spacing) => (
              <button key={spacing} type="button" onClick={() => (commands.setLineSpacing(spacing), close())} className={cn('h-7 rounded-md px-2 text-left text-[12px] text-fg-2 hover:bg-white/8 hover:text-fg', Math.abs(format.lineSpacing - spacing) < 0.01 && 'bg-white/12 text-fg')}>
                {spacing.toFixed(spacing % 1 ? 2 : 1).replace(/0$/, '')}
              </button>
            ))}
          </div>
        )}
      >
        <IconLineHeight />
      </PopoverButton>
    </>
  )
}

function ShapeTools({ doc }: { doc: SlidesDocument }) {
  useUiT()
  const theme = doc.deck.theme
  const selection = doc.selection
  const filled = selection.find((element): element is TextElement | ShapeElement | TableElement => element.kind === 'shape' || element.kind === 'text' || element.kind === 'table')
  const line = selection.find((element): element is LineElement => element.kind === 'line')
  const typing = filled?.kind === 'table' && doc.editing === filled.id ? doc.cell : null
  const fill = filled?.kind === 'table' ? ((typing ? filled.cells[typing.row][typing.column] : filled.cells[0]?.[0])?.fill ?? null) : (filled?.fill ?? null)
  const first = selection.find((element) => element.kind !== 'object')
  const stroke = first?.stroke ?? null

  return (
    <>
      {filled && (
        <PopoverButton
          label={filled.kind === 'table' ? (typing ? uiT('slides.action.cellFill') : uiT('slides.action.fillCells')) : uiT("ui.033955d469b6")}
          panel={(close) => <FillPanel theme={theme} value={fill} noneLabel={uiT('slides.action.noFill')} onColor={(color) => (commands.setFill(color ? { color } : null, doc), close())} onGradient={(gradient) => commands.setFill(gradient, doc, 'gradient')} />}
        >
          <span className="flex flex-col items-center gap-[2px]">
            <IconSquare size={14} />
            <Swatch color={fill?.color ?? null} fill={fill} theme={theme} />
          </span>
        </PopoverButton>
      )}
      {commands.canConvert(doc) && (
        <Tool label={uiT("ui.414f227f6d85")} className="text-[12px] whitespace-nowrap" onClick={() => commands.convertSelection(doc)}>
          {uiT("ui.9cd796555b78")}</Tool>
      )}
      {first && (
        <PopoverButton
          label={uiT("ui.eabbf3abaf8d")}
          panel={(close) => (
            <div className="flex flex-col gap-3">
              <ColorGrid theme={theme} value={stroke?.color ?? null} none={!line} noneLabel={uiT('slides.action.noOutline')} onPick={(color) => (commands.setStroke(color ? { color } : null), close())} />
              <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
                {uiT("ui.42b27c15e4ef")}{[0.75, 1, 1.5, 2, 3, 4.5, 6].map((width) => (
                  <button key={width} type="button" onClick={() => commands.setStroke({ width })} className={cn('h-6 min-w-6 rounded px-1 tabular-nums text-fg-2 hover:bg-white/8', stroke?.width === width && 'bg-white/12 text-fg')}>
                    {width}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 text-[11.5px] text-fg-3">
                {DASHES.map((dash: Dash) => (
                  <button key={dash} type="button" title={dashLabel(dash)} aria-label={dashLabel(dash)} onClick={() => commands.setStroke({ dash })} className={cn('grid h-6 w-9 place-items-center rounded hover:bg-white/8', stroke?.dash === dash && 'bg-white/12')}>
                    <svg width="26" height="4" aria-hidden="true">
                      <line x1="0" y1="2" x2="26" y2="2" stroke="currentColor" strokeWidth="2" strokeDasharray={dash === 'solid' ? undefined : dash === 'dot' ? '2 2' : dash === 'dash' ? '6 3' : dash === 'dashDot' ? '6 3 2 3' : '10 3'} />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          )}
        >
          <span className="flex flex-col items-center gap-[2px]">
            <IconLineDashed size={14} />
            <Swatch color={stroke?.color ?? null} theme={theme} />
          </span>
        </PopoverButton>
      )}
      {line && (
        <PopoverButton
          label={uiT("ui.423c677c12e0")}
          panel={(close) => (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-fg-2">
              <span className="text-[11px] text-fg-3 uppercase">{uiT("ui.e4bb9f1ece9a")}</span>
              <span className="text-[11px] text-fg-3 uppercase">{uiT("ui.f4db1e48476f")}</span>
              {ARROW_HEADS.map((head: ArrowHead) => (
                <div key={head} className="contents">
                  <button type="button" onClick={() => (commands.setArrowHeads({ start: head }), close())} className={cn('h-7 rounded-md px-2 text-left hover:bg-white/8', line.start === head && 'bg-white/12 text-fg')}>
                    {arrowLabel(head)}
                  </button>
                  <button type="button" onClick={() => (commands.setArrowHeads({ end: head }), close())} className={cn('h-7 rounded-md px-2 text-left hover:bg-white/8', line.end === head && 'bg-white/12 text-fg')}>
                    {arrowLabel(head)}
                  </button>
                </div>
              ))}
            </div>
          )}
        >
          <IconArrowNarrowRight />
        </PopoverButton>
      )}
    </>
  )
}

const BORDER_ICONS: Record<BorderChoice, Icon> = {
  all: IconBorderAll,
  outer: IconBorderOuter,
  inner: IconBorderInner,
  top: IconBorderTop,
  bottom: IconBorderBottom,
  left: IconBorderLeft,
  right: IconBorderRight,
  none: IconBorderNone
}

/** Borders for the cell being typed into, or all cells, in the pen chosen under them. */
function BordersPanel({ doc, onDone }: { doc: SlidesDocument; onDone: () => void }) {
  useUiT()
  const pen = useStore($borderPen)

  return (
    <div className="flex w-[232px] flex-col gap-2">
      <div className="flex justify-between">
        {BORDER_CHOICES.map((choice) => {
          const Choice = BORDER_ICONS[choice]

          return (
            <Tool key={choice} label={borderLabel(choice)} onClick={() => (commands.setBorders(choice, doc), onDone())}>
              <Choice />
            </Tool>
          )
        })}
      </div>
      <div className="text-[11px] font-medium tracking-wide text-fg-3 uppercase">{uiT("ui.a04bd35be167")}</div>
      <ColorGrid theme={doc.deck.theme} value={pen.color} onPick={(color) => color && $borderPen.set({ ...pen, color })} />
      <div className="flex items-center gap-1 text-[11.5px] text-fg-3">
        {uiT("ui.42b27c15e4ef")}{[0.5, 0.75, 1, 1.5, 2.25, 3, 4.5].map((width) => (
          <button key={width} type="button" onClick={() => $borderPen.set({ ...pen, width })} className={cn('h-6 min-w-6 rounded px-1 tabular-nums text-fg-2 hover:bg-white/8', pen.width === width && 'bg-white/12 text-fg')}>
            {width}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Rows and columns in and out at the selected table's current cell, and its borders. */
function TableTools({ doc }: { doc: SlidesDocument }) {
  useUiT()
  const atCell = commands.hasTableCell(doc)
  const pen = useStore($borderPen)

  return (
    <>
      <PopoverButton label={doc.editing && atCell ? uiT("ui.025e7db3e633") : uiT("ui.0de9f358ad56")} panel={(close) => <BordersPanel doc={doc} onDone={close} />}>
        <span className="flex flex-col items-center gap-[2px]">
          <IconBorderAll size={14} />
          <Swatch color={pen.color} theme={doc.deck.theme} />
        </span>
      </PopoverButton>
      <Tool label={uiT("ui.1bd8790113e0")} onClick={() => commands.insertRow('above', doc)}>
        <IconRowInsertTop />
      </Tool>
      <Tool label={uiT("ui.e49e44c7272e")} onClick={() => commands.insertRow('below', doc)}>
        <IconRowInsertBottom />
      </Tool>
      <Tool label={uiT("ui.33ed8fcbcb57")} onClick={() => commands.insertColumn('left', doc)}>
        <IconColumnInsertLeft />
      </Tool>
      <Tool label={uiT("ui.6f591ddba0f7")} onClick={() => commands.insertColumn('right', doc)}>
        <IconColumnInsertRight />
      </Tool>
      <Tool label={uiT("ui.5260f6b2fa9f")} disabled={!atCell} onClick={() => commands.deleteRows(doc)}>
        <IconRowRemove />
      </Tool>
      <Tool label={uiT("ui.837dbb2c66b1")} disabled={!atCell} onClick={() => commands.deleteColumns(doc)}>
        <IconColumnRemove />
      </Tool>
    </>
  )
}

export function Toolbar({ doc }: { doc: SlidesDocument }) {
  useUiT()
  useDeck(doc)
  const session = useStore($textSession)
  const drawing = useStore(commands.$drawing)
  const deck = doc.deck
  const selection = doc.selection
  const texty = session?.doc === doc || selection.some((element) => element.kind === 'text' || element.kind === 'shape' || element.kind === 'table')
  const master = doc.mode === 'master'

  return (
    <div data-slides-keep-editing="" className="flex h-10 shrink-0 items-center border-b border-line px-2 text-[12px]">
      {/* The tools scroll when the window is narrow; the deck's own controls and Present stay in view. */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-visible">
        <div className="relative flex">
          <Tool label={uiT("ui.f95a6f1e4bf1")} className="rounded-r-none px-2" disabled={master} onClick={() => commands.newSlide(doc.slide.layout === 'title' ? 'title-content' : doc.slide.layout)}>
            <span className="flex items-center gap-1.5">
              <IconPlus size={15} />{uiT("ui.1f84c4ccf750")}</span>
          </Tool>
          <PopoverButton label={uiT("ui.7a3e4e06b6ef")} className="rounded-l-none px-0.5" disabled={master} panel={(close) => <LayoutGrid deck={deck} onPick={(layout) => (commands.newSlide(layout), close())} />}>
            <IconChevronDown size={13} />
          </PopoverButton>
        </div>
        <PopoverButton label={uiT("ui.a511909161e1")} disabled={master} panel={(close) => <LayoutGrid deck={deck} current={doc.slide.layout} onPick={(layout) => (commands.setLayout(layout), close())} />}>
          <IconLayoutBoardSplit />
        </PopoverButton>
        <Divider />
        <Tool label={uiT("ui.449d1c52f1b8")} onClick={commands.insertText}>
          <IconLetterT />
        </Tool>
        <PopoverButton label={uiT("ui.e0e492707f85")} active={Boolean(drawing)} panel={(close) => <ShapeGallery doc={doc} onDone={close} />}>
          <span className="flex items-center">
            <IconTriangle size={15} />
            <IconCircle size={11} className="-ml-1" />
          </span>
        </PopoverButton>
        <Tool label={uiT("ui.9a1c54f55e7c")} onClick={() => commands.pickPictures(doc)}>
          <IconPhoto />
        </Tool>
        <PopoverButton label={uiT("ui.16d1c9050a0b")} panel={(close) => <TableGrid onPick={(rows, columns) => (close(), commands.insertTable(rows, columns, doc))} />}>
          <IconTable />
        </PopoverButton>
        {texty && (
          <>
            <Divider />
            <TextTools doc={doc} />
          </>
        )}
        {(selection.some((element) => element.kind !== 'object') || commands.canConvert(doc)) && (
          <>
            <Divider />
            <ShapeTools doc={doc} />
          </>
        )}
        {selection.length === 1 && selection[0].kind === 'table' && (
          <>
            <Divider />
            <TableTools doc={doc} />
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 pl-2">
        <PopoverButton label={uiT("ui.ea2b8a878841")} align="right" panel={(close) => <BackgroundPanel doc={doc} onDone={close} />}>
          <IconBackground />
        </PopoverButton>
        <PopoverButton label={uiT("ui.700bb6e86a9b")} align="right" disabled={master} panel={(close) => <TransitionPanel doc={doc} onDone={close} />}>
          <IconTransitionRight />
        </PopoverButton>
        <PopoverButton label={uiT("ui.efb52e7172b7")} align="right" className="text-[12px]" panel={(close) => <ThemePanel doc={doc} onDone={close} />}>
          <span className="flex items-center gap-1.5 pr-0.5">
            <span className="flex">
              {(['accent1', 'accent2', 'accent3'] as const).map((slot) => (
                <span key={slot} className="-mr-1 size-3 rounded-full ring-1 ring-black/20" style={{ background: deck.theme.colors[slot] }} />
              ))}
            </span>
            <span className="ml-1">{deck.theme.name}</span>
            <IconChevronDown size={12} />
          </span>
        </PopoverButton>
        <Tool label={uiT("ui.ad53f79d6a64")} disabled={master} onClick={presenterView}>
          <IconPresentation />
        </Tool>
        <button
          type="button"
          disabled={master}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => commands.present(false)}
          className="ml-1 flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[12px] font-medium text-accent-fg hover:bg-accent-strong disabled:opacity-40"
        >
          <IconPlayerPlay size={14} />{uiT("ui.28efef0d7679")}</button>
      </div>
    </div>
  )
}
