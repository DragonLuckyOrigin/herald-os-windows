import { t as uiT } from '../../../../store/i18n.ts'
import type { OfficeCommand } from '../../shell/commands.ts'
import { activeKey } from '../active.ts'
import { openNameManager } from './NameManager.tsx'

/** The Data menu's named ranges. */
export function nameCommands(): OfficeCommand[] {
  return [
    {
      id: 'names',
      label: uiT("ui.6e1e7d84b8b8"),
      dividerBefore: true,
      enabled: () => Boolean(activeKey()),
      run: () => {
        const key = activeKey()

        if (key) {
          openNameManager(key)
        }
      }
    }
  ]
}
