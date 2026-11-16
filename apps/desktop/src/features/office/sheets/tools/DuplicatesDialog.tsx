import { t as uiT, useT as useUiT } from '../../../../store/i18n.ts'
import { useEffect, useState } from 'react'
import { openDialog } from '../ui/overlay.tsx'
import { describeTable, removeDuplicates } from './model.ts'
import { Check, counted, Heading, Note, ToolDialog, useLive } from './ui.tsx'

/* Data → Remove duplicates…: the columns to compare, whether the first row is headers, and how many rows would go. */

function DuplicatesDialog({ docKey, range, sheet }: { docKey: string; range: string; sheet: string }) {
  useUiT()
  const table = useLive(docKey, (target) => describeTable(target, { range, sheet }), [range, sheet])
  const [header, setHeader] = useState(true)
  const [columns, setColumns] = useState<string[]>([])

  useEffect(() => {
    if (table.value) {
      setHeader(table.value.header)
      setColumns(table.value.columns.map((column) => column.letter))
    }
  }, [table.value])

  const ready = Boolean(table.value && columns.length)
  const preview = useLive(docKey, (target) => (ready ? removeDuplicates(target, { range: table.value!.range, sheet: table.value!.sheet, columns, header, preview: true }) : null), [ready, columns, header])
  const all = table.value?.columns ?? []

  return (
    <ToolDialog
      docKey={docKey}
      title={uiT("ui.af4adb5e92be")}
      action={uiT('sheets.action.duplicates')}
      ready={ready && Boolean(preview.value?.duplicates)}
      confirm={async (target) => {
        const done = await removeDuplicates(target, { range: table.value!.range, sheet: table.value!.sheet, columns, header })

        return uiT('sheets.duplicatesDone', { removed: counted(done.duplicates, 'duplicate row'), range: done.range, count: done.kept })
      }}
    >
      {table.error ? (
        <Note tone="warn">{table.error}</Note>
      ) : (
        <>
          <Check checked={header} onChange={setHeader} autoFocus>
            {uiT("ui.99a24b0c2d37")}</Check>
          <section>
            <Heading
              action={
                <button type="button" className="text-[11.5px] text-accent-strong hover:underline" onClick={() => setColumns(columns.length === all.length ? [] : all.map((column) => column.letter))}>
                  {columns.length === all.length ? uiT("ui.d60bf0bb4df0") : uiT("ui.1fc9a387654d")}
                </button>
              }
            >
              {uiT("ui.6b6200c18d6e")}{table.value?.range ?? range}
            </Heading>
            <div className="grid max-h-48 grid-cols-2 gap-x-3 gap-y-1.5 overflow-y-auto">
              {all.map((column) => (
                <Check key={column.letter} checked={columns.includes(column.letter)} onChange={(on) => setColumns(on ? [...columns, column.letter] : columns.filter((letter) => letter !== column.letter))}>
                  {header ? column.name : uiT("ui.1e737f830f1b", { value1: String(column.letter) })}
                </Check>
              ))}
            </div>
          </section>
          <Note tone={preview.error ? 'warn' : 'muted'}>
            {preview.error ||
              (!columns.length
                ? uiT('sheets.chooseCompare')
                : preview.value
                  ? preview.value.duplicates
                    ? uiT('sheets.duplicatesPreview', { removed: counted(preview.value.duplicates, 'duplicate row'), kept: counted(preview.value.kept, 'unique row') })
                    : uiT('sheets.noDuplicates', { rows: counted(preview.value.kept, 'row') })
                  : uiT('sheets.counting'))}
          </Note>
        </>
      )}
    </ToolDialog>
  )
}

/** Open Remove duplicates for the selection (or the table around a single cell) in a document. */
export function openRemoveDuplicates(docKey: string, selection: { sheet: string; range: string }): void {
  openDialog(docKey, <DuplicatesDialog docKey={docKey} range={selection.range} sheet={selection.sheet} />)
}
