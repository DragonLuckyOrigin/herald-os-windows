import { t as uiT } from '../../../../store/i18n.ts'
import type { OfficeCommand } from '../../shell/commands.ts'
import { type SlideTransition, type Theme, TRANSITIONS } from '../deck.ts'
import { showPresenterView, startPresenting } from '../Present.tsx'
import { $presentation, slidesSession } from '../store.ts'
import { $customThemes } from '../theme-store.ts'
import { THEMES } from '../themes.ts'
import { DIRECTIONS } from '../transitions.ts'
import { flushTyping } from './active.ts'
import * as commands from './commands.ts'
import {
  applyThemeTo,
  backgroundGraphicsHidden,
  isCustomTheme,
  layoutInFront,
  ofKind,
  openHeaderFooter,
  openThemeEditor,
  setPickedTransition,
  showMasterView,
  themeInUse,
  type ThemeScope,
  toggleBackgroundGraphics,
  transitionInFront,
  transitionToAll
} from './master-commands.ts'

const TRANSITION_LABELS = {"none":"slides.transition.none","fade":"slides.transition.fade","push":"slides.transition.push","wipe":"slides.transition.wipe","cover":"slides.transition.cover","uncover":"slides.transition.uncover","split":"slides.transition.split","zoom":"slides.transition.zoom"} as const
const DIRECTION_LABELS = {"left":"slides.direction.left","right":"slides.direction.right","up":"slides.direction.up","down":"slides.direction.down","in":"slides.direction.in","out":"slides.direction.out"} as const

/*
 * Menu items for the master view, themes, header and footer, background graphics, transitions and
 * presenting. Work on the deck's slides waits while the master view is open, and the master view
 * waits while the deck is presented. The menus open one submenu deep, so each submenu here is a
 * list of choices.
 */

const live = () => commands.live()

const hasDeck = () => Boolean(live())

const onSlides = () => live()?.mode === 'slides'

const presenting = () => $presentation.get() !== null

/** View: the slide master view, on or off. */
export function masterViewCommands(): OfficeCommand[] {
  return [{ id: 'slide-master', label: uiT("ui.fab9b6dad830"), enabled: () => hasDeck() && !presenting(), checked: () => live()?.mode === 'master', run: () => showMasterView(live()?.mode !== 'master'), dividerBefore: true }]
}

/** The themes to pick from: the deck's own when it is neither built in nor custom (one from a file), the built-in ones, then the custom ones. */
function themeItems(scope: ThemeScope): OfficeCommand[] {
  const custom = $customThemes.get()
  const own = live()?.presentation.theme
  const known = (theme: Theme) => THEMES.some((entry) => entry.id === theme.id) || custom.some((entry) => entry.id === theme.id)
  const groups = [own && !known(own) ? [own] : [], [...THEMES], [...custom]].filter((group) => group.length)

  return groups.flatMap((group, at) =>
    group.map((theme, index) => ({
      id: `theme-${scope}-${theme.id}`,
      label: theme.id === 'imported' ? `${theme.name} (from the file)` : theme.name,
      checked: () => themeInUse(scope)?.id === theme.id,
      run: () => applyThemeTo(theme, scope),
      dividerBefore: at > 0 && index === 0
    }))
  )
}

/** Slide: a theme for every slide or for the picked ones, and new and edited custom themes. */
export function themeCommands(): OfficeCommand[] {
  return [
    {
      id: 'theme',
      label: uiT("ui.efb52e7172b7"),
      enabled: hasDeck,
      run: () => {},
      dividerBefore: true,
      // Read each time the menu opens, as custom themes come and go.
      get submenu() {
        return themeItems('all')
      }
    },
    {
      id: 'theme-selected',
      label: uiT("ui.445d22e534f0"),
      enabled: onSlides,
      run: () => {},
      get submenu() {
        return themeItems('selected')
      }
    },
    { id: 'theme-new', label: uiT("ui.342e3b987bff"), enabled: hasDeck, run: () => openThemeEditor({ fresh: true }) },
    { id: 'theme-edit', label: uiT("ui.ecd113fcf1d8"), enabled: () => isCustomTheme(themeInUse('all') ?? undefined), run: () => openThemeEditor({ fresh: false }) }
  ]
}

/** Insert: the date, footer and slide number the slides show. */
export function headerFooterCommands(): OfficeCommand[] {
  return [{ id: 'header-footer', label: uiT("ui.8ee0ef6e8a92"), enabled: hasDeck, run: () => openHeaderFooter() }]
}

