import { t as uiT } from '../../../../store/i18n.ts'
import { parseRange, quoteSheet } from '../../../../../shared/office/xlsx/address.ts'
import type { OfficeCommand } from '../../shell/commands.ts'
import { activeKey, activeWorkbook, failed } from '../active.ts'
import type { SheetsTarget } from '../model.ts'
import { sheetsSession } from '../store.ts'
import { openConvertDates } from './DatesDialog.tsx'
import { openRemoveDuplicates } from './DuplicatesDialog.tsx'
import { changeCase, convertToNumbers, fillDown, highlightDuplicates, listSummaries, refreshSummary, trimText } from './model.ts'
import { openSortBy } from './SortDialog.tsx'
import { openSplitText } from './SplitDialog.tsx'
import { openSummarize } from './SummarizeDialog.tsx'
import { summariesOf } from './summary.ts'
import type { TextCase } from './text.ts'
import { counted } from './ui.tsx'

type Selection = { sheet: string; range: string }

/** The workbook in front, when it has a selection to work on. */
function selected(): { key: string; target: SheetsTarget; selection: Selection } | null {
  const active = activeWorkbook()

  return active?.selection ? { key: active.key, target: active.target, selection: active.selection } : null
}

const hasDocument = () => Boolean(activeKey())

/** A command that runs a tool on the selection and says what it did in the window's notice. */
const onSelection = (id: string, label: string, work: (target: SheetsTarget, selection: Selection) => Promise<string>, extra: Partial<OfficeCommand> = {}): OfficeCommand => ({
  id,
  label,
  enabled: hasDocument,
  run: () => {
    const active = selected()

    if (active) {
      work(active.target, active.selection).then((message) => sheetsSession.notify(message), failed)
    }
  },
  ...extra
})

/** A command that opens a tool's dialog for the selection. */
const withDialog = (id: string, label: string, open: (docKey: string, selection: Selection) => void, extra: Partial<OfficeCommand> = {}): OfficeCommand => ({
  id,
  label,
  enabled: hasDocument,
  run: () => {
    const active = selected()

    if (active) {
      open(active.key, active.selection)
    }
  },
  ...extra
})

const cases = (): [TextCase, string][] => [
  ['upper', uiT('sheets.case.upper')],
  ['lower', uiT('sheets.case.lower')],
  ['title', uiT('sheets.case.title')],
  ['sentence', uiT('sheets.case.sentence')]
]

const quoted = (entries: { cell: string; text: string }[], total: number): string => `${entries.slice(0, 3).map((entry) => `${entry.cell} “${entry.text}”`).join(', ')}${total > 3 ? '…' : ''}`

/** Refresh the summary the selection is in, or every summary on the sheet in front. */
async function refreshHere(target: SheetsTarget, selection: Selection): Promise<string> {
  const at = parseRange(selection.range)
  const inside = listSummaries(target, { sheet: selection.sheet }).summaries.find((summary) => {
    const area = parseRange(summary.range)

    return at && area && at.startRow >= area.startRow && at.startRow <= area.endRow && at.startColumn >= area.startColumn && at.startColumn <= area.endColumn
  })
  const done = await refreshSummary(target, { sheet: selection.sheet, summary: inside?.id })

  if (done.summaries.length !== 1) {
    return uiT('sheets.tools.refreshAll', { summaries: counted(done.summaries.length, 'summary', 'summaries'), sheet: done.sheet })
  }

  const [summary] = done.summaries
  const change = summary.rows - summary.before

  return uiT('sheets.tools.refreshOne', { range: summary.range, rows: counted(summary.rows, 'row label'), change: change ? uiT(change > 0 ? 'sheets.tools.more' : 'sheets.tools.fewer', { count: Math.abs(change) }) : '' })
}

/** The Data menu's data tools and summaries. */
export function dataToolCommands(): OfficeCommand[] {
  return [
    withDialog('summarize', uiT('sheets.tools.summaryMenu'), (docKey, selection) => openSummarize(docKey, `${quoteSheet(selection.sheet)}!${selection.range}`), { dividerBefore: true }),
    onSelection('summary-refresh', uiT('sheets.tools.refreshMenu'), refreshHere, {
      enabled: () => {
        const active = activeWorkbook()

        return Boolean(active && summariesOf(active.target.workbook.getActiveSheet()).length)
      }
    }),
    withDialog('remove-duplicates', uiT('sheets.tools.duplicatesMenu'), openRemoveDuplicates, { dividerBefore: true }),
    withDialog('split-text', uiT('sheets.tools.splitMenu'), openSplitText),
    onSelection('trim-text', uiT('sheets.tools.trimMenu'), async (target, selection) => {
      const done = await trimText(target, selection)

      return done.changed ? uiT('sheets.tools.trimDone', { cells: counted(done.changed, 'cell'), range: done.range }) : uiT('sheets.tools.trimNone', { range: done.range })
    }),
    {
      id: 'change-case',
      label: uiT("ui.f97fe5805540"),
      enabled: hasDocument,
      run: () => {},
      submenu: cases().map(([to, label]) =>
        onSelection(`case-${to}`, label, async (target, selection) => {
          const done = await changeCase(target, { ...selection, to })

          return done.changed ? uiT('sheets.tools.caseDone', { cells: counted(done.changed, 'cell'), range: done.range, label }) : uiT('sheets.tools.caseNone', { range: done.range, label })
        })
      )
    },
    onSelection('convert-numbers', uiT('sheets.tools.numbersMenu'), async (target, selection) => {
      const done = await convertToNumbers(target, selection)
      const left = done.failed ? uiT('sheets.tools.numberFailed', { cells: counted(done.failed, 'cell'), examples: quoted(done.notConverted, done.failed) }) : ''

      if (!done.converted) {
        return left ? uiT('sheets.tools.nothingConverted', { range: done.range, left }) : uiT('sheets.tools.noNumbers', { range: done.range })
      }

      return uiT('sheets.tools.numbersDone', { cells: counted(done.converted, 'cell'), range: done.range, left: left ? `; ${left}` : '' })
    }),
    withDialog('convert-dates', uiT('sheets.tools.datesMenu'), openConvertDates),
    onSelection('fill-down', uiT('sheets.tools.fillMenu'), async (target, selection) => {
      const done = await fillDown(target, selection)

      return done.filled ? uiT('sheets.tools.fillDone', { cells: counted(done.filled, 'empty cell'), range: done.range }) : uiT('sheets.tools.fillNone', { range: done.range })
    }),
    onSelection(
      'highlight-duplicates',
      uiT('sheets.tools.highlightMenu'),
      async (target, selection) => {
        const done = await highlightDuplicates(target, selection)

        return done.duplicates ? uiT('sheets.tools.highlightDone', { cells: counted(done.duplicates, 'duplicate cell'), range: done.range }) : uiT('sheets.tools.highlightNone', { range: done.range })
      },
      { dividerBefore: true }
    ),
    withDialog('sort-several', uiT('sheets.tools.sortMenu'), openSortBy)
  ]
}
