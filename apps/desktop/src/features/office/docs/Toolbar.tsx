import { t as uiT, useT as useUiT } from '../../../store/i18n.ts'
import { useStore } from '@nanostores/react'
import {
  IconAlignCenter,
  IconAlignJustified,
  IconAlignLeft,
  IconAlignRight,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconBold,
  IconChevronDown,
  IconClearFormatting,
  IconHighlight,
  IconIndentDecrease,
  IconIndentIncrease,
  IconInfoCircle,
  IconItalic,
  IconLineHeight,
  IconLink,
  IconList,
  IconListCheck,
  IconListNumbers,
  IconMessagePlus,
  IconPageBreak,
  IconPhoto,
  IconSeparatorHorizontal,
  IconStrikethrough,
  IconSubscript,
  IconSuperscript,
  IconTable,
  IconTextColor,
  IconUnderline
} from '@tabler/icons-react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type DocNode, looksOf, styleOfBlock } from '../../../../shared/office/document.ts'
import { cn } from '../../../lib/cn.ts'
import { keysLabel } from '../../../lib/shortcuts.ts'
import { Menu, type MenuItemDef } from '../../files/Menu.tsx'
import * as act from './actions.ts'
import { CALLOUT_LABELS, FONTS, HIGHLIGHTS, LINE_SPACINGS, SIZES, TEXT_COLORS } from './choices.ts'
import { startComment } from './comments.ts'
import { BLOCK_STYLES, styleAt } from './model.ts'
import { $editors, docsSession } from './store.ts'
import { tableMenu } from './table-menu.ts'

export function ToolButton({ label, shortcut, onClick, active, disabled, children, className }: { label: string; shortcut?: string; onClick: () => void; active?: boolean; disabled?: boolean; children: ReactNode; className?: string }) {
  useUiT()
  const title = shortcut ? `${label} (${keysLabel(shortcut)})` : label

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={title}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn('grid h-7 min-w-7 shrink-0 place-items-center rounded-md px-1 text-fg-2 hover:bg-white/8 hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent [&_svg]:size-4', active && 'bg-white/12 text-fg', className)}
    >
      {children}
    </button>
  )
}

const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-line" />

/** A button that opens a menu of choices under it. */
function Dropdown({ label, title, items, width, disabled }: { label: ReactNode; title: string; items: () => MenuItemDef[]; width?: string; disabled?: boolean }) {
  useUiT()
  const [open, setOpen] = useState(false)

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onClick={() => setOpen(!open)}
        className={cn('flex h-7 items-center gap-1 rounded-md pr-1 pl-2 text-[12px] text-fg-2 hover:bg-white/8 hover:text-fg disabled:opacity-35', open && 'bg-white/10 text-fg', width)}
      >
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <IconChevronDown size={13} className="shrink-0 text-fg-3" />
      </button>
      {open && <Menu align="left" className="top-full mt-1 max-h-[60vh] min-w-44 overflow-y-auto" onClose={() => setOpen(false)} items={items()} />}
    </div>
  )
}

/** A colour button: the swatch it applies, and a palette to choose another. */
function ColorButton({ label, icon, colors, current, automatic, onPick }: { label: string; icon: ReactNode; colors: readonly string[]; current: string | null; automatic: string; onPick: (color: string | null) => void }) {
  useUiT()
  const [open, setOpen] = useState(false)
  const [last, setLast] = useState<string>(colors[0])
  const pick = (color: string | null) => {
    if (color) {
      setLast(color)
    }

    setOpen(false)
    onPick(color)
  }

  return (
    <div className="relative flex shrink-0">
      <button type="button" aria-label={label} title={label} onMouseDown={(event) => event.preventDefault()} onClick={() => pick(last)} className="relative grid h-7 w-7 place-items-center rounded-l-md text-fg-2 hover:bg-white/8 hover:text-fg [&_svg]:size-4">
        {icon}
        <span className="absolute right-1.5 bottom-1 left-1.5 h-[3px] rounded-full" style={{ background: current ?? last }} />
      </button>
      <button
        type="button"
        aria-label={uiT("ui.9fac3bd07665", { value1: String(label) })}
        aria-haspopup="dialog"
        onMouseDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onClick={() => setOpen(!open)}
        className={cn('grid h-7 w-4 place-items-center rounded-r-md text-fg-3 hover:bg-white/8 hover:text-fg', open && 'bg-white/10')}
      >
        <IconChevronDown size={12} />
      </button>
      {open && <Palette colors={colors} automatic={automatic} onPick={pick} onClose={() => setOpen(false)} />}
    </div>
  )
}

