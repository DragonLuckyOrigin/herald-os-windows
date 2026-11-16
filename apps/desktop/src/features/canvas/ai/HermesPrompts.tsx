import { t as uiT, useT as useUiT } from '../../../store/i18n.ts'
import { IconSparkles } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { Modal } from '../dialogs.tsx'
import type { CanvasDocument } from '../engine/document.ts'
import { $dialog } from '../menus.ts'
import { notify } from '../store.ts'
import { askHermes, prepareEdit, prepareGeneratedLayer, prepareGenerativeFill } from './hermes-ask.ts'

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Edit > Generative Fill and Layer > New Generated Layer: a few words for Hermes, who makes the picture with its image tool. */
export function GenerateDialog({ doc, mode }: { doc: CanvasDocument; mode: 'fill' | 'layer' }) {
  useUiT()
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const close = () => $dialog.set(null)
  const fill = mode === 'fill'
  const ready = fill || prompt.trim().length > 0

  const submit = () => {
    if (!ready || busy) {
      return
    }

    setBusy(true)
    askHermes(fill ? prepareGenerativeFill(doc, prompt) : prepareGeneratedLayer(doc, prompt))
      .then(() => {
        notify(fill ? uiT('canvas.notice.askedFill') : uiT('canvas.notice.askedLayer'))
        close()
      })
      .catch((error: unknown) => {
        notify(describe(error), 'error')
        setBusy(false)
      })
  }

  return (
    <Modal title={fill ? uiT("ui.2ca4fd3abcab") : uiT("ui.417febb014bb")} onClose={close}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <textarea
          autoFocus
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          aria-label={fill ? uiT("ui.1aaf53ef4129") : uiT("ui.ef66729cd3d5")}
          placeholder={fill ? uiT("ui.d016c6304072") : uiT("ui.8111af318de8")}
          className="glass-input w-full resize-none rounded-lg px-3 py-2.5 text-[13px] leading-relaxed outline-none placeholder:text-fg-4"
        />
        <p className="text-[11.5px] text-fg-3">
          {uiT("ui.b789345de36e")}{fill ? uiT("ui.99fbe8540432") : ''}{uiT("ui.dfe88b5c770f")}{fill ? uiT("ui.046af5886e8b") : uiT("ui.f5c0a269ef61")}{uiT("ui.9b49a8c71047")}</p>
        <div className="flex justify-end gap-2">
          <GlassButton type="button" variant="ghost" onClick={close}>
            {uiT("ui.0ef70263b054")}</GlassButton>
          <GlassButton type="submit" variant="primary" disabled={!ready || busy}>
            <IconSparkles size={14} />{uiT("ui.d5f4e2b24dd4")}</GlassButton>
        </div>
      </form>
    </Modal>
  )
}

/** The status bar's request line: an edit in words ("make it moodier"), which Hermes plans and makes with the canvas tool. */
export function AskHermesField({ doc }: { doc: CanvasDocument }) {
  useUiT()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = () => {
    const request = text.trim()

    if (!request || busy) {
      return
    }

    setBusy(true)
    askHermes(prepareEdit(doc, request))
      .then(() => {
        setText('')
        notify(uiT('canvas.notice.askedEdit'))
      })
      .catch((error: unknown) => notify(describe(error), 'error'))
      .finally(() => setBusy(false))
  }

  return (
    <form
      className="flex min-w-0 items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <IconSparkles size={13} className="shrink-0 text-fg-3" />
      <input
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation()

          if (event.key === 'Escape') {
            setText('')
            event.currentTarget.blur()
          }
        }}
        aria-label={uiT("ui.941321b593e5")}
        placeholder={uiT("ui.7a01591d11c0")}
        className="glass-input h-5 w-80 min-w-0 rounded-md px-2 text-[11.5px] text-fg outline-none placeholder:text-fg-4"
      />
    </form>
  )
}
