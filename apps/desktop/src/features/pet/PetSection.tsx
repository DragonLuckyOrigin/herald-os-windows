import type { TextKey } from '../../../shared/i18n.ts'
import { useStore } from '@nanostores/react'
import {
  IconActivity,
  IconBattery1,
  IconBox,
  IconBrain,
  IconCheck,
  IconConfetti,
  IconDatabaseExclamation,
  IconDownload,
  IconEar,
  IconEyeOff,
  IconMoodSad,
  IconNote,
  IconPaw,
  IconResize,
  IconRun,
  IconWalk
} from '@tabler/icons-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { PET_DEFAULT_SCALE, type PetMoodKind, type PetNoteKind, type PetReaction } from '../../../shared/pet.ts'
import { GlassButton, Toggle } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { $connection, gatewayRequest } from '../../store/gateway.ts'
import { t, useT } from '../../store/i18n.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from '../settings/sections/shared.tsx'
import { $petPrefs, petShortcutLabel, selectPet, setPetEnabled, setPetPrefs, setPetScale } from './actions.ts'
import { $petInfo } from './info.ts'

/*
 * Settings > Pet. On or off, which pet and its size are Hermes's `display.pet`, so they change for
 * every Hermes surface; the rest is Herald's. The petdex gallery loads only when the person asks for
 * it, because it reaches petdex.dev.
 */

const REACTIONS: { key: PetReaction; label: TextKey; description: TextKey; icon: ReactNode }[] = [
  { key: 'thinking', label: "settings.detail.thinking.a20d1", description: "settings.detail.readsAlongWhileHermesThinks.533f8", icon: <IconBrain /> },
  { key: 'running', label: "settings.detail.running.f4cca", description: "settings.detail.runsWhileAToolRuns.1af4a", icon: <IconRun /> },
  { key: 'cheering', label: "settings.detail.cheering.5d4f3", description: "settings.detail.jumpsWhenATurnOrATaskFinishes.2a71a", icon: <IconConfetti /> },
  { key: 'drooping', label: "settings.detail.drooping.373a2", description: "settings.detail.droopsWhenSomethingGoesWrong.066a6", icon: <IconMoodSad /> },
  { key: 'listening', label: "settings.detail.listening.49c46", description: "settings.detail.perksUpWhenTheWakeWordHearsYou.31d65", icon: <IconEar /> }
]

const MOODS: { key: PetMoodKind; label: TextKey; description: TextKey; icon: ReactNode }[] = [
  { key: 'disk', label: "settings.detail.diskNearlyFull.02d2f", description: "settings.detail.looksWorriedWhenTheDiskHasLittleRoom.781a7", icon: <IconDatabaseExclamation /> },
  { key: 'battery', label: "settings.detail.batteryLow.8cf92", description: "settings.detail.looksWorriedWhenTheBatteryRunsLowAnd.c56c5", icon: <IconBattery1 /> }
]

const NOTES: { key: PetNoteKind; label: TextKey; description: TextKey; icon: ReactNode }[] = [
  { key: 'update', label: "settings.detail.updateReady.46570", description: "settings.detail.carriesABoxWhenAnUpdateIsReady.875de", icon: <IconBox /> },
  { key: 'job', label: "settings.detail.longJobFinished.57891", description: "settings.detail.bringsANoteWhenSomethingHermesWorkedOn.61c41", icon: <IconNote /> }
]

interface GalleryPet {
  slug: string
  displayName: string
  installed: boolean
  spritesheetUrl?: string
}

const thumbs = new Map<string, Promise<string | null>>()

/** The pet's first idle frame from Hermes (a not-installed one is fetched from petdex for it). */
function thumbFor(slug: string, url?: string): Promise<string | null> {
  const key = `${slug}|${url ?? ''}`
  let pending = thumbs.get(key)

  if (!pending) {
    // A failed request (Hermes still starting) is not kept, so the next look asks again.
    pending = gatewayRequest('pet.thumb', url ? { slug, url } : { slug })
      .then(result => (result.ok && result.dataUri ? result.dataUri : null))
      .catch(() => null)
      .then(value => {
        if (!value) {
          thumbs.delete(key)
        }

        return value
      })
    thumbs.set(key, pending)
  }

  return pending
}

function PetThumb({ slug, url, lazy }: { slug: string; url?: string; lazy?: boolean }) {
  useT()
  const connection = useStore($connection)
  const [src, setSrc] = useState<string | null>(null)
  const [near, setNear] = useState(!lazy)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (near || !ref.current) {
      return
    }

    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setNear(true)
        observer.disconnect()
      }
    })
    observer.observe(ref.current)

    return () => observer.disconnect()
  }, [near])

  useEffect(() => {
    let live = true

    if (near && connection === 'open') {
      void thumbFor(slug, url).then(value => live && setSrc(value))
    }

    return () => {
      live = false
    }
  }, [slug, url, near, connection])

  return (
    <div ref={ref} className="flex size-14 items-center justify-center overflow-hidden rounded-lg bg-white/6">
      {src ? <img src={src} alt="" className="max-h-full max-w-full object-contain" /> : <IconPaw size={18} className="text-fg-4" />}
    </div>
  )
}