function Palette({ colors, automatic, onPick, onClose }: { colors: readonly string[]; automatic: string; onPick: (color: string | null) => void; onClose: () => void }) {
  useUiT()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && onClose()
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)

    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div ref={ref} role="dialog" aria-label={uiT("ui.88f20221cac1")} className="float menu-surface absolute top-full left-0 z-40 mt-1 w-[204px] rounded-xl p-2 animate-pop">
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onPick(null)} className="mb-2 flex h-7 w-full items-center gap-2 rounded-md px-2 text-[12px] text-fg-2 hover:bg-white/8 hover:text-fg">
        <span className="size-4 rounded border border-line-strong bg-white" />
        {automatic}
      </button>
      <div className="grid grid-cols-8 gap-1">
        {colors.map((color) => (
          <button key={color} type="button" aria-label={color} title={color} onMouseDown={(event) => event.preventDefault()} onClick={() => onPick(color)} className="size-5 rounded-[5px] border border-black/20 hover:scale-110" style={{ background: color }} />
        ))}
      </div>
    </div>
  )
}

/** A grid to pick a new table's rows and columns. */
function TableButton() {
  useUiT()
  const [open, setOpen] = useState(false)
  const [size, setSize] = useState({ rows: 0, cols: 0 })

  return (
    <div className="relative shrink-0">
      <ToolButton label={uiT("ui.67318ec2002d")} active={open} onClick={() => setOpen(!open)}>
        <IconTable />
      </ToolButton>
      {open && (
        <div className="float menu-surface absolute top-full left-0 z-40 mt-1 rounded-xl p-2 animate-pop" onMouseLeave={() => setSize({ rows: 0, cols: 0 })}>
          <div className="grid grid-cols-8 gap-0.5" role="grid" aria-label={uiT("ui.fddbbe8f65e2")}>
            {Array.from({ length: 64 }, (_, index) => {
              const row = Math.floor(index / 8) + 1
              const col = (index % 8) + 1

              return (
                <button
                  key={index}
                  type="button"
                  aria-label={uiT("ui.7488512832cd", { value1: String(row), value2: String(col) })}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setSize({ rows: row, cols: col })}
                  onClick={() => {
                    setOpen(false)
                    act.table(row, col)
                  }}
                  className={cn('size-4 rounded-[3px] border border-line', row <= size.rows && col <= size.cols ? 'border-accent bg-accent-soft' : 'bg-white/5')}
                />
              )
            })}
          </div>
          <div className="mt-1.5 text-center text-[11.5px] text-fg-3 tabular-nums">{size.rows ? `${size.rows} × ${size.cols}` : uiT("ui.2ac56446a450")}</div>
        </div>
      )}
    </div>
  )
}

const pointsOf = (value: unknown): number | null => {
  const match = /^(\d+(?:\.\d+)?)pt$/.exec(String(value ?? ''))

  return match ? Number(match[1]) : null
}

interface ToolbarState {
  style: string
  font: string | null
  size: number | null
  color: string | null
  highlight: string | null
  marks: Record<act.MarkName, boolean>
  align: string
  lineHeight: number | null
  list: act.ListKind | null
  link: boolean
  table: boolean
  callout: boolean
  canUndo: boolean
  canRedo: boolean
  looks: ReturnType<typeof looksOf>
  block: DocNode
}

function readState(editor: Editor): ToolbarState {
  const { state } = editor
  const block = state.selection.$from.parent
  const textStyle = editor.getAttributes('textStyle')

  return {
    style: styleAt(state),
    font: typeof textStyle.fontFamily === 'string' ? textStyle.fontFamily : null,
    size: pointsOf(textStyle.fontSize),
    color: typeof textStyle.color === 'string' ? textStyle.color : null,
    highlight: editor.isActive('highlight') ? ((editor.getAttributes('highlight').color as string | null) ?? '#fff27a') : null,
    marks: { bold: editor.isActive('bold'), italic: editor.isActive('italic'), underline: editor.isActive('underline'), strike: editor.isActive('strike'), superscript: editor.isActive('superscript'), subscript: editor.isActive('subscript'), code: editor.isActive('code') },
    align: (block.attrs.textAlign as string | null) ?? 'left',
    lineHeight: typeof block.attrs.lineHeight === 'number' ? block.attrs.lineHeight : null,
    list: editor.isActive('taskList') ? 'task' : editor.isActive('orderedList') ? 'ordered' : editor.isActive('bulletList') ? 'bullet' : null,
    link: editor.isActive('link'),
    table: editor.isActive('table'),
    callout: editor.isActive('callout'),
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
    looks: looksOf({ type: 'doc', attrs: state.doc.attrs }),
    block: { type: block.type.name, attrs: block.attrs }
  }
}

