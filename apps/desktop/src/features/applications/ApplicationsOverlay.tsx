import { t as uiT, useT as useUiT, $language as $uiLanguage } from '../../store/i18n.ts'
import { IconApps, IconX } from '@tabler/icons-react'
import { type KeyboardEvent, useCallback, useMemo, useRef, useState } from 'react'
import { HermesAvatar } from '../../components/app-icon.tsx'
import { EmptyGlass, GlassButton, SearchField, Tabs } from '../../components/ui/glass.tsx'
import { MicButton } from '../voice/MicButton.tsx'
import { Kbd } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { shortcutLabel } from '../../lib/platform-labels.ts'
import { sendPrompt } from '../../store/chat.ts'
import { useNativeApps } from '../../store/native-apps.ts'
import { notify } from '../../store/notifications.ts'
import { openSurface, relayToMain } from '../../store/shell.ts'
import { $applicationsOpen } from '../../store/surface.ts'
import { openApp, showPage } from '../../store/windows.ts'
import { AppTileButton } from './AppTileButton.tsx'
import { LAUNCHER_FILTERS, type LauncherFilter, type LauncherTile, buildCatalog, filterTiles } from './app-catalog.ts'

const COLUMNS = 6
const ARROWS: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }
const HERMES_SUFFIX = '. If this needs an application, open the right one for me with system_open.'

/**
 * The Applications launcher: a modal over the desktop listing Hermes apps first, then every installed
 * macOS app. Search filters the grid, arrows move a focus ring, Enter opens; anything Hermes cannot
 * match becomes a prompt to Hermes instead.
 */
export function ApplicationsOverlay() {
  useUiT()
  const close = useCallback(() => $applicationsOpen.set(false), [$uiLanguage.get(), ])

  return (
    <div className="absolute inset-0 z-(--z-overlay) flex items-center justify-center bg-black/35 backdrop-blur-[3px] animate-fade-in" onMouseDown={close}>
      <ApplicationsPanel onClose={close} className="max-h-[80vh] w-[760px] animate-pop" />
    </div>
  )
}

export interface ApplicationsPanelProps {
  onClose: () => void
  /** Standalone: hosted in its own window (panels mode); prompts are relayed to the Hermes window. */
  standalone?: boolean
  /** Sizing classes; the desktop overlay uses a fixed 760px dialog, the panels overlay fills its window. */
  className?: string
}

