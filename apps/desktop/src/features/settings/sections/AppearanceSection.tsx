import type { TextKey } from '../../../../shared/i18n.ts'
import { useStore } from '@nanostores/react'
import { IconBrandGit, IconCode, IconDroplet, IconLayoutBottombar, IconPhoto, IconSparkles, IconTypography, IconWand } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { ThemeSummary } from '../../../../shared/theme.ts'
import { GlassButton, GlassCard, Toggle } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { $themes, applyTheme, generateTheme, installThemes, loadThemes } from '../../../store/themes.ts'
import { MenuBarSettings } from './MenuBarSettings.tsx'
import { t, useT } from '../../../store/i18n.ts'
import { errorText, Filterable, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

const ACCENTS: { id: 'blue' | 'ice' | 'violet'; label: TextKey; color: string }[] = [
  { id: 'blue', label: "settings.detail.blue.ec7d5", color: '#2f7dff' },
  { id: 'ice', label: "settings.detail.ice.2a1a6", color: '#4cc2ff' },
  { id: 'violet', label: "settings.detail.violet.2a364", color: '#7c6cff' }
]

export function AppearanceSection() {
  const t = useT()
  const prefs = useStore($prefs)

  const save = async (patch: Parameters<typeof updatePrefs>[0]) => {
    try {
      await updatePrefs(patch)
      markSaved()
    } catch (error) {
      notify({ title: t("settings.detail.couldNotSaveSetting.e2354"), body: errorText(error), level: 'error' })
    }
  }

  const chooseWallpaper = async () => {
    try {
      const [path] = await window.heraldOS.fs.pickFiles({ directory: false, multiple: false })

      if (path) {
        await save({ wallpaper: `file://${path}` })
      }
    } catch (error) {
      notify({ title: t("settings.detail.couldNotChooseWallpaper.4dc18"), body: errorText(error), level: 'error' })
    }
  }

  const wallpaperName = prefs.wallpaper ? decodeURIComponent(prefs.wallpaper.replace(/^file:\/\//, '')).split('/').pop() : null

  return (
    <>
      <SectionTitle title={t('settings.section.appearance')} subtitle={t('settings.appearance.subtitle')} />

      <ThemeGallery />
      <ThemeTools />

      <SettingsGroup title={t("settings.detail.look.a0de5")}>
        <SettingsRow icon={<IconDroplet />} label={t("settings.detail.accent.a5c6f")} description={t("settings.detail.theAccentColourOfTheOceanAndGraphite.59d62")} keywords="colour color highlight">
          <div className="flex items-center gap-2" role="radiogroup" aria-label={t("settings.detail.accentColour.12376")}>
            {ACCENTS.map(accent => {
              const active = prefs.accent === accent.id

              return (
                <button
                  key={accent.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={t(accent.label)}
                  onClick={() => void save({ accent: accent.id })}
                  className={cn('size-6 rounded-full border border-white/30 transition-transform', active ? 'scale-110 shadow-[0_0_0_2px_var(--color-bg),0_0_0_3.5px_var(--color-fg-3)]' : 'opacity-75 hover:opacity-100')}
                  style={{ background: accent.color }}
                />
              )
            })}
          </div>
        </SettingsRow>
        <SettingsRow icon={<IconPhoto />} label={t("settings.detail.wallpaper.a7f17")} description={wallpaperName ? <span className="selectable">{wallpaperName}</span> : t("settings.detail.theLivingHermesWallpaper.33268")} keywords="background image desktop">
          {prefs.wallpaper && (
            <GlassButton size="sm" variant="ghost" onClick={() => void save({ wallpaper: '' })} aria-label={t("settings.detail.useHermesWallpaper.fafa5")}>
              {t("settings.detail.useHermesWallpaper.fafa5")}</GlassButton>
          )}
          <GlassButton size="sm" onClick={() => void chooseWallpaper()} aria-label={t("settings.detail.chooseWallpaperImage.2e432")}>
            {t("settings.detail.chooseImage.44ce6")}</GlassButton>
        </SettingsRow>
      </SettingsGroup>

      <FontSettings />

      <MenuBarSettings />

      <SettingsGroup title="Dock">
        <SettingsRow icon={<IconLayoutBottombar />} label={t("settings.detail.automaticallyHideTheDock.97e50")} description={t("settings.detail.theDockSlidesAwayAndReturnsWhenThe.6b597")} keywords="dock autohide hide show">
          <Toggle checked={prefs.dockAutoHide !== false} onChange={next => void save({ dockAutoHide: next })} label={t("settings.detail.automaticallyHideTheDock.97e50")} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.detail.motion.8ca34")}>
        <SettingsRow icon={<IconSparkles />} label={t("settings.detail.reduceMotion.297ef")} description={t("settings.detail.collapseNonessentialAnimationAcrossTheShell.16e3c")} keywords="animation accessibility">
          <Toggle checked={prefs.reduceMotion} onChange={next => void save({ reduceMotion: next })} label={t("settings.detail.reduceMotion.297ef")} />
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

/** Every installed theme as a card of its own colours; choosing one restyles the whole environment. */
function ThemeGallery() {
  useT()
  const themes = useStore($themes)
  const prefs = useStore($prefs)
  const current = prefs.themeName ?? `herald-${prefs.theme}`
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void loadThemes()
  }, [])

  const choose = async (theme: ThemeSummary) => {
    setBusy(theme.name)

    try {
      await applyTheme(theme.name)
      markSaved()
    } catch (error) {
      notify({ title: t("settings.detail.couldNotApply.6f1d4", { value1: theme.label }), body: errorText(error), level: 'error' })
    } finally {
      setBusy(null)
    }
  }

  if (themes.length === 0) {
    return null
  }

  return (
    <Filterable label={t("settings.detail.theme.efb52")} description={t("settings.detail.chooseATheme.fb92a")} keywords="theme dark light colour color look">
      <section className="flex flex-col gap-1.5">
        <h3 className="px-0.5 text-[12.5px] font-medium text-fg-2">{t("settings.detail.theme.efb52")}</h3>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5" role="radiogroup" aria-label={t("settings.detail.theme.efb52")}>
          {themes.map(theme => {
            const active = theme.name === current

            return (
              <GlassCard
                key={theme.name}
                as="button"
                interactive
                selected={active}
                role="radio"
                aria-checked={active}
                aria-label={theme.label}
                data-os-target={`theme:${theme.name}`}
                onClick={() => void choose(theme)}
                className={cn('flex flex-col gap-2 p-2.5 text-left', busy === theme.name && 'opacity-60')}
              >
                <span className="flex h-12 overflow-hidden rounded-md border border-line" style={{ background: theme.colors.bg }} aria-hidden="true">
                  <span className="m-1.5 flex-1 rounded-sm" style={{ background: theme.colors.surface }}>
                    <span className="mx-1.5 mt-1.5 block h-1.5 w-8 rounded-full" style={{ background: theme.colors.fg }} />
                    <span className="mx-1.5 mt-1 block h-1.5 w-12 rounded-full" style={{ background: theme.colors.fg_dim }} />
                  </span>
                  <span className="my-1.5 mr-1.5 w-4 rounded-sm" style={{ background: theme.colors.accent }} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-fg">{theme.label}</span>
                  <span className="block truncate text-[11px] text-fg-3">
                    {t(theme.scheme === 'light' ? 'settings.common.light' : 'settings.common.dark')}
                    {theme.source === 'user' ? t('settings.appearance.yours') : ''}
                  </span>
                </span>
              </GlassCard>
            )
          })}
        </div>
      </section>
    </Filterable>
  )
}

function ThemeTools() {
  useT()
  const prefs = useStore($prefs)
  const [repo, setRepo] = useState('')
  const [working, setWorking] = useState<'generate' | 'install' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const make = async (image?: string) => {
    setError(null)

    try {
      const source = image ?? (await window.heraldOS.fs.pickFiles({ directory: false, multiple: false }))[0]

      if (!source) {
        return
      }

      setWorking('generate')
      const name = await generateTheme({ image: source })
      markSaved()
      notify({ title: t("settings.detail.newTheme.56ce1"), body: t("settings.detail.isReadyAndInUse.9d98f", { value1: $themes.get().find(theme => theme.name === name)?.label ?? name }), level: 'success' })
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setWorking(null)
    }
  }

  const install = async () => {
    setError(null)
    setWorking('install')

    try {
      const names = await installThemes(repo.trim())
      setRepo('')
      notify({ title: t("settings.detail.themesInstalled.9e94f"), body: names.join(', '), level: 'success' })
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setWorking(null)
    }
  }

  return (
    <SettingsGroup title={t("settings.detail.makeItYours.34ca8")}>
      <SettingsRow
        icon={<IconWand />}
        label={t("settings.detail.makeAThemeFromAnImage.4dc9a")}
        description={t("settings.detail.heraldOSTakesTheColoursOfAPhoto.a7581")}
        keywords="generate create custom wallpaper colours"
        below={error ? <InlineNote tone="danger">{error}</InlineNote> : undefined}
      >
        {prefs.wallpaper && (
          <GlassButton size="sm" variant="ghost" disabled={working !== null} onClick={() => void make(prefs.wallpaper)}>
            {t("settings.detail.fromTheWallpaper.c7ed4")}</GlassButton>
        )}
        <GlassButton size="sm" disabled={working !== null} onClick={() => void make()}>
          {working === 'generate' ? t("settings.detail.making.398c8") : t("settings.detail.chooseImage.44ce6")}
        </GlassButton>
      </SettingsRow>
      <SettingsRow icon={<IconBrandGit />} label={t("settings.detail.installThemesFromGit.02d4f")} description={t("settings.detail.pasteTheHttpsAddressOfAThemeRepository.9d926")} keywords="download share community">
        <input
          value={repo}
          onChange={event => setRepo(event.target.value)}
          onKeyDown={event => event.key === 'Enter' && repo.trim() && void install()}
          placeholder="https://github.com/…"
          aria-label={t("settings.detail.themeRepositoryAddress.25e33")}
          className="glass-input h-8 w-56 rounded-lg px-2.5 text-[12.5px] outline-none placeholder:text-fg-4"
        />
        <GlassButton size="sm" disabled={!repo.trim() || working !== null} onClick={() => void install()}>
          {working === 'install' ? t("settings.detail.installing.530bc") : t('settings.common.install')}
        </GlassButton>
      </SettingsRow>
      <SettingsRow icon={<IconSparkles />} label={t("settings.detail.followHermesSkins.8a182")} description={t("settings.detail.whenYouChangeHermessSkinWithSkinHerald.2272f")} keywords="skin hermes cli tui sync">
        <Toggle
          checked={Boolean(prefs.followHermesSkin)}
          onChange={next => {
            void updatePrefs({ followHermesSkin: next }).then(markSaved)
          }}
          label={t("settings.detail.followHermesSkins.8a182")}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}

function FontSettings() {
  useT()
  const prefs = useStore($prefs)
  const [families, setFamilies] = useState<string[]>([])

  const loadFamilies = () => {
    if (families.length === 0) {
      void window.heraldOS.fonts
        .list()
        .then(setFamilies)
        .catch(() => undefined)
    }
  }

  const set = (kind: 'ui' | 'mono', value: string) => {
    void updatePrefs({ fonts: { ...prefs.fonts, [kind]: value.trim() || undefined } }).then(markSaved)
  }

  const field = (kind: 'ui' | 'mono', label: string) => (
    <input
      key={`${kind}:${prefs.fonts?.[kind] ?? ''}`}
      defaultValue={prefs.fonts?.[kind] ?? ''}
      list="herald-font-families"
      onFocus={loadFamilies}
      onBlur={event => event.target.value.trim() !== (prefs.fonts?.[kind] ?? '') && set(kind, event.target.value)}
      onKeyDown={event => event.key === 'Enter' && event.currentTarget.blur()}
      placeholder={t("settings.detail.default.21b11")}
      aria-label={label}
      className="glass-input h-8 w-52 rounded-lg px-2.5 text-[12.5px] outline-none placeholder:text-fg-4"
    />
  )

  return (
    <SettingsGroup title={t("settings.detail.fonts.3680f")}>
      <datalist id="herald-font-families">
        {families.map(family => (
          <option key={family} value={family} />
        ))}
      </datalist>
      <SettingsRow icon={<IconTypography />} label={t("settings.detail.interfaceFont.ad55b")} description={t("settings.detail.leaveEmptyForTheSystemFont.c31b1")} keywords="font typeface text">
        {field('ui', t("settings.detail.interfaceFont.ad55b"))}
      </SettingsRow>
      <SettingsRow icon={<IconCode />} label={t("settings.detail.codeFont.5bb76")} description={t("settings.detail.usedByTheTerminalAndCodeViews.4ab6d")} keywords="font monospace terminal code">
        {field('mono', t("settings.detail.codeFont.5bb76"))}
      </SettingsRow>
    </SettingsGroup>
  )
}