const ALIGNMENTS = [
  { id: 'left', get label() { return uiT("ui.eac0f9c3da59") }, shortcut: 'mod+l', icon: <IconAlignLeft /> },
  { id: 'center', get label() { return uiT("ui.45c19322f7b9") }, shortcut: 'mod+e', icon: <IconAlignCenter /> },
  { id: 'right', get label() { return uiT("ui.8f4f8efcbee1") }, shortcut: 'mod+r', icon: <IconAlignRight /> },
  { id: 'justify', get label() { return uiT("ui.f3bd3473d7d8") }, shortcut: 'mod+j', icon: <IconAlignJustified /> }
] as const

const MARKS = [
  { id: 'bold', get label() { return uiT("ui.94fee62e68e2") }, shortcut: 'mod+b', icon: <IconBold /> },
  { id: 'italic', get label() { return uiT("ui.9bf37cb58a69") }, shortcut: 'mod+i', icon: <IconItalic /> },
  { id: 'underline', get label() { return uiT("ui.02f843261112") }, shortcut: 'mod+u', icon: <IconUnderline /> },
  { id: 'strike', get label() { return uiT("ui.9aabbcb2c18d") }, shortcut: 'mod+shift+x', icon: <IconStrikethrough /> },
  { id: 'superscript', get label() { return uiT("ui.31a0bab13ba8") }, shortcut: 'mod+.', icon: <IconSuperscript /> },
  { id: 'subscript', get label() { return uiT("ui.cd512a33cc6f") }, shortcut: 'mod+,', icon: <IconSubscript /> }
] as const

/** Herald Docs' formatting bar for the document in front, once its editor is there. */
export function DocsToolbar({ docKey }: { docKey: string }) {
  useUiT()
  const editor = useStore($editors)[docKey] ?? null

  return editor ? <ToolbarFor key={editor.instanceId} editor={editor} docKey={docKey} /> : <div className="min-h-10 shrink-0 border-b border-line" />
}

