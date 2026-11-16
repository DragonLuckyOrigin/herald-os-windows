import { t as uiT, useT as useUiT } from '../../../../store/i18n.ts'
import { IconArrowDown, IconArrowUp, IconPlus } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { openDialog } from '../ui/overlay.tsx'
import { describeTable, sortBy } from './model.ts'
import { Check, Choices, Heading, Note, RemoveButton, Select, ToolDialog, useLive } from './ui.tsx'

/* Data → Sort by several columns…: the columns to sort by in turn, each up or down, and whether the first row is headers. */

interface Key {
  column: string
  ascending: boolean
}

const move = (keys: Key[], index: number, by: number): Key[] => {
  const next = [...keys]
  const [key] = next.splice(index, 1)
  next.splice(index + by, 0, key)

  return next
}

function SortDialog({ docKey, range, sheet }: { docKey: string; range: string; sheet: string }) {
  useUiT()
  const table = useLive(docKey, (target) => describeTable(target, { range, sheet }), [range, sheet])
  const [keys, setKeys] = useState<Key[]>([])
  const [header, setHeader] = useState(true)
  const columns = table.value?.columns ?? []
  const nameOf = (letter: string) => {
    const column = columns.find((entry) => entry.letter === letter)

    return header && column ? `${column.name} (${letter})` : uiT('sheets.column', { letter })
  }

  useEffect(() => {
    if (table.value) {
      setHeader(table.value.header)
      setKeys(table.value.columns.length ? [{ column: table.value.columns[0].letter, ascending: true }] : [])
    }
  }, [table.value])

  const free = columns.filter((column) => !keys.some((key) => key.column === column.letter))
  const set = (index: number, change: Partial<Key>) => setKeys(keys.map((key, other) => (other === index ? { ...key, ...change } : key)))

  return (
    <ToolDialog
      docKey={docKey}
      title={uiT("ui.17a52c554979")}
      action={uiT('sheets.action.sort')}
      ready={Boolean(table.value && keys.length)}
      confirm={async (target) => {
        const done = await sortBy(target, { range: table.value!.range, sheet, keys, header })

        return uiT('sheets.sorted', { range: done.range, keys: done.keys.map((key) => `${nameOf(key.column)} ${uiT(key.ascending ? 'sheets.sort.ascending' : 'sheets.sort.descending')}`).join(uiT('sheets.sort.then')) })
      }}
    >
      {table.error ? (
        <Note tone="warn">{table.error}</Note>
      ) : (
        <>
          <section>
            <Heading
              action={
                <button type="button" disabled={!free.length} onClick={() => setKeys([...keys, { column: free[0].letter, ascending: true }])} className="flex items-center gap-1 text-[11.5px] text-accent-strong hover:underline disabled:opacity-40">
                  <IconPlus size={12} />{uiT("ui.85c38ac2ceb4")}</button>
              }
            >
              {uiT("ui.0016d5aa7406")}{table.value?.range ?? range}{uiT("ui.52e86deffb89")}</Heading>
            <div className="flex flex-col gap-1.5">
              {keys.map((key, index) => (
                <div key={index} className="flex items-center gap-1.5">
                  <span className="w-10 shrink-0 text-[11.5px] text-fg-3">{index === 0 ? uiT("ui.a151ceb1711a") : uiT("ui.0597f441dcca")}</span>
                  <Select label={uiT("ui.fdd9faa7840f", { value1: String(index + 1) })} value={key.column} autoFocus={index === 0} onChange={(event) => set(index, { column: event.target.value })} className="min-w-0 flex-1">
                    {columns
                      .filter((column) => column.letter === key.column || !keys.some((other) => other.column === column.letter))
                      .map((column) => (
                        <option key={column.letter} value={column.letter}>
                          {nameOf(column.letter)}
                        </option>
                      ))}
                  </Select>
                  <div className="w-36 shrink-0">
                    <Choices
                      label={uiT("ui.8dd7cd1e6727", { value1: String(nameOf(key.column)) })}
                      value={key.ascending ? 'up' : 'down'}
                      options={[
                        { id: 'up', label: uiT("ui.790e831a32e5"), title: uiT("ui.a297baae283f") },
                        { id: 'down', label: uiT("ui.efe8139e05c6"), title: uiT("ui.382db7fafe2a") }
                      ]}
                      onChange={(id) => set(index, { ascending: id === 'up' })}
                    />
                  </div>
                  <button type="button" aria-label={uiT("ui.7ba587e0b742")} title={uiT("ui.e10ae9907401")} disabled={index === 0} onClick={() => setKeys(move(keys, index, -1))} className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg disabled:opacity-30">
                    <IconArrowUp size={13} />
                  </button>
                  <button type="button" aria-label={uiT("ui.87672c6fcb52")} title={uiT("ui.73b6e48a1b55")} disabled={index === keys.length - 1} onClick={() => setKeys(move(keys, index, 1))} className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg disabled:opacity-30">
                    <IconArrowDown size={13} />
                  </button>
                  <RemoveButton label={uiT("ui.cb3965d2ff76", { value1: String(nameOf(key.column)) })} onClick={() => setKeys(keys.filter((_, other) => other !== index))} />
                </div>
              ))}
            </div>
          </section>
          <Check checked={header} onChange={setHeader}>
            {uiT("ui.3e003675dc65")}</Check>
        </>
      )}
    </ToolDialog>
  )
}

/** Open Sort by several columns for the selection (or the table around a single cell) in a document. */
export function openSortBy(docKey: string, selection: { sheet: string; range: string }): void {
  openDialog(docKey, <SortDialog docKey={docKey} range={selection.range} sheet={selection.sheet} />)
}