/** The launcher dialog without its backdrop: shared by the desktop overlay and the panels-mode command window. */
export function ApplicationsPanel({ onClose, standalone = false, className }: ApplicationsPanelProps) {
  useUiT()
  const { apps, iconFor } = useNativeApps()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<LauncherFilter>('all')
  const [ask, setAsk] = useState('')
  const [active, setActive] = useState(-1)
  const searchWrapRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)

  const catalog = useMemo(() => buildCatalog(apps), [$uiLanguage.get(), apps])
  const tiles = useMemo(() => filterTiles(catalog, filter, query), [$uiLanguage.get(), catalog, filter, query])
  const trimmed = query.trim()

  // Reset the roving ring whenever the visible set changes: first result while searching, none otherwise.
  const scope = `${filter}\u0000${trimmed}`
  const [prevScope, setPrevScope] = useState(scope)

  if (scope !== prevScope) {
    setPrevScope(scope)
    setActive(trimmed ? 0 : -1)
  }

  const close = onClose

  const askHermes = useCallback(
    (text: string) => {
      const prompt = text.trim()

      if (!prompt) {
        return
      }

      close()

      if (standalone) {
        relayToMain({ type: 'send-prompt', text: `${prompt}${HERMES_SUFFIX}` })
        openSurface('main')

        return
      }

      showPage('hermes')
      void sendPrompt(`${prompt}${HERMES_SUFFIX}`)
    },
    [$uiLanguage.get(), close, standalone]
  )

  const activate = useCallback(
    (tile: LauncherTile) => {
      if (tile.kind === 'hermes') {
        openApp(tile.appId)
        close()

        return
      }

      window.heraldOS.apps.launch(tile.app.path).catch((error: unknown) => {
        notify({ title: uiT("ui.3dfa67f3fd0e", { value1: String(tile.label) }), body: error instanceof Error ? error.message : String(error), level: 'error' })
      })
      close()
    },
    [$uiLanguage.get(), close]
  )

  const submitSearch = () => {
    const target = active >= 0 ? tiles[active] : trimmed ? tiles[0] : undefined

    if (target) {
      activate(target)
    } else if (trimmed) {
      askHermes(trimmed)
    }
  }

  const focusSearch = () => searchWrapRef.current?.querySelector('input')?.focus()

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()

      return
    }

    const target = event.target as HTMLElement

    // The footer prompt and the category tabs own their own keys.
    if (footerRef.current?.contains(target) || target.closest('[role="tablist"]')) {
      return
    }

    const step = ARROWS[event.key]

    if (step !== undefined) {
      if (tiles.length > 0) {
        event.preventDefault()
        setActive(current => (current < 0 ? 0 : Math.max(0, Math.min(tiles.length - 1, current + step))))
      }

      return
    }

    // Typing anywhere else in the panel lands in the search field.
    const editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    const printable = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey

    if (printable && !editable) {
      focusSearch()
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={uiT("ui.98e33b0f3104")} className={cn('float flex flex-col overflow-hidden rounded-2xl', className)} onMouseDown={event => event.stopPropagation()} onKeyDown={onKeyDown}>
      <div className="flex items-center justify-between gap-4 px-7 pt-6 pb-4">
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-fg">{uiT("ui.98e33b0f3104")}</h1>
        <button type="button" aria-label={uiT("ui.4e4ed689cecb")} onClick={close} className="flex size-8 items-center justify-center rounded-lg text-fg-3 transition-colors duration-150 hover:bg-white/8 hover:text-fg">
          <IconX size={18} />
        </button>
      </div>

      <div ref={searchWrapRef} className="px-7">
        <SearchField autoFocus value={query} onChange={setQuery} onSubmit={submitSearch} placeholder={uiT("ui.6c5188dbdcae")} trailing={<Kbd>{shortcutLabel('K')}</Kbd>} className="h-10" />
      </div>

      <div className="px-7 pt-3 pb-3">
        <Tabs tabs={LAUNCHER_FILTERS} value={filter} onChange={setFilter} />
      </div>
      <div className="mx-7 h-px bg-line" />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {tiles.length > 0 ? (
          <div className="stagger grid grid-cols-6 gap-3" aria-label={uiT("ui.98e33b0f3104")}>
            {tiles.map((tile, index) => (
              <AppTileButton key={tile.key} tile={tile} index={index} active={index === active} iconFor={iconFor} onActivate={activate} />
            ))}
          </div>
        ) : (
          <EmptyGlass
            icon={<IconApps />}
            title={trimmed ? uiT("ui.901dce1c7233", { value1: String(trimmed) }) : uiT("ui.96b0549aaaae")}
            description={trimmed ? uiT("ui.82f97ca570a3") : undefined}
            action={
              trimmed ? (
                <GlassButton size="sm" variant="primary" onClick={() => askHermes(trimmed)}>
                  {uiT("ui.6ab81d364dd7")}</GlassButton>
              ) : undefined
            }
          />
        )}
      </div>

      <div className="mx-7 h-px bg-line" />
      <div ref={footerRef} className="px-5 py-4">
        <label className="glass-input flex h-12 items-center gap-3 rounded-lg px-3">
          <HermesAvatar size={28} rounded={8} />
          <input
            value={ask}
            onChange={event => setAsk(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                askHermes(ask)
              }
            }}
            placeholder={uiT("ui.587b88bf0fd3")}
            aria-label={uiT("ui.20f854c4301c")}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4"
          />
          <MicButton size={18} className="size-8" />
        </label>
      </div>
    </div>
  )
}
