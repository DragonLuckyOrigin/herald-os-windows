import { t as uiT, useT as useUiT, $language as $uiLanguage } from '../../../store/i18n.ts'
import { type ReactNode, useMemo } from 'react'
import type { DocJSON } from '../../../../shared/office/document.ts'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { Modal } from '../shell/dialogs.tsx'
import { type DocumentStatistics, documentStatistics, durationLabel } from './statistics.ts'
import { $pages, $statistics, activeEditor, docsSession } from './store.ts'

const whole = (value: number): string => value.toLocaleString()

const tenths = (value: number): string => value.toLocaleString(undefined, { maximumFractionDigits: 1 })

const ROWS: { label: string; value: (stats: DocumentStatistics) => ReactNode }[] = [
  { get label() { return uiT("ui.0a8be89a52a8") }, value: (stats) => whole(stats.words) },
  { get label() { return uiT("ui.6fac39e2845b") }, value: (stats) => whole(stats.characters) },
  { get label() { return uiT("ui.8b8c36dc4778") }, value: (stats) => whole(stats.charactersNoSpaces) },
  { get label() { return uiT("ui.d2ef75e86bb7") }, value: (stats) => whole(stats.paragraphs) },
  { get label() { return uiT("ui.9fce2e3cccb1") }, value: (stats) => whole(stats.sentences) },
  { get label() { return uiT("ui.331db24297b8") }, value: (stats) => (stats.sentences ? tenths(stats.wordsPerSentence) : '–') },
  { get label() { return uiT("ui.7d2e3e6da34c") }, value: (stats) => (stats.words ? durationLabel(stats.readingMinutes) : '–') },
  { get label() { return uiT("ui.10cc520c877e") }, value: (stats) => (stats.words ? durationLabel(stats.speakingMinutes) : '–') },
  {
    get label() { return uiT("ui.25cae892f6b6") },
    value: (stats) =>
      stats.readability ? (
        <>
          {Math.round(stats.readability.score)}
          <span className="block text-[11px] text-fg-3">{stats.readability.label}</span>
        </>
      ) : (
        '–'
      )
  },
  { get label() { return uiT("ui.9cf79bbfd0f6") }, value: (stats) => (stats.readability ? tenths(stats.readability.grade) : '–') }
]

/** The figures of the document in front, with its pages as the page view laid them out, and the selection's beside them when text is selected. */
export function StatisticsDialog() {
  useUiT()
  const close = () => $statistics.set(false)
  const figures = useMemo(() => {
    const editor = activeEditor()
    const key = docsSession.$activeKey.get()

    if (!editor) {
      return null
    }

    const { selection } = editor.state
    const selected = selection.empty ? null : documentStatistics({ type: 'doc', content: selection.content().content.toJSON() ?? [] })
    const pages = key ? $pages.get()[key]?.pages.length : undefined

    return { all: documentStatistics(editor.state.doc.toJSON() as DocJSON, { pages }), selected: selected?.characters ? selected : null }
  }, [$uiLanguage.get(), ])

  return (
    <Modal title={uiT("ui.8a016fd49212")} onClose={close}>
      {figures && (
        <table className="w-full text-[12.5px] tabular-nums">
          {figures.selected && (
            <thead>
              <tr className="text-[11.5px] text-fg-3">
                <th />
                <th className="pb-1.5 text-right font-medium">{uiT("ui.ca4067071fcf")}</th>
                <th className="pb-1.5 pl-4 text-right font-medium">{uiT("ui.d6bd8c0aeee8")}</th>
              </tr>
            </thead>
          )}
          <tbody>
            {figures.all.pages !== undefined && (
              <tr>
                <td className="py-1 pr-4 text-fg-2">{uiT("ui.9046da16aea9")}</td>
                {figures.selected && <td />}
                <td className="selectable py-1 pl-4 text-right text-fg">{whole(figures.all.pages)}</td>
              </tr>
            )}
            {ROWS.map((row) => (
              <tr key={row.label} className="align-top">
                <td className="py-1 pr-4 text-fg-2">{row.label}</td>
                {figures.selected && <td className="selectable py-1 text-right text-fg">{row.value(figures.selected)}</td>}
                <td className="selectable py-1 pl-4 text-right text-fg">{row.value(figures.all)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-[11.5px] text-fg-3">{uiT("ui.363d34b8e51f")}</p>
      <div className="mt-5 flex justify-end">
        <GlassButton variant="primary" autoFocus onClick={close}>
          OK
        </GlassButton>
      </div>
    </Modal>
  )
}
