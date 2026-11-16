import { t as uiT, useT as useUiT } from '../../../store/i18n.ts'
import { IconArrowDown, IconArrowUp, IconX } from '@tabler/icons-react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { findStateOf, revealMatch, selectMatch, setFind, stepMatch } from './find.ts'
import { applyLive, replaceText, type SearchOptions } from './model.ts'

/** Find, and replace, in one document: every match marked, the current one stepped through. */
export function FindBar({ editor, replace, at, onClose }: { editor: Editor; replace: boolean; at: number; onClose: () => void }) {
  useUiT()
  const [query, setQuery] = useState(() => {
    const { from, to } = editor.state.selection

    return to > from && to - from < 200 ? editor.state.doc.textBetween(from, to, ' ') : ''
  })
  const [replacement, setReplacement] = useState('')
  const [options, setOptions] = useState<SearchOptions>({})
  const [showReplace, setShowReplace] = useState(replace)
  const field = useRef<HTMLInputElement>(null)
  const found = useEditorState({ editor, selector: ({ editor: current }) => ({ count: findStateOf(current.state).matches.length, current: findStateOf(current.state).current }) })

  useEffect(() => {
    setShowReplace((shown) => shown || replace)
    field.current?.focus({ preventScroll: true })
    field.current?.select()
  }, [at])

  useEffect(() => {
    setFind(editor.view, query, options)
    revealMatch(editor.view)
  }, [query, options])

  useEffect(
    () => () => {
      if (!editor.isDestroyed) {
        setFind(editor.view, '', {})
      }
    },
    []
  )

  const close = () => {
    selectMatch(editor.view)
    setFind(editor.view, '', {})
    onClose()
    editor.commands.focus()
  }

  const replaceOne = () => {
    const { matches, current } = findStateOf(editor.state)
    const match = matches[current]

    if (match) {
      applyLive(editor.view, (state) => state.tr.insertText(replacement, match.from, match.to))
      revealMatch(editor.view)
    }
  }

  const option = (name: keyof SearchOptions, label: string, short: string) => (
    <button type="button" aria-pressed={Boolean(options[name])} title={label} onClick={() => setOptions({ ...options, [name]: !options[name] })} className={cn('h-6 rounded-md px-1.5 text-[11px] text-fg-3 hover:bg-white/8 hover:text-fg', options[name] && 'bg-white/12 text-fg')}>
      {short}
    </button>
  )

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5 text-[12px]"
      role="search"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          close()
        }
      }}
    >
      <input
        ref={field}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            stepMatch(editor.view, event.shiftKey ? -1 : 1)
          }
        }}
        placeholder={uiT("ui.5ed5f8ce994e")}
        aria-label={uiT("ui.822b2ae4542b")}
        className="glass-input h-7 w-56 rounded-md px-2 text-[12px] text-fg outline-none"
      />
      <span className="w-16 text-fg-3 tabular-nums">{query ? (found.count ? `${found.current + 1} of ${found.count}` : 'No matches') : ''}</span>
      <button type="button" aria-label={uiT("ui.daa2f8c3fc89")} title={uiT("ui.8f3da077d7fd")} disabled={!found.count} onClick={() => stepMatch(editor.view, -1)} className="grid size-7 place-items-center rounded-md text-fg-2 hover:bg-white/8 disabled:opacity-35">
        <IconArrowUp size={15} />
      </button>
      <button type="button" aria-label={uiT("ui.825e5abd0762")} title={uiT("ui.e4232fbd0f7e")} disabled={!found.count} onClick={() => stepMatch(editor.view, 1)} className="grid size-7 place-items-center rounded-md text-fg-2 hover:bg-white/8 disabled:opacity-35">
        <IconArrowDown size={15} />
      </button>
      {option('caseSensitive', 'Match case', 'Aa')}
      {option('wholeWord', 'Whole words', 'Word')}
      {option('regex', 'Regular expression', '.*')}
      {!showReplace && (
        <button type="button" onClick={() => setShowReplace(true)} className="h-6 rounded-md px-1.5 text-[11.5px] text-fg-3 hover:bg-white/8 hover:text-fg">
          {uiT("ui.3158be31a9b6")}</button>
      )}
      {showReplace && (
        <>
          <input
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                replaceOne()
              }
            }}
            placeholder={uiT("ui.8382d317c1d5")}
            aria-label={uiT("ui.8382d317c1d5")}
            className="glass-input ml-2 h-7 w-48 rounded-md px-2 text-[12px] text-fg outline-none"
          />
          <GlassButton size="sm" variant="ghost" disabled={!found.count} onClick={replaceOne}>
            {uiT("ui.71b576825729")}</GlassButton>
          <GlassButton size="sm" disabled={!found.count} onClick={() => applyLive(editor.view, replaceText(query, replacement, { ...options, all: true }))}>
            {uiT("ui.4b3da81b415a")}</GlassButton>
        </>
      )}
      <button type="button" aria-label={uiT("ui.eb903c9fde77")} title={uiT("ui.961b2a04403e")} onClick={close} className="ml-auto grid size-7 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg">
        <IconX size={15} />
      </button>
    </div>
  )
}
