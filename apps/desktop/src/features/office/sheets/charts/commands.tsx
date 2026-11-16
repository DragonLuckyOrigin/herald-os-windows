import { t as uiT } from '../../../../store/i18n.ts'
import { quoteSheet } from '../../../../../shared/office/xlsx/address.ts'
import type { OfficeCommand } from '../../shell/commands.ts'
import { activeKey, activeWorkbook, failed } from '../active.ts'
import { sheetsSession } from '../store.ts'
import { openInsertChart } from './InsertDialog.tsx'
import { removeChart } from './model.ts'
import { openChartPanel } from './panel.tsx'
import { copyChartPicture } from './picture.ts'
import { selectedChart } from './select.ts'

/** The workbook in front with the chart the menus act on: the one selected, or the only one on the sheet. */
function chosen() {
  const active = activeWorkbook()
  const chart = active ? selectedChart(active.target) : null

  return active && chart ? { ...active, chart } : null
}

/** The Insert menu's charts: a new one from the selection, and the settings, a picture or the end of the chart chosen. */
export function chartCommands(): OfficeCommand[] {
  const has = () => Boolean(chosen())

  return [
    {
      id: 'chart-insert',
      label: uiT("ui.97525fdf8562"),
      enabled: () => Boolean(activeKey()),
      run: () => {
        const active = activeWorkbook()

        if (active) {
          openInsertChart(active.key, active.selection ? `${quoteSheet(active.selection.sheet)}!${active.selection.range}` : 'A1')
        }
      }
    },
    {
      id: 'chart-settings',
      label: uiT("ui.6124c8814292"),
      enabled: has,
      dividerBefore: true,
      run: () => {
        const found = chosen()

        if (found) {
          openChartPanel(found.key, found.chart.id)
        }
      }
    },
    {
      id: 'chart-copy',
      label: uiT("ui.b0bdbbeaedba"),
      enabled: has,
      run: () => {
        const found = chosen()

        if (found) {
          copyChartPicture(found.target, found.chart).then(() => sheetsSession.notify(uiT('sheets.chart.copied')), failed)
        }
      }
    },
    {
      id: 'chart-delete',
      label: uiT("ui.177803d851c8"),
      enabled: has,
      run: () => {
        const found = chosen()

        if (found) {
          removeChart(found.target, { chart: found.chart.id }).catch(failed)
        }
      }
    }
  ]
}
