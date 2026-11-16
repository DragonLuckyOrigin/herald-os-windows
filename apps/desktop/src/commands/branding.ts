import type { BrandingPatch } from '../../shared/branding.ts'
import { $branding } from '../store/branding.ts'
import { $env } from '../store/backend.ts'
import { t } from '../store/i18n.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'

/* Branding: About's logo and name, and the lock-screen picture on Herald OS Linux. */

const describe = () => {
  const view = $branding.get()

  return { name: view.name, logo: Boolean(view.logo), lock: view.lock }
}

export const brandingCommands: readonly OsCommand[] = [
  {
    id: 'branding.show',
    title: 'Branding',
    description: 'The logo and name About shows, and the lock-screen picture (Herald OS Linux).',
    tier: 'read',
    args: [],
    run: () => {
      const data = describe()

      return ok(
        [
          data.name ? t('commands.msg.branding.nameIs', { name: data.name }) : t('commands.msg.branding.noName'),
          data.logo ? t('commands.msg.branding.customLogo') : t('commands.msg.branding.heraldLogo'),
          data.lock ? t('commands.msg.branding.lockIs', { lock: data.lock }) : t('commands.msg.branding.themedLock')
        ].join(', '),
        { data, highlight: { kind: 'setting', id: 'about' } }
      )
    }
  },
  {
    id: 'branding.set',
    title: 'Set the branding',
    description: 'Set the logo and name About shows, or the lock-screen picture (Herald OS Linux). Images are copied, so the originals can move.',
    tier: 'mutate',
    args: [
      { name: 'logo', type: 'string', description: 'Path to a PNG, JPEG, WebP or SVG logo' },
      { name: 'lock', type: 'string', description: 'Path to a PNG or JPEG for the lock screen' },
      { name: 'name', type: 'string', description: 'A name to show under the logo, such as a company' }
    ],
    run: async ({ logo, lock, name }) => {
      const patch: BrandingPatch = {
        ...(logo !== undefined ? { logo: String(logo) } : {}),
        ...(lock !== undefined ? { lock: String(lock) } : {}),
        ...(name !== undefined ? { name: String(name) } : {})
      }

      if (Object.keys(patch).length === 0) {
        return fail(t('commands.msg.branding.needOne'))
      }

      $branding.set(await window.heraldOS.branding.set(patch))
      const lockNote = patch.lock && $env.get()?.platform !== 'linux'

      return ok(lockNote ? t('commands.msg.branding.updatedLockNote') : t('commands.msg.branding.updated'), { data: describe(), highlight: { kind: 'setting', id: 'about' } })
    }
  },
  {
    id: 'branding.reset',
    title: 'Reset the branding',
    description: 'Go back to the Herald logo, no name, and the themed lock screen (or reset just one of them).',
    tier: 'mutate',
    args: [{ name: 'what', type: 'string', description: 'all, logo, lock or name', enum: ['all', 'logo', 'lock', 'name'] }],
    run: async ({ what }) => {
      const part = String(what ?? 'all')
      const patch: BrandingPatch = part === 'all' ? { logo: null, lock: null, name: null } : { [part]: null }
      $branding.set(await window.heraldOS.branding.set(patch))

      const summary = part === 'all' ? t('commands.msg.branding.resetAll') : part === 'lock' ? t('commands.msg.branding.resetLock') : part === 'logo' ? t('commands.msg.branding.resetLogo') : t('commands.msg.branding.resetName')

      return ok(summary, { data: describe(), highlight: { kind: 'setting', id: 'about' } })
    }
  }
]