export function PetCard({ slug, name, url, selected, busy, action, onPick, lazy }: { slug: string; name: string; url?: string; selected?: boolean; busy?: boolean; action: 'use' | 'install'; onPick: () => void; lazy?: boolean }) {
  useT()
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={busy || selected}
      aria-pressed={selected}
      aria-label={t(action === 'install' ? 'settings.pet.installName' : 'settings.pet.useName', { name })}
      className={cn('glass-card glass-card-hover flex w-[104px] flex-col items-center gap-1.5 rounded-xl p-2 text-center disabled:cursor-default', selected && 'glass-card-selected')}
    >
      <PetThumb slug={slug} url={url} lazy={lazy} />
      <span className="w-full truncate text-[12px] text-fg">{name}</span>
      <span className="flex items-center gap-1 text-[11px] text-fg-3">
        {selected ? <IconCheck size={12} className="text-ok" /> : busy ? null : action === 'install' ? <IconDownload size={12} /> : null}
        {selected ? t("settings.detail.inUse.750af") : busy ? t("settings.detail.working.5474e") : t(action === 'install' ? 'settings.common.install' : 'settings.common.use')}
      </span>
    </button>
  )
}

const PAGE = 12

function Gallery({ active, onPicked }: { active: string | null; onPicked: (error: string | null) => void }) {
  useT()
  const [pets, setPets] = useState<GalleryPet[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<{ kind: 'empty' } | { kind: 'error'; message: string } | null>(null)
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [installing, setInstalling] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setProblem(null)
    gatewayRequest('pet.gallery', {})
      .then(result => {
        const list = (result.pets ?? []).map(pet => ({ slug: pet.slug, displayName: pet.displayName, installed: pet.installed, spritesheetUrl: pet.spritesheetUrl }))
        setPets(list)

        if (!list.some(pet => !pet.installed)) {
          setProblem({ kind: 'empty' })
        }
      })
      .catch(reason => setProblem({ kind: 'error', message: errorText(reason) }))
      .finally(() => setLoading(false))
  }

  const install = (pet: GalleryPet) => {
    setInstalling(pet.slug)
    selectPet(pet.slug)
      .then(
        () => {
          setPets(current => current?.map(entry => (entry.slug === pet.slug ? { ...entry, installed: true } : entry)) ?? null)
          markSaved()
          onPicked(null)
        },
        reason => onPicked(errorText(reason))
      )
      .finally(() => setInstalling(null))
  }

  if (!pets) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-[12px] text-fg-3">{t("settings.detail.theGalleryLivesAtPetdexdevBrowsingItAnd.aa22d")}</div>
        <div>
          <GlassButton size="sm" onClick={load} disabled={loading}>
            {loading ? t("settings.detail.loadingTheGallery.db6db") : t("settings.detail.browseThePetdexGallery.a3cd8")}
          </GlassButton>
        </div>
        {problem && <InlineNote tone="danger">{problem.kind === 'empty' ? t('settings.detail.thePetdexGalleryDidNotAnswerCheckThe.0cd21') : problem.message}</InlineNote>}
      </div>
    )
  }

  const needle = query.trim().toLowerCase()
  const matching = pets.filter(pet => !needle || pet.displayName.toLowerCase().includes(needle) || pet.slug.includes(needle))

  return (
    <div className="flex flex-col gap-2.5">
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t("settings.detail.searchTheGallery.914c2")} aria-label={t("settings.detail.searchTheGallery.914c2")} className="glass-input h-8 w-64 rounded-lg px-2.5 text-[12.5px] outline-none" />
      {problem && <InlineNote tone="warn">{problem.kind === 'empty' ? t('settings.detail.thePetdexGalleryDidNotAnswerCheckThe.0cd21') : problem.message}</InlineNote>}
      <div className="flex flex-wrap gap-2">
        {matching.slice(0, shown).map(pet => (
          <PetCard
            key={pet.slug}
            slug={pet.slug}
            name={pet.displayName}
            url={pet.installed ? undefined : pet.spritesheetUrl}
            selected={pet.slug === active}
            busy={installing === pet.slug}
            action={pet.installed ? 'use' : 'install'}
            onPick={() => install(pet)}
            lazy
          />
        ))}
      </div>
      {matching.length > shown && (
        <div>
          <GlassButton size="sm" variant="ghost" onClick={() => setShown(count => count + PAGE)}>
            {t("settings.detail.showMore.1ce7c")}{matching.length - shown})
          </GlassButton>
        </div>
      )}
    </div>
  )
}

function useScaleDraft(scale: number, commit: (value: number) => void): [number, (value: number) => void] {
  const [draft, setDraft] = useState(scale)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => setDraft(scale), [scale])

  const change = (value: number) => {
    setDraft(value)

    if (timer.current) {
      clearTimeout(timer.current)
    }

    timer.current = setTimeout(() => commit(value), 450)
  }

  return [draft, change]
}

