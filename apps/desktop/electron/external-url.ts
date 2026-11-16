import { isPrivacyPaneUrl } from '../shared/privacy-panes.ts'
import { isWindowsSystemUrl } from '../shared/windows-links.ts'

/**
 * What the renderer may hand to `shell.openExternal`: web pages anywhere, and on macOS the Privacy &
 * Security panes of System Settings. Windows may open its listed Settings pages and Outlook Calendar.
 * Every other scheme or native destination stays refused.
 */
export function mayOpenExternally(url: unknown, platform: NodeJS.Platform = process.platform): url is string {
  if (typeof url !== 'string') {
    return false
  }

  if (/^https?:\/\//i.test(url)) {
    return true
  }

  return (platform === 'darwin' && isPrivacyPaneUrl(url)) || (platform === 'win32' && isWindowsSystemUrl(url))
}