/** Slide: the master's drawings hidden on the picked slides, or on the layout in front in the master view. */
export function backgroundGraphicsCommands(): OfficeCommand[] {
  return [{ id: 'hide-background-graphics', label: uiT("ui.270cfd35dce6"), enabled: () => onSlides() || layoutInFront() !== null, checked: () => backgroundGraphicsHidden(), run: () => toggleBackgroundGraphics() }]
}

/** Seconds a transition can be picked to take. */
const DURATIONS = [0.25, 0.5, 0.75, 1, 1.5, 2]

const secondsLabel = (seconds: number): string => `${seconds} ${seconds === 1 ? 'Second' : 'Seconds'}`

/** The picked slides' transition as the slide in front has it, with something changed. */
function retime(patch: Partial<SlideTransition>): void {
  const now = transitionInFront()

  if (now) {
    setPickedTransition({ ...now, ...patch })
  }
}

/** The ways the transition in front can go: its directions, and for a split how it opens. */
function effectItems(): OfficeCommand[] {
  const kind = transitionInFront()?.kind ?? 'none'
  const directions = DIRECTIONS[kind].map((direction) => ({ id: `effect-${direction}`, label: uiT(DIRECTION_LABELS[direction]), checked: () => transitionInFront()?.direction === direction, run: () => retime({ direction }) }))
  const orientations = (kind === 'split' ? (['horizontal', 'vertical'] as const) : []).map((orientation, index) => ({
    id: `effect-${orientation}`,
    label: orientation === 'horizontal' ? uiT('slides.action.horizontal') : uiT('slides.action.vertical'),
    checked: () => (transitionInFront()?.orientation ?? 'horizontal') === orientation,
    run: () => retime({ orientation }),
    dividerBefore: index === 0
  }))

  return [...directions, ...orientations]
}

/** Slide: how the picked slides come in (kind, effect and duration), and one transition for every slide. */
export function transitionCommands(): OfficeCommand[] {
  return [
    {
      id: 'transition',
      label: uiT("ui.2fe70464aadf"),
      enabled: onSlides,
      run: () => {},
      dividerBefore: true,
      submenu: TRANSITIONS.map((kind) => ({ id: `transition-${kind}`, label: uiT(TRANSITION_LABELS[kind]), checked: () => transitionInFront()?.kind === kind, run: () => setPickedTransition(ofKind(kind, transitionInFront())) }))
    },
    {
      id: 'transition-effect',
      label: uiT("ui.e6b6aad81614"),
      enabled: () => DIRECTIONS[transitionInFront()?.kind ?? 'none'].length > 0,
      run: () => {},
      // Read each time the menu opens, as the options follow the kind in front.
      get submenu() {
        return effectItems()
      }
    },
    {
      id: 'transition-duration',
      label: uiT("ui.4fc52a3c4c55"),
      enabled: () => (transitionInFront()?.kind ?? 'none') !== 'none',
      run: () => {},
      submenu: DURATIONS.map((seconds) => ({ id: `duration-${seconds}`, label: secondsLabel(seconds), checked: () => transitionInFront()?.duration === seconds * 1000, run: () => retime({ duration: seconds * 1000 }) }))
    },
    {
      id: 'transition-all',
      label: uiT("ui.f1253b31fe9a"),
      enabled: onSlides,
      run: () => {
        const now = transitionInFront()

        if (now) {
          transitionToAll(now)
        }
      }
    }
  ]
}

const canPresent = () => onSlides() && !presenting()

/** While presenting, show or hide the presenter view; otherwise present from the slide in front with it. */
export function presenterView(): void {
  const state = $presentation.get()

  if (state) {
    showPresenterView(state.mode === 'slides')

    return
  }

  const active = slidesSession.active()
  const doc = live()

  if (active && doc?.mode === 'slides') {
    flushTyping(doc)
    doc.edit(null)
    startPresenting(active.key, doc.index, { presenter: true })
  }
}

/** Slide: presenting from the slide in front or from the start, and the presenter view. */
export function presentCommands(): OfficeCommand[] {
  return [
    { id: 'present', label: uiT("ui.43f9b89c0b9d"), shortcut: 'mod+shift+enter', enabled: canPresent, run: () => commands.present(false), dividerBefore: true },
    { id: 'present-start', label: uiT("ui.5981d0e5709e"), shortcut: 'mod+alt+enter', enabled: canPresent, run: () => commands.present(true) },
    { id: 'presenter-view', label: uiT("ui.c270b5ac641f"), shortcut: 'mod+alt+p', enabled: () => presenting() || canPresent(), checked: () => ($presentation.get()?.mode ?? 'slides') !== 'slides', run: presenterView }
  ]
}
