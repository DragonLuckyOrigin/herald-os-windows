import { t as uiT, useT as useUiT } from '../../../store/i18n.ts'
import { IconBold, IconHighlight, IconItalic, IconLink, IconSparkles, IconStrikethrough, IconTextColor, IconUnderline } from '@tabler/icons-react'
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { useEditorState } from '@tiptap/react'
import { useEffect, useState } from 'react'
import { cn } from '../../../lib/cn.ts'
import { Menu } from '../../files/Menu.tsx'
import { docsActions } from '../hermes/actions.ts'
import { menuItems } from '../shell/OfficeWindow.tsx'
import * as act from './actions.ts'
import { anchorIn, clampLeft } from './overlay.ts'
import { docsSession } from './store.ts'
import { ToolButton } from './Toolbar.tsx'

const WIDTH = 348

/**
 * Formatting over a selection of text: the common marks, a link, colour and highlight, and what
 * Hermes does with the selection.
 */
export function BubbleBar({ editor, frame, tick }: { editor: Editor; frame: HTMLElement | null; tick: number }) {
  useUiT()
  const [pressed, setPressed] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const { selection } = current.state
      const shown = current.isFocused && selection instanceof TextSelection && !selection.empty && !current.isActive('codeBlock')

      return shown
        ? { from: selection.from, to: selection.to, bold: current.isActive('bold'), italic: current.isActive('italic'), underline: current.isActive('underline'), strike: current.isActive('strike'), link: current.isActive('link') }
        : null
    }
  })

  // Not while the selection is still being dragged out.
  useEffect(() => {
    const element = editor.view.dom
    const down = () => setPressed(true)
    const up = () => setPressed(false)
    element.addEventListener('mousedown', down)
    window.addEventListener('mouseup', up)

    return () => {
      element.removeEventListener('mousedown', down)
      window.removeEventListener('mouseup', up)
    }
  }, [editor])

  if (!state || pressed) {
    return null
  }

  void tick
  const at = `${state.from}-${state.to}`
  const menuOpen = menuFor === at
  const start = editor.view.coordsAtPos(state.from)
  const end = editor.view.coordsAtPos(state.to)
  const anchor = anchorIn(frame, { left: Math.min(start.left, end.left), right: Math.max(start.left, end.left), top: Math.min(start.top, end.top), bottom: end.bottom })

  if (!anchor || anchor.top < 0) {
    return null
  }

  return (
    <div role="toolbar" aria-label={uiT("ui.ca4067071fcf")} className="float menu-surface absolute z-30 flex items-center gap-0.5 rounded-xl p-1 animate-pop" style={{ width: WIDTH, left: clampLeft(frame, anchor.left, WIDTH), top: Math.max(4, anchor.top - 44) }} onMouseDown={(event) => event.preventDefault()}>
      <ToolButton label={uiT("ui.94fee62e68e2")} shortcut="mod+b" active={state.bold} onClick={() => act.toggleMark('bold')}>
        <IconBold />
      </ToolButton>
      <ToolButton label={uiT("ui.9bf37cb58a69")} shortcut="mod+i" active={state.italic} onClick={() => act.toggleMark('italic')}>
        <IconItalic />
      </ToolButton>
      <ToolButton label={uiT("ui.02f843261112")} shortcut="mod+u" active={state.underline} onClick={() => act.toggleMark('underline')}>
        <IconUnderline />
      </ToolButton>
      <ToolButton label={uiT("ui.9aabbcb2c18d")} shortcut="mod+shift+x" active={state.strike} onClick={() => act.toggleMark('strike')}>
        <IconStrikethrough />
      </ToolButton>
      <ToolButton label={uiT("ui.a6a32dbc5618")} shortcut="mod+k" active={state.link} onClick={act.editLink}>
        <IconLink />
      </ToolButton>
      <ToolButton label={uiT("ui.d2517ffa5491")} onClick={() => act.color('#c00000')}>
        <IconTextColor className="text-danger" />
      </ToolButton>
      <ToolButton label={uiT("ui.07ccd15df32a")} onClick={() => act.highlight('#fff27a')}>
        <IconHighlight className="text-warn" />
      </ToolButton>
      <span className="mx-1 h-5 w-px shrink-0 bg-line" />
      <div className="relative shrink-0">
        <button
          type="button"
          title={uiT("ui.a7bc5fece526")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={() => setMenuFor(menuOpen ? null : at)}
          className={cn('flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-fg-2 hover:bg-white/8 hover:text-fg', menuOpen && 'bg-white/10 text-fg')}
        >
          <IconSparkles size={14} />{uiT("ui.d5f4e2b24dd4")}</button>
        {menuOpen && (
          // The menu stops mousedown before the bubble sees it: the page keeps the focus, and the selection, from here.
          <div onMouseDownCapture={(event) => event.preventDefault()}>
            <Menu align="right" className="top-full mt-2 min-w-52" onClose={() => setMenuFor(null)} items={menuItems(docsActions({ docKey: () => docsSession.$activeKey.get(), hasSelection: () => !editor.state.selection.empty }))} />
          </div>
        )}
      </div>
    </div>
  )
}