export function PetSection() {
  const t = useT()
  const info = useStore($petInfo)
  const prefs = useStore($petPrefs)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const on = info.enabled && Boolean(info.slug)

  const run = (key: string, work: Promise<unknown>) => {
    setBusy(key)
    setError(null)
    work.then(
      () => markSaved(),
      reason => setError(errorText(reason))
    ).finally(() => setBusy(null))
  }

  const [scale, setScale] = useScaleDraft(info.scale, value => run('scale', setPetScale(value)))
  const toggles = <K extends string>(group: 'reactions' | 'moods' | 'notes', rows: { key: K; label: TextKey; description: TextKey; icon: ReactNode }[]) =>
    rows.map(row => {
      const current = prefs[group] as Record<K, boolean>

      return (
        <SettingsRow key={row.key} icon={row.icon} label={t(row.label)} description={t(row.description)} keywords={`pet ${group}`}>
          <Toggle checked={current[row.key]} onChange={next => run(`${group}.${row.key}`, setPetPrefs({ [group]: { ...current, [row.key]: next } }))} label={t(row.label)} />
        </SettingsRow>
      )
    })

  return (
    <>
      <SectionTitle title={t('settings.section.pet')} subtitle={t('settings.pet.subtitle')} />

      <SettingsGroup title={t("settings.detail.thePet.d43b7")}>
        <SettingsRow
          icon={<IconPaw />}
          label={t("settings.detail.showThePet.124ee")}
          description={info.installed.length ? (on ? t("settings.detail.isOnForEveryHermesSurface.06fc8", { value1: info.displayName ?? info.slug ?? '' }) : t("settings.detail.offForEveryHermesSurface.d118c")) : t("settings.detail.noPetIsInstalledYetPickOneFrom.09a05")}
          keywords="pet mascot petdex on off display.pet"
          below={error ? <InlineNote tone="danger">{error}</InlineNote> : undefined}
        >
          <Toggle checked={on} disabled={!info.installed.length || busy === 'enabled'} onChange={next => run('enabled', setPetEnabled(next))} label={t("settings.detail.showThePet.124ee")} />
        </SettingsRow>
        {info.installed.length > 0 && (
          <SettingsRow
            icon={<IconActivity />}
            label={t("settings.detail.whichPet.74b02")}
            description={t("settings.detail.theInstalledPetsTheOneYouPickShows.facb7")}
            keywords="pet choose select installed"
            below={
              <div className="flex flex-wrap gap-2">
                {info.installed.map(pet => (
                  <PetCard key={pet.slug} slug={pet.slug} name={pet.displayName} selected={on && pet.slug === info.slug} busy={busy === `select.${pet.slug}`} action="use" onPick={() => run(`select.${pet.slug}`, selectPet(pet.slug))} />
                ))}
              </div>
            }
          />
        )}
        <SettingsRow icon={<IconResize />} label={t("settings.detail.size.1af85")} description={t("settings.detail.thePetsSizeEverywhereHermesShowsItHermes.97184", { value1: Math.round(PET_DEFAULT_SCALE * 100) })} keywords="pet scale size bigger smaller">
          <input type="range" min={0.15} max={1.2} step={0.01} value={scale} disabled={!info.installed.length} aria-label={t("settings.detail.petSize.8458a")} onChange={event => setScale(Number(event.target.value))} className="w-40 accent-accent" />
          <span className="w-10 text-right text-[12px] text-fg-3 tabular-nums">{Math.round(scale * 100)}%</span>
        </SettingsRow>
        <SettingsRow icon={<IconEyeOff />} label={t("settings.detail.putAwayForNow.6dd1c")} description={t("settings.detail.forAScreenShareOrThePawIn.8c954", { value1: petShortcutLabel() })} keywords="pet hide screen share">
          <Toggle checked={prefs.hidden} onChange={next => run('hidden', setPetPrefs({ hidden: next }))} label={t("settings.detail.putAwayForNow.6dd1c")} />
        </SettingsRow>
        <SettingsRow icon={<IconWalk />} label={t("settings.detail.walkToHermessWork.a187c")} description={t("settings.detail.sitsByTheHeraldDocsSheetsSlidesOr.2f3c6")} keywords="pet follow windows office canvas">
          <Toggle checked={prefs.followWindows} onChange={next => run('follow', setPetPrefs({ followWindows: next }))} label={t("settings.detail.walkToHermessWork.a187c")} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.detail.reactions.8a7ed")}>{toggles('reactions', REACTIONS)}</SettingsGroup>

      <SettingsGroup title={t("settings.detail.moodsAndNotes.e60de")}>{[...toggles('moods', MOODS), ...toggles('notes', NOTES)]}</SettingsGroup>

      <SettingsGroup title={t("settings.detail.petdexGallery.af185")}>
        <SettingsRow label={t("settings.detail.findAPet.b1d79")} description={t("settings.detail.installAPetFromThePublicPetdexGallery.0f61f")} keywords="pet gallery petdex install browse" below={<Gallery active={on ? info.slug : null} onPicked={setError} />} />
      </SettingsGroup>
    </>
  )
}
