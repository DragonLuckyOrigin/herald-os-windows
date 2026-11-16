import { t as uiT, useT as useUiT } from '../../store/i18n.ts'
import { IconBrain, IconPencil, IconShieldCheck, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import { EmptyGlass, GlassButton, GlassCard, KeyValue, Pill, Toggle } from '../../components/ui/glass.tsx'
import { formatRelative } from '../../lib/format.ts'
import { MemoryTile } from './memory-icons.tsx'
import { type MemoryEntry } from './memory-store.ts'
import { formatShortDate } from './MemoryRow.tsx'
import type { MemoryToolsetState } from './use-memory-toolset.ts'

interface DetailProps {
  entry: MemoryEntry | null
  /** Sessions whose title/preview shares a keyword with the entry title. */
  related: number
  /** False when the source file was truncated on read; writing would lose data. */
  editable: boolean
  busy: boolean
  onSave: (entry: MemoryEntry, text: string) => Promise<boolean>
  onForget: (entry: MemoryEntry) => Promise<boolean>
  onAdd: () => void
  toolset: MemoryToolsetState
  hasAny: boolean
}

/** Right-hand detail card: one memory, its provenance, edit/forget, and the "pause memory" footer. */
export function MemoryDetail({ entry, related, editable, busy, onSave, onForget, onAdd, toolset, hasAny }: DetailProps) {
  useUiT()
  return (
    <GlassCard className="flex w-[380px] shrink-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {entry ? (
          <DetailBody key={entry.id} entry={entry} related={related} editable={editable} busy={busy} onSave={onSave} onForget={onForget} />
        ) : (
          <EmptyGlass
            className="h-full min-h-60"
            icon={<IconBrain />}
            title={hasAny ? uiT("ui.1c29b8d9617f") : uiT("ui.52b468cbb7d4")}
            description={hasAny ? uiT("ui.1af75f1fa506") : uiT("ui.b38b89284247")}
            action={
              hasAny ? undefined : (
                <GlassButton size="sm" variant="primary" onClick={onAdd}>
                  {uiT("ui.866a0626bf08")}</GlassButton>
              )
            }
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-fg-3">
          <IconShieldCheck size={15} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{uiT("ui.355f7665ca5d")}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="text-[12px] text-fg-2">{uiT("ui.38f3b5e370f7")}</span>
          <Toggle checked={toolset.paused} onChange={value => void toolset.setPaused(value)} label={uiT("ui.38f3b5e370f7")} disabled={!toolset.known || toolset.busy} />
        </div>
      </div>
    </GlassCard>
  )
}

type Mode = 'view' | 'edit' | 'confirm'

function DetailBody({ entry, related, editable, busy, onSave, onForget }: Omit<DetailProps, 'entry' | 'onAdd' | 'toolset' | 'hasAny'> & { entry: MemoryEntry }) {
  useUiT()
  const [mode, setMode] = useState<Mode>('view')
  const [draft, setDraft] = useState(entry.text)
  const trimmed = draft.trim()
  const changed = trimmed.length > 0 && trimmed !== entry.text

  const cancel = () => {
    setDraft(entry.text)
    setMode('view')
  }

  const save = async () => {
    if (!changed || busy) {
      return
    }

    if (await onSave(entry, trimmed)) {
      setMode('view')
    }
  }

  const forget = async () => {
    if (busy) {
      return
    }

    if (!(await onForget(entry))) {
      setMode('view')
    }
  }

  return (
    <div className="flex flex-col gap-5 animate-rise">
      <div className="flex items-start gap-4">
        <MemoryTile entry={entry} size={56} />
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="selectable text-[18px] leading-tight font-semibold text-fg">{entry.title}</h2>
          <Pill tone="accent" className="mt-2">
            {uiT(({ preference: 'memory.kind.preference', project: 'memory.kind.project', person: 'memory.kind.person', knowledge: 'memory.kind.knowledge' } as const)[entry.kind])}
          </Pill>
        </div>
      </div>

      <KeyValue
        rows={[
          {
            label: uiT("ui.47bd29075f8b"),
            value:
              mode === 'edit' ? (
                <textarea
                  autoFocus
                  aria-label={uiT("ui.69191fe1c012")}
                  value={draft}
                  disabled={busy}
                  onChange={event => setDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      void save()
                    } else if (event.key === 'Escape') {
                      cancel()
                    }
                  }}
                  rows={6}
                  className="glass-input selectable w-full min-h-40 resize-y rounded-lg px-3 py-2.5 text-[12.5px] leading-relaxed text-fg outline-none disabled:opacity-60"
                />
              ) : (
                <div className="whitespace-pre-wrap break-words leading-relaxed">{entry.text}</div>
              )
          }
        ]}
      />

      <div className="h-px bg-line" />

      <KeyValue
        rows={[
          { label: uiT("ui.0e570ca6fabe"), value: `${entry.file} · ${formatShortDate(entry.date)}` },
          { label: uiT("ui.382ac5f308f7"), value: formatRelative(entry.fileModifiedAt) || '—' },
          { label: uiT("ui.a02dadd12c8e"), value: related > 0 ? `${related} recent conversation${related === 1 ? '' : 's'}` : '—' }
        ]}
      />

      {mode === 'confirm' ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 animate-rise" role="alertdialog" aria-label={uiT("ui.c257fa4d8646")}>
          <span className="text-[12.5px] text-fg">{uiT("ui.c257fa4d8646")}</span>
          <div className="flex items-center gap-2">
            <GlassButton size="sm" onClick={() => setMode('view')} disabled={busy}>
              {uiT("ui.0ef70263b054")}</GlassButton>
            <GlassButton size="sm" variant="danger" onClick={() => void forget()} disabled={busy}>
              {uiT("ui.f35ee2fc58c4")}</GlassButton>
          </div>
        </div>
      ) : mode === 'edit' ? (
        <div className="flex items-center gap-2">
          <GlassButton variant="primary" className="flex-1" disabled={!changed || busy} onClick={() => void save()}>
            {uiT("ui.f5f25c5769e6")}</GlassButton>
          <GlassButton onClick={cancel} disabled={busy}>
            {uiT("ui.0ef70263b054")}</GlassButton>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <GlassButton variant="primary" className="flex-1" disabled={!editable || busy} onClick={() => setMode('edit')}>
            <IconPencil />
            {uiT("ui.02d62d13be1e")}</GlassButton>
          <GlassButton variant="danger" disabled={!editable || busy} onClick={() => setMode('confirm')}>
            <IconTrash />
            {uiT("ui.f35ee2fc58c4")}</GlassButton>
        </div>
      )}

      {!editable && <div className="text-[12px] text-fg-3">{uiT("ui.dd741923a39f")}</div>}
    </div>
  )
}
