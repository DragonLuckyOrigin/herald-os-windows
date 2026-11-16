import { t as uiT } from '../../../store/i18n.ts'
import type { OfficeCommand } from '../shell/commands.ts'
import * as act from './actions.ts'

/** The menu items for the page: what Insert and Format offer for headers, footers, notes, breaks and page setup. */
export function pageMenuItems(): { insert: OfficeCommand[]; format: OfficeCommand[] } {
  const has = act.hasEditor
  const inText = act.inText

  return {
    insert: [
      { id: 'header', label: uiT("ui.ba5caa4285a8"), enabled: has, dividerBefore: true, run: () => act.editPart('header') },
      { id: 'footer', label: uiT("ui.26c87bb51e69"), enabled: has, run: () => act.editPart('footer') },
      {
        id: 'page-number',
        label: uiT("ui.5ffac0c9dcdc"),
        enabled: has,
        run: () => {},
        submenu: [
          { id: 'field-page', label: uiT("ui.5ffac0c9dcdc"), enabled: has, run: () => act.field('page') },
          { id: 'field-page-of', label: uiT("ui.866f41729779"), enabled: has, run: () => act.field('pageOfPages') },
          { id: 'field-pages', label: uiT("ui.ec12d94e7bb1"), enabled: has, run: () => act.field('pages') },
          { id: 'field-date', label: uiT("ui.99c40ab40592"), enabled: has, dividerBefore: true, run: () => act.field('date') },
          { id: 'field-time', label: uiT("ui.33b93476cf59"), enabled: has, run: () => act.field('time') }
        ]
      },
      { id: 'footnote', label: uiT("ui.aa8885bcba3b"), shortcut: 'mod+alt+f', enabled: inText, dividerBefore: true, run: () => act.note('footnote') },
      { id: 'endnote', label: uiT("ui.150c8fdadd59"), shortcut: 'mod+alt+e', enabled: inText, run: () => act.note('endnote') },
      {
        id: 'break',
        label: uiT("ui.f71081fb0af4"),
        enabled: inText,
        dividerBefore: true,
        run: () => {},
        submenu: [
          { id: 'break-page', label: uiT("ui.db1bf01bfe41"), shortcut: 'mod+enter', enabled: inText, run: act.pageBreak },
          { id: 'break-next-page', label: uiT("ui.4296d14148fd"), enabled: inText, dividerBefore: true, run: () => act.sectionBreak('nextPage') },
          { id: 'break-continuous', label: uiT("ui.9a44817af170"), enabled: inText, run: () => act.sectionBreak('continuous') },
          { id: 'break-odd-page', label: uiT("ui.01accc6a13d1"), enabled: inText, run: () => act.sectionBreak('oddPage') },
          { id: 'break-even-page', label: uiT("ui.c4afa85ff74e"), enabled: inText, run: () => act.sectionBreak('evenPage') }
        ]
      }
    ],
    format: [{ id: 'page-setup', label: uiT("ui.c6d5a8033022"), shortcut: 'mod+shift+p', enabled: has, dividerBefore: true, run: act.pageSetup }]
  }
}
