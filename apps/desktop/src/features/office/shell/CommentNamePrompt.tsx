import { t as uiT, useT as useUiT } from '../../../store/i18n.ts'
import { useStore } from '@nanostores/react'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { COMMENT_NAME_MAX } from '../../../../shared/office/comment-name.ts'
import type { OfficeApp } from '../../../../shared/office/files.ts'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { useSystemInfo } from '../../../store/system.ts'
import { $nameQuestion, accountName, answerCommentName } from '../comment-name.ts'
import { Modal } from './dialogs.tsx'

/** What an Office window asks the first time the person adds a comment, a reply or a note in it: the name their comments show. */
export function CommentNamePrompt({ app }: { app: OfficeApp }): ReactNode {
  useUiT()
  const question = useStore($nameQuestion)

  // A window that closes while it asks cancels the question, so nothing waits for an answer it cannot get.
  useEffect(
    () => () => {
      if ($nameQuestion.get()?.app === app) {
        answerCommentName(null)
      }
    },
    [app]
  )

  return question?.app === app ? <NameDialog proposed={question.proposed} /> : null
}

function NameDialog({ proposed }: { proposed: string }) {
  useUiT()
  const account = accountName(useSystemInfo())
  const [name, setName] = useState(proposed || account)
  const cancel = () => answerCommentName(null)

  useEffect(() => {
    if (account) {
      setName((current) => current || account)
    }
  }, [account])

  const confirm = (event: FormEvent) => {
    event.preventDefault()

    if (name.trim()) {
      answerCommentName(name)
    }
  }

  return (
    // Above Univer's popups (z-index 1020), and keeping its comment editor open: Univer closes it, and what was typed in it, at a pointer down outside it.
    <div className="absolute inset-0 z-[1050]" onPointerDown={(event) => event.stopPropagation()}>
      <Modal title={uiT("ui.30d459b655a6")} onClose={cancel}>
        <form onSubmit={confirm}>
          <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
            {uiT("ui.d297e206e6d4")}<input autoFocus value={name} maxLength={COMMENT_NAME_MAX} onFocus={(event) => event.target.select()} onChange={(event) => setName(event.target.value)} className="glass-input h-8 w-full rounded-lg px-2 text-[13px] text-fg outline-none" />
          </label>
          <p className="mt-2 text-[11.5px] text-fg-3">{uiT("ui.d423e140f29a")}</p>
          <div className="mt-5 flex justify-end gap-2">
            <GlassButton variant="ghost" onClick={cancel}>
              {uiT("ui.0ef70263b054")}</GlassButton>
            <GlassButton variant="primary" type="submit" disabled={!name.trim()}>
              {uiT("ui.9560cc3b00c2")}</GlassButton>
          </div>
        </form>
      </Modal>
    </div>
  )
}
