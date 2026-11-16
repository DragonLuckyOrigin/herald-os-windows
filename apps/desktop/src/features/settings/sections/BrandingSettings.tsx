import { t, useT } from '../../../store/i18n.ts'
import { useStore } from '@nanostores/react'
import { IconId, IconLock, IconPhoto } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { HeraldLogo } from '../../../components/herald-logo.tsx'
import { GlassButton, GlassCard } from '../../../components/ui/glass.tsx'
import { $env } from '../../../store/backend.ts'
import { $branding } from '../../../store/branding.ts'
import { notify } from '../../../store/notifications.ts'
import { runCommand } from '../../../store/os-commands.ts'
import { markSaved, SettingsBlock, SettingsGroup, SettingsRow } from './shared.tsx'
import { desktopProductName } from '../../../lib/platform-labels.ts'

async function run(command: string, args: Record<string, unknown>) {
  const result = await runCommand(command, args, { source: 'ui' })

  if (result.ok) {
    markSaved()
  } else {
    notify({ title: t("settings.detail.couldNotChangeTheBranding.e61ed"), body: result.error ?? result.summary, level: 'error' })
  }
}

async function choose(kind: 'logo' | 'lock') {
  try {
    const [file] = await window.heraldOS.fs.pickFiles({ directory: false, multiple: false })

    if (file) {
      await run('branding.set', { [kind]: file })
    }
  } catch (error) {
    notify({ title: t("settings.detail.couldNotChooseThePicture.cfbd0"), body: error instanceof Error ? error.message : String(error), level: 'error' })
  }
}

/** The top of About: the Herald logo, or the logo and name the person set. */
export function AboutIdentity() {
  useT()
  const env = useStore($env)
  const branding = useStore($branding)

  return (
    <SettingsBlock label={desktopProductName(env?.platform)} description={branding.name ?? undefined} keywords="about logo branding version">
      <GlassCard className="flex items-center gap-4 p-5">
        {branding.logo ? <img src={branding.logo} alt={branding.name ? t("settings.detail.logo.eb0a6", { value1: branding.name }) : 'Logo'} className="h-12 max-w-[180px] object-contain" /> : <HeraldLogo height={28} />}
        <div className="min-w-0">
          {branding.name && <div className="truncate text-[15px] font-semibold text-fg">{branding.name}</div>}
          <div className={branding.name ? 'text-[12.5px] text-fg-3' : 'text-[15px] font-semibold text-fg'}>{desktopProductName(env?.platform)} {env?.version ?? ''}</div>
        </div>
      </GlassCard>
    </SettingsBlock>
  )
}

/** Settings > About > Branding: the logo, a name under it, and the lock-screen picture on Linux. */
export function BrandingSettings() {
  useT()
  const env = useStore($env)
  const branding = useStore($branding)
  const [name, setName] = useState(branding.name ?? '')

  useEffect(() => setName(branding.name ?? ''), [branding.name])

  const saveName = () => {
    if (name.trim() !== (branding.name ?? '')) {
      void run('branding.set', { name: name.trim() })
    }
  }

  return (
    <SettingsGroup title={t("settings.detail.branding.d417a")}>
      <SettingsRow icon={<IconPhoto />} label="Logo" description={branding.logo ? t("settings.detail.yoursShownAbove.dfa1f") : t("settings.detail.theHeraldLogoAPNGJPEGWebPOr.cff52")} keywords="branding logo company">
        {branding.logo && (
          <GlassButton size="sm" variant="ghost" onClick={() => void run('branding.reset', { what: 'logo' })}>
            {t("settings.detail.useTheHeraldLogo.22be2")}</GlassButton>
        )}
        <GlassButton size="sm" onClick={() => void choose('logo')}>
          {t("settings.detail.choose.7ca41")}</GlassButton>
      </SettingsRow>
      <SettingsRow icon={<IconId />} label="Name" description={t("settings.detail.shownUnderTheLogoSuchAsYourCompany.ae884")} keywords="branding name company organisation">
        <input
          value={name}
          onChange={event => setName(event.target.value)}
          onBlur={saveName}
          onKeyDown={event => event.key === 'Enter' && event.currentTarget.blur()}
          maxLength={40}
          placeholder={t("settings.detail.none.dc937")}
          aria-label={t("settings.detail.brandingName.f6d29")}
          className="glass-input h-8 w-[200px] rounded-lg px-2.5 text-[12.5px] outline-none"
        />
      </SettingsRow>
      {env?.platform === 'linux' && (
        <SettingsRow
          icon={<IconLock />}
          label={t("settings.detail.lockScreenPicture.38235")}
          description={branding.lock ? <span className="selectable">{branding.lock.split('/').pop()}</span> : t("settings.detail.theThemeColoursAPNGOrJPEGOf.db018")}
          keywords="branding lock screen wallpaper swaylock"
        >
          {branding.lock && (
            <GlassButton size="sm" variant="ghost" onClick={() => void run('branding.reset', { what: 'lock' })}>
              {t("settings.detail.useTheTheme.2e6cd")}</GlassButton>
          )}
          <GlassButton size="sm" onClick={() => void choose('lock')}>
            {t("settings.detail.choose.7ca41")}</GlassButton>
        </SettingsRow>
      )}
    </SettingsGroup>
  )
}
