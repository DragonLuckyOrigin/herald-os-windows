import { t as uiT, useT as useUiT } from '../../store/i18n.ts'
import { IconRocket } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton } from '../../components/ui/glass.tsx'
import { startMission } from '../../store/missions-actions.ts'
import { notify } from '../../store/notifications.ts'

export function MissionComposer({ onClose }: { onClose: () => void }) {
  useUiT()
  const [text, setText] = useState('')
  const [starting, setStarting] = useState(false)
  const ready = text.trim().length > 0 && !starting

  const start = async () => {
    const goal = text.trim()

    if (!goal || starting) {
      return
    }

    setStarting(true)

    try {
      await startMission(goal)
      onClose()
    } catch (error) {
      notify({ title: uiT("ui.d01e16d9021f"), body: error instanceof Error ? error.message : String(error), level: 'error' })
      setStarting(false)
    }
  }

  return (
    <div className="glass-card animate-rise flex flex-col gap-3 rounded-xl p-4">
      <div className="flex items-center gap-2 text-[14px] font-semibold text-fg">
        <IconRocket size={16} className="text-accent-strong" />
        {uiT("ui.f47572556a86")}</div>
      <textarea
        value={text}
        autoFocus
        rows={3}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void start()
          }

          if (event.key === 'Escape') {
            onClose()
          }
        }}
        placeholder={uiT("ui.d31b297599d1")}
        aria-label={uiT("ui.282057da59df")}
        className="glass-input w-full resize-none rounded-lg px-3 py-2.5 text-[13px] text-fg outline-none placeholder:text-fg-4"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-fg-4">{uiT("ui.9228e51790a5")}</span>
        <div className="flex items-center gap-2">
          <GlassButton size="sm" variant="ghost" onClick={onClose} disabled={starting}>
            {uiT("ui.0ef70263b054")}</GlassButton>
          <GlassButton size="sm" variant="primary" onClick={() => void start()} disabled={!ready}>
            {starting ? uiT("ui.bbe5fc3b9ef3") : uiT("ui.8cbba8f23931")}
          </GlassButton>
        </div>
      </div>
    </div>
  )
}
