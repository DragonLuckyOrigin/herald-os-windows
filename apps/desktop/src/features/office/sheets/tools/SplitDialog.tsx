import { t as uiT, useT as useUiT } from '../../../../store/i18n.ts'
import { useState } from 'react'
import { openDialog } from '../ui/overlay.tsx'
import { splitText } from './model.ts'
import type { Delimiter } from './text.ts'
import { Check, Choices, counted, Heading, Note, PreviewGrid, TextField, ToolDialog, useLive } from './ui.tsx'

/* Data → Split text to columns…: the delimiter, where the parts go, and the first rows as they would split. */

const DELIMITER_CHOICES: { id: Delimiter; label: string }[] = [
  { id: 'comma', get label() { return uiT("ui.80f2d0366b04") } },
  { id: 'semicolon', get label() { return uiT("ui.1a68548f90da") } },
  { id: 'tab', get label() { return uiT("ui.90ddf1963abb") } },
  { id: 'space', get label() { return uiT("ui.20eac5aae274") } },
  { id: 'other', get label() { return uiT("ui.f97e9da0e3b8") } }
]

function SplitDialog({ docKey, range, sheet }: { docKey: string; range: string; sheet: string }) {
  useUiT()
  const [delimiter, setDelimiter] = useState<Delimiter>('comma')
  const [other, setOther] = useState('')
  const [consecutive, setConsecutive] = useState(false)
  const [destination, setDestination] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const args = { range, sheet, delimiter, other, consecutive, destination: destination.trim() || undefined, overwrite }
  const preview = useLive(docKey, (target) => (delimiter === 'other' && !other ? null : splitText(target, { ...args, preview: true })), [delimiter, other, consecutive, destination])
  const result = preview.value

  return (
    <ToolDialog
      docKey={docKey}
      title={uiT("ui.70e6c88af37a")}
      action={uiT('sheets.action.split')}
      ready={Boolean(result?.rows) && (!result?.overwrites || overwrite)}
      confirm={async (target) => {
        const done = await splitText(target, args)

        return uiT('sheets.splitDone', { cells: counted(done.rows, 'cell'), range: done.range, columns: counted(done.columns, 'column'), destination: done.destination })
      }}
    >
      <section>
        <Heading>{uiT("ui.6c075ed87b3e")}</Heading>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Choices label={uiT("ui.4b4eb3b88e85")} value={delimiter} options={DELIMITER_CHOICES} onChange={setDelimiter} autoFocus />
          </div>
          {delimiter === 'other' && <TextField label={uiT("ui.47267f0e3577")} placeholder="|" value={other} onChange={(event) => setOther(event.target.value)} autoFocus className="w-14 shrink-0" />}
        </div>
      </section>
      <Check checked={consecutive} onChange={setConsecutive}>
        {uiT("ui.d8e6ada5a6c7")}</Check>
      <label className="flex items-center gap-2 text-[12px] text-fg-2">
        <span className="shrink-0">{uiT("ui.79f85abb3a6a")}</span>
        <TextField label={uiT("ui.600d8a170c38")} placeholder={range.split(':')[0]} value={destination} onChange={(event) => setDestination(event.target.value)} className="w-28" />
        <span className="text-fg-3">{destination.trim() ? '' : uiT("ui.eaf2c223782f")}</span>
      </label>
      {result && (
        <section>
          <Heading>
            {result.rows ? uiT("ui.d794fcd39fbf", { value1: String(counted(result.rows, 'cell')), value2: String(counted(result.columns, 'column')), value3: String(result.destination) }) : uiT("ui.2468cb81915b", { value1: String(result.range) })}
          </Heading>
          {result.preview.length > 0 && <PreviewGrid rows={result.preview} />}
        </section>
      )}
      {result && result.overwrites > 0 && (
        <Check checked={overwrite} onChange={setOverwrite}>
          {uiT("ui.26a71ef19668")}{counted(result.overwrites, 'cell')}{uiT("ui.0182cb1266d6")}</Check>
      )}
      {preview.error && <Note tone="warn">{preview.error}</Note>}
    </ToolDialog>
  )
}

/** Open Split text to columns for the selection (or a cell's column in its table) in a document. */
export function openSplitText(docKey: string, selection: { sheet: string; range: string }): void {
  openDialog(docKey, <SplitDialog docKey={docKey} range={selection.range} sheet={selection.sheet} />)
}
