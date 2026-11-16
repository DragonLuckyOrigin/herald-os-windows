import { t as uiT, useT as useUiT } from '../../../../store/i18n.ts'
import { type FormEvent, useEffect, useState } from 'react'
import { GlassButton } from '../../../../components/ui/glass.tsx'
import { messageOf } from '../../../canvas/errors.ts'
import { Modal } from '../../shell/dialogs.tsx'
import { $saveTemplate, docsSession } from '../store.ts'
import { type SavedTemplate, savedTemplates, saveTemplate } from './saved.ts'

const withoutExtension = (name: string): string => name.replace(/\.[a-z0-9]{1,5}$/i, '')

/** Keep the document in front as a template, under a name: it is in File > New from then on. */
export function SaveTemplateDialog() {
  useUiT()
  const doc = docsSession.active()
  const [name, setName] = useState(() => withoutExtension(doc?.name ?? ''))
  const [existing, setExisting] = useState<SavedTemplate[]>([])
  const [busy, setBusy] = useState(false)
  const clash = existing.find((template) => template.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())
  const close = () => $saveTemplate.set(false)

  useEffect(() => {
    void savedTemplates()
      .then(setExisting)
      .catch(() => {})
  }, [])

  const save = async (event: FormEvent) => {
    event.preventDefault()

    if (!doc || !name.trim() || busy) {
      return
    }

    setBusy(true)

    try {
      await doc.editor?.settle?.()
      const saved = await saveTemplate(name, doc.editor?.snapshot() ?? doc.initial, clash?.id)
      docsSession.notify(uiT('docs.templates.saved', { name: saved.name }))
      close()
    } catch (error) {
      docsSession.notify(uiT('docs.templates.saveFailed', { error: messageOf(error) }), 'error')
      setBusy(false)
    }
  }

  return (
    <Modal title={uiT("ui.c4fcbe6866f5")} onClose={close}>
      <form onSubmit={(event) => void save(event)}>
        <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
          {uiT("ui.d297e206e6d4")}<input autoFocus value={name} maxLength={120} onFocus={(event) => event.target.select()} onChange={(event) => setName(event.target.value)} className="glass-input h-8 w-full rounded-lg px-2 text-[13px] text-fg outline-none" />
        </label>
        <p className="mt-2 text-[11.5px] text-fg-3">{clash ? uiT("ui.c6275ff892fa", { value1: String(clash.name) }) : uiT("ui.76b8bd191344")}</p>
        <div className="mt-5 flex justify-end gap-2">
          <GlassButton variant="ghost" onClick={close}>
            {uiT("ui.0ef70263b054")}</GlassButton>
          <GlassButton variant="primary" type="submit" disabled={busy || !doc || !name.trim()}>
            {clash ? uiT("ui.95e154398a4b") : uiT("ui.1509f561f241")}
          </GlassButton>
        </div>
      </form>
    </Modal>
  )
}