function ToolbarFor({ editor, docKey }: { editor: Editor; docKey: string }) {
  useUiT()
  const state = useEditorState({ editor, selector: ({ editor: current }) => (current.isDestroyed ? null : readState(current)) })
  const picker = useRef<HTMLInputElement>(null)
  const off = !state

  const look = state ? state.looks[styleOfBlock(state.block)] : null
  const shownFont = state?.font ?? look?.font ?? state?.looks.normal.font ?? 'Arial'
  const shownSize = state?.size ?? look?.size ?? state?.looks.normal.size ?? 11

  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-0.5 border-b border-line px-2 py-1 text-[12px]" role="toolbar" aria-label={uiT("ui.29d4198e41d8")}>
      <ToolButton label={uiT("ui.a8283ade3185")} shortcut="mod+z" disabled={!state?.canUndo} onClick={() => editor.chain().focus().undo().run()}>
        <IconArrowBackUp />
      </ToolButton>
      <ToolButton label={uiT("ui.74273989b096")} shortcut="mod+shift+z" disabled={!state?.canRedo} onClick={() => editor.chain().focus().redo().run()}>
        <IconArrowForwardUp />
      </ToolButton>
      <Divider />
      <Dropdown title={uiT("ui.9aa08be49bdd")} width="w-28" disabled={off} label={blockStyleLabel(state?.style ?? "normal")} items={() => BLOCK_STYLES.map((entry) => ({ id: entry.id, label: blockStyleLabel(entry.id), checked: entry.id === state?.style, onSelect: () => act.style(entry.id) }))} />
      <Dropdown
        title={uiT("ui.64d0b3adcd2d")}
        width="w-32"
        disabled={off}
        label={<span style={{ fontFamily: shownFont }}>{shownFont}</span>}
        items={() => [{ id: 'default', label: uiT("ui.0af847cad0da"), checked: !state?.font, onSelect: () => act.font(null) }, ...FONTS.map((name, index) => ({ id: name, label: name, checked: name === state?.font, dividerBefore: index === 0, onSelect: () => act.font(name) }))]}
      />
      <Dropdown title={uiT("ui.6d784d95c638")} width="w-14" disabled={off} label={<span className="tabular-nums">{shownSize}</span>} items={() => [{ id: 'default', label: uiT("ui.02011db0bdf8"), checked: !state?.size, onSelect: () => act.fontSize(null) }, ...SIZES.map((size, index) => ({ id: String(size), label: String(size), checked: size === state?.size, dividerBefore: index === 0, onSelect: () => act.fontSize(size) }))]} />
      <Divider />
      {MARKS.map((mark) => (
        <ToolButton key={mark.id} label={mark.label} shortcut={mark.shortcut} disabled={off} active={state?.marks[mark.id]} onClick={() => act.toggleMark(mark.id)}>
          {mark.icon}
        </ToolButton>
      ))}
      <ColorButton label={uiT("ui.25e9c8090de7")} icon={<IconTextColor />} colors={TEXT_COLORS} current={state?.color ?? null} automatic="Automatic" onPick={act.color} />
      <ColorButton label={uiT("ui.07ccd15df32a")} icon={<IconHighlight />} colors={HIGHLIGHTS} current={state?.highlight ?? null} automatic="No highlight" onPick={act.highlight} />
      <Divider />
      {ALIGNMENTS.map((entry) => (
        <ToolButton key={entry.id} label={entry.label} shortcut={entry.shortcut} disabled={off} active={state?.align === entry.id} onClick={() => act.align(entry.id)}>
          {entry.icon}
        </ToolButton>
      ))}
      <Dropdown
        title={uiT("ui.0db45da1214b")}
        disabled={off}
        label={<IconLineHeight size={16} />}
        items={() => [{ id: 'style', label: uiT("ui.11cf3abeb68a"), checked: state?.lineHeight === null, onSelect: () => act.lineSpacing(null) }, ...LINE_SPACINGS.map((entry, index) => ({ id: String(entry.value), label: entry.label, checked: state?.lineHeight === entry.value, dividerBefore: index === 0, onSelect: () => act.lineSpacing(entry.value) }))]}
      />
      <Divider />
      <ToolButton label={uiT("ui.ce51b395cd6b")} shortcut="mod+shift+8" disabled={off} active={state?.list === 'bullet'} onClick={() => act.list('bullet')}>
        <IconList />
      </ToolButton>
      <ToolButton label={uiT("ui.cc62f6c7b2a8")} shortcut="mod+shift+7" disabled={off} active={state?.list === 'ordered'} onClick={() => act.list('ordered')}>
        <IconListNumbers />
      </ToolButton>
      <ToolButton label={uiT("ui.7346030400bf")} shortcut="mod+shift+9" disabled={off} active={state?.list === 'task'} onClick={() => act.list('task')}>
        <IconListCheck />
      </ToolButton>
      <ToolButton label={uiT("ui.88053f5581e7")} shortcut="mod+[" disabled={off} onClick={() => act.shiftIndent(-1)}>
        <IconIndentDecrease />
      </ToolButton>
      <ToolButton label={uiT("ui.b80a5d23d9c6")} shortcut="mod+]" disabled={off} onClick={() => act.shiftIndent(1)}>
        <IconIndentIncrease />
      </ToolButton>
      <Divider />
      <ToolButton label={uiT("ui.a6a32dbc5618")} shortcut="mod+k" disabled={off} active={state?.link} onClick={act.editLink}>
        <IconLink />
      </ToolButton>
      <ToolButton label={uiT("ui.44f5e3fbec57")} shortcut="mod+alt+m" disabled={off} onClick={() => startComment(editor.view, docKey) || docsSession.notify('Select some text to comment on')}>
        <IconMessagePlus />
      </ToolButton>
      <ToolButton label={uiT("ui.9a1c54f55e7c")} disabled={off} onClick={() => picker.current?.click()}>
        <IconPhoto />
      </ToolButton>
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml"
        multiple
        hidden
        onChange={(event) => {
          void act.picturesFromFiles([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
      <TableButton />
      <ToolButton label={uiT("ui.cc29053ff492")} disabled={off} onClick={act.rule}>
        <IconSeparatorHorizontal />
      </ToolButton>
      <ToolButton label={uiT("ui.a59506aa431f")} shortcut="mod+enter" disabled={off} onClick={act.pageBreak}>
        <IconPageBreak />
      </ToolButton>
      <Dropdown
        title={uiT("ui.d0d91173008b")}
        disabled={off}
        label={<IconInfoCircle size={16} />}
        items={() => [
          ...Object.entries(CALLOUT_LABELS).map(([kind, label]) => ({ id: kind, label, checked: editor.isActive('callout', { kind }), onSelect: () => act.callout(kind as keyof typeof CALLOUT_LABELS) })),
          ...(state?.callout ? [{ id: 'remove', label: uiT("ui.097c3b2149c2"), dividerBefore: true, onSelect: act.removeCallout }] : [])
        ]}
      />
      <Divider />
      <ToolButton label={uiT("ui.9e75ec87d1e3")} shortcut="mod+\" disabled={off} onClick={act.clear}>
        <IconClearFormatting />
      </ToolButton>
      {state?.table && (
        <>
          <Divider />
          <Dropdown title={uiT("ui.16d1c9050a0b")} label={uiT("ui.16d1c9050a0b")} items={() => tableMenu(editor)} />
        </>
      )}
    </div>
  )
}

const blockStyleKeys = {"normal":"office.block.normal","title":"office.block.title","subtitle":"office.block.subtitle","heading1":"office.block.heading1","heading2":"office.block.heading2","heading3":"office.block.heading3","quote":"office.block.quote","code":"office.block.code"} as const
/** Display labels only; model/agent style names stay stable. */
export const blockStyleLabel = (id: string): string => uiT(blockStyleKeys[id as keyof typeof blockStyleKeys] ?? "office.block.normal")
