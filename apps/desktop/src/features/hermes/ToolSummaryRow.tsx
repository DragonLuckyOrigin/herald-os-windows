import { t as uiT, useT as useUiT } from '../../store/i18n.ts'
import { IconChevronDown, IconStack2 } from '@tabler/icons-react'
import { memo, useState } from 'react'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import type { ToolMessage } from '../../lib/chat-model.ts'
import { deviceNoun } from '../../lib/platform-labels.ts'
import { ToolRow } from '../chat/ToolRow.tsx'

type Category = 'read' | 'web' | 'terminal' | 'system' | 'write' | 'other'

function categoryOf(name: string): Category {
  if (name === 'read_file' || name === 'search_files') {
    return 'read'
  }

  if (name.startsWith('web_')) {
    return 'web'
  }

  if (name === 'terminal') {
    return 'terminal'
  }

  if (name.startsWith('system_')) {
    return 'system'
  }

  if (name === 'write_file' || name === 'patch') {
    return 'write'
  }

  return 'other'
}

const ORDER: Category[] = ['read', 'write', 'web', 'terminal', 'system', 'other']

function phrase(category: Category, n: number): string {
  switch (category) {
    case 'system': return uiT('tools.summary.system', { count: n, device: deviceNoun() })
    case 'read': return uiT('tools.summary.read', { count: n })
    case 'web': return uiT('tools.summary.web', { count: n })
    case 'terminal': return uiT('tools.summary.terminal', { count: n })
    case 'write': return uiT('tools.summary.write', { count: n })
    case 'other': return uiT('tools.summary.other', { count: n })
  }
}

/** Human summary of a run of tool calls: "Read 6 files · Checked 2 projects". */
export function summarizeTools(tools: ToolMessage[]): string {
  const counts = new Map<Category, number>()

  for (const tool of tools) {
    const category = categoryOf(tool.name)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }

  return ORDER.filter(c => counts.has(c))
    .map(c => phrase(c, counts.get(c) ?? 0))
    .join(' · ')
}

/** One collapsed row for all the tool calls of a turn; expands into the regular ToolRow list. */
export const ToolSummaryRow = memo(function ToolSummaryRow({ tools }: { tools: ToolMessage[] }) {
  useUiT()
  const [open, setOpen] = useState(false)
  const running = tools.some(t => t.running)
  const summary = summarizeTools(tools)

  return (
    <div className="glass-card rounded-xl">
      <button type="button" aria-expanded={open} aria-label={open ? uiT("ui.83ee69ff35cf") : uiT("ui.b3d317407b34")} onClick={() => setOpen(v => !v)} className="flex h-11 w-full items-center gap-3 rounded-xl px-3.5 text-left hover:bg-white/4">
        <span className="flex size-6 shrink-0 items-center justify-center text-fg-2">{running ? <Spinner /> : <IconStack2 size={17} stroke={1.6} />}</span>
        <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', running ? 'text-fg' : 'text-fg-2')}>{running ? uiT("ui.c5891b3caf2b", { value1: String(summary) }) : summary}</span>
        <IconChevronDown size={15} className={cn('shrink-0 text-fg-3 transition-transform duration-150', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t border-line px-2.5 pt-1.5 pb-2 animate-fade-in">
          {tools.map(tool => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </div>
      )}
    </div>
  )
})
