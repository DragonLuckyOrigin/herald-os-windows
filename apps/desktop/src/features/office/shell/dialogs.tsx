import { t as uiT, useT as useUiT } from '../../../store/i18n.ts'
import { IconAlertTriangle } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { byExtension, OFFICE_APP_NAMES } from '../../../../shared/office/files.ts'
import { GlassButton } from '../../../components/ui/glass.tsx'
import type { OfficeSession } from '../session.ts'

/** A dialog over the Office window (not the whole desktop); Escape and a click outside close it. */
export function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useUiT()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)

    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-black/35 p-6" onMouseDown={onClose}>
      <div role="dialog" aria-label={title} className="float menu-surface w-full max-w-md rounded-2xl p-5 animate-pop" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 text-[14px] font-medium text-fg">{title}</div>
        {children}
      </div>
    </div>
  )
}

function NoteList({ notes }: { notes: string[] }) {
  useUiT()
  return (
    <ul className="flex max-h-56 list-disc flex-col gap-1.5 overflow-y-auto pl-5 text-[12px] text-fg-2">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  )
}

export function NotesDialog<Model>({ session, title, notes }: { session: OfficeSession<Model>; title: string; notes: string[] }) {
  useUiT()
  const close = () => session.$dialog.set(null)

  return (
    <Modal title={title} onClose={close}>
      <p className="mb-2 text-[12.5px] text-fg-2">{uiT("ui.4827736de57a")}</p>
      <NoteList notes={notes} />
      <div className="mt-5 flex justify-end">
        <GlassButton variant="primary" autoFocus onClick={close}>
          OK
        </GlassButton>
      </div>
    </Modal>
  )
}

/**
 * Before Herald first saves over a file: what it showed differently when it opened the file, and
 * what the format will not keep. The person replaces the file, saves a copy instead, or goes back.
 */
export function FidelityDialog<Model>({ session, docKey, notes, losses, resolve }: { session: OfficeSession<Model>; docKey: string; notes: string[]; losses: string[]; resolve: (choice: 'replace' | 'copy' | 'cancel') => void }) {
  useUiT()
  const doc = session.find(docKey)
  const label = doc ? (byExtension(doc.format)?.label ?? doc.format) : ''
  const choose = (choice: 'replace' | 'copy' | 'cancel') => {
    session.$dialog.set(null)
    resolve(choice)
  }

  return (
    <Modal title={uiT("ui.b3d99780fed1", { value1: String(doc?.name ?? 'this file') })} onClose={() => choose('cancel')}>
      <div className="mb-3 flex gap-2.5 text-[12.5px] text-fg-2">
        <IconAlertTriangle size={18} className="mt-0.5 shrink-0 text-warn" />
        <span>{OFFICE_APP_NAMES[session.adapter.app]}{uiT("ui.fd827b23a4af")}</span>
      </div>
      {notes.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 text-[11.5px] font-medium tracking-wide text-fg-3 uppercase">{uiT("ui.1d5313a1584d")}</div>
          <NoteList notes={notes} />
        </div>
      )}
      {losses.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 text-[11.5px] font-medium tracking-wide text-fg-3 uppercase">{uiT("ui.a54b81a79262")}{label}</div>
          <NoteList notes={losses} />
        </div>
      )}
      <p className="mb-5 text-[11.5px] text-fg-3">{uiT("ui.6edae7d5e16f")}</p>
      <div className="flex justify-end gap-2">
        <GlassButton variant="ghost" onClick={() => choose('cancel')}>
          {uiT("ui.0ef70263b054")}</GlassButton>
        <GlassButton onClick={() => choose('copy')}>{uiT("ui.f848439727c5")}</GlassButton>
        <GlassButton variant="primary" autoFocus onClick={() => choose('replace')}>
          {uiT("ui.71b576825729")}</GlassButton>
      </div>
    </Modal>
  )
}

/** Close a document, asking first when it has unsaved edits. */
export function CloseDialog<Model>({ session, docKey }: { session: OfficeSession<Model>; docKey: string }) {
  useUiT()
  const doc = session.find(docKey)
  const close = () => session.$dialog.set(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!doc) {
      close()
    } else if (!doc.modified) {
      session.close(doc.key)
      close()
    }
  }, [doc])

  if (!doc?.modified) {
    return null
  }

  return (
    <Modal title={uiT("ui.13ba9400425f", { value1: String(doc.name) })} onClose={close}>
      <p className="mb-5 text-[12.5px] text-fg-2">{doc.path ? uiT("ui.7db60e5246ee") : uiT("ui.ed2de8183622")}</p>
      <div className="flex justify-end gap-2">
        <GlassButton
          variant="danger"
          onClick={() => {
            session.close(doc.key)
            close()
          }}
        >
          {uiT("ui.037bcb60247d")}</GlassButton>
        <GlassButton variant="ghost" onClick={close}>
          {uiT("ui.0ef70263b054")}</GlassButton>
        <GlassButton
          variant="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            session
              .save(doc)
              .then((saved) => {
                if (saved) {
                  session.close(doc.key)
                  close()
                }
              })
              .catch(() => {})
              .finally(() => setBusy(false))
          }}
        >
          {uiT("ui.f5f25c5769e6")}</GlassButton>
      </div>
    </Modal>
  )
}
