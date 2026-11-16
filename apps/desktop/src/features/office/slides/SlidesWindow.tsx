import { shapeGroupLabel, shapeLabel, borderLabel, arrangeLabel, alignLabel } from './editor/pickers.tsx'
import { t as uiT, useT as useUiT, $language as $uiLanguage } from '../../../store/i18n.ts'
import { useEffect, useMemo, useState } from 'react'
import { openFormats } from '../../../../shared/office/files.ts'
import { messageOf } from '../../canvas/errors.ts'
import { refreshOpenDocuments, slidesHermesMenu } from '../hermes/actions.ts'
import { officeAbilities } from '../session.ts'
import type { OfficeCommand } from '../shell/commands.ts'
import { officeMenus } from '../shell/commands.ts'
import { OfficeWindow } from '../shell/OfficeWindow.tsx'
import type { OfficeDocument } from '../types.ts'
import { type Deck, LAYOUTS, SLIDE_SIZES } from './deck.ts'
import { $textSession } from './editor/active.ts'
import { BORDER_CHOICES } from './editor/borders.ts'
import * as commands from './editor/commands.ts'
import { chooseSheet, FromSheetDialog } from './editor/FromSheetDialog.tsx'
import { SlidesDialogs } from './editor/MasterBar.tsx'
import { backgroundGraphicsCommands, headerFooterCommands, masterViewCommands, presentCommands, themeCommands, transitionCommands } from './editor/slides-menus.ts'
import { Toolbar } from './editor/Toolbar.tsx'
import { layoutDisplayName } from './editor/pickers.tsx'
import { type AlignEdge } from './model.ts'
import { Present } from './Present.tsx'
import { SHAPE_GROUPS } from './shapes.ts'
import { SlideEditor } from './SlideEditor.tsx'
import { decks, slidesSession } from './store.ts'

const hasDeck = () => Boolean(commands.live())
const hasSelection = () => Boolean(commands.live()?.selected.length)
const notTyping = () => !$textSession.get()
const canEditSelection = () => hasSelection() && notTyping()
const canFormat = () => commands.canFormatText()
const onSlides = () => commands.live()?.mode === 'slides'

function slideCommands(): OfficeCommand[] {
  return [
    { id: 'new-slide', label: uiT("ui.b306850adf84"), shortcut: 'mod+shift+n', enabled: onSlides, run: () => commands.newSlide() },
    { id: 'new-slide-layout', label: uiT("ui.ab505909cf66"), enabled: onSlides, run: () => {}, submenu: LAYOUTS.map((layout) => ({ id: `new-${layout}`, label: layoutDisplayName(layout), run: () => commands.newSlide(layout) })) },
    { id: 'duplicate-slide', label: uiT("ui.4ccdbdd731b7"), enabled: onSlides, run: commands.duplicateSlides },
    { id: 'delete-slide', label: uiT("ui.ce3bab66fd79"), enabled: onSlides, run: commands.deleteSlides },
    { id: 'hide-slide', label: uiT("ui.17fd2a256346"), enabled: onSlides, run: commands.toggleHidden },
    { id: 'slide-up', label: uiT("ui.6097edd967b6"), enabled: onSlides, run: () => commands.moveSlidesBy(-1), dividerBefore: true },
    { id: 'slide-down', label: uiT("ui.ddc5115f1d44"), enabled: onSlides, run: () => commands.moveSlidesBy(1) },
    {
      id: 'layout',
      label: uiT("ui.a511909161e1"),
      enabled: onSlides,
      run: () => {},
      dividerBefore: true,
      submenu: LAYOUTS.map((layout) => ({ id: `layout-${layout}`, label: layoutDisplayName(layout), checked: () => commands.live()?.slide.layout === layout, run: () => commands.setLayout(layout) }))
    },
    ...themeCommands(),
    ...transitionCommands(),
    {
      id: 'size',
      label: uiT("ui.8279eb762987"),
      enabled: onSlides,
      run: () => {},
      submenu: [
        { id: 'size-wide', label: uiT("ui.1440ad5e3dd6"), checked: () => commands.live()?.presentation.size.width === SLIDE_SIZES.wide.width, run: () => commands.setSlideSize(SLIDE_SIZES.wide) },
        { id: 'size-standard', label: uiT("ui.7bb026aba574"), checked: () => commands.live()?.presentation.size.width === SLIDE_SIZES.standard.width, run: () => commands.setSlideSize(SLIDE_SIZES.standard) }
      ]
    },
    { id: 'background-theme', label: uiT("ui.f55467fe84f8"), enabled: hasDeck, run: () => commands.setBackground(null) },
    ...backgroundGraphicsCommands(),
    ...presentCommands()
  ]
}

/** Rows and columns of the tables the Insert menu offers; the toolbar's grid picks any size up to 8 by 10. */
const TABLE_SIZES = [
  [2, 2],
  [3, 2],
  [3, 3],
  [4, 3],
  [4, 4],
  [5, 4],
  [6, 5]
] as const

/** The most shapes a submenu lists, so it stays in the window; a bigger group goes on in a second submenu. */
const SHAPES_PER_MENU = 20

const titleCase = (name: string): string => name.replace(/\b(?!and\b|of\b|to\b)\w/g, (letter) => letter.toUpperCase())

/** A submenu of shapes for each of the gallery's groups (a submenu's own submenus do not open, so these are the Insert menu's own). */
function shapeCommands(): OfficeCommand[] {
  return SHAPE_GROUPS.flatMap((group) => {
    const name = $uiLanguage.get() === 'de-DE' ? shapeGroupLabel(group.name) : titleCase(group.name)
    const more = $uiLanguage.get() === 'de-DE' ? uiT('slides.moreShapes', { name }) : `More ${name.endsWith('Shapes') ? name : `${name} Shapes`}`
    const parts = Math.ceil(group.kinds.length / SHAPES_PER_MENU)
    const size = Math.ceil(group.kinds.length / parts)

    return Array.from({ length: parts }, (_, part) => ({
      id: `shapes-${group.name}-${part}`,
      label: part ? `${more}${parts > 2 ? ` (${part})` : ''}` : name,
      enabled: hasDeck,
      run: () => {},
      submenu: group.kinds.slice(part * size, (part + 1) * size).map((kind) => ({ id: `shape-${kind}`, label: shapeLabel(kind), run: () => commands.insertShape(kind) }))
    }))
  })
}

function insertCommands(): OfficeCommand[] {
  return [
    { id: 'insert-text', label: uiT("ui.dc7ec1ed1293"), enabled: hasDeck, run: commands.insertText },
    ...shapeCommands().map((command, index) => ({ ...command, dividerBefore: index === 0 })),
    { id: 'insert-line', label: uiT("ui.d7852cd0d245"), enabled: hasDeck, run: () => commands.insertLine('none'), dividerBefore: true },
    { id: 'insert-arrow', label: uiT("ui.05800e70aa10"), enabled: hasDeck, run: () => commands.insertLine('triangle') },
    {
      id: 'insert-connector',
      label: uiT("ui.8f0d706fff25"),
      enabled: hasDeck,
      run: () => {},
      submenu: (Object.keys(commands.CONNECTOR_NAMES) as (keyof typeof commands.CONNECTOR_NAMES)[]).map((preset) => ({ id: `connector-${preset}`, label: uiT(({ straightConnector1: 'slides.connector.straight', bentConnector3: 'slides.connector.elbow', curvedConnector3: 'slides.connector.curved' } as const)[preset]), run: () => commands.drawConnector(preset) }))
    },
    { id: 'insert-picture', label: uiT("ui.0f7d9830b3f0"), enabled: hasDeck, run: () => commands.pickPictures(), dividerBefore: true },
    {
      id: 'insert-table',
      label: uiT("ui.16d1c9050a0b"),
      enabled: hasDeck,
      run: () => {},
      submenu: TABLE_SIZES.map(([rows, columns]) => ({ id: `table-${rows}-${columns}`, label: uiT("ui.b546082c79bb", { value1: String(rows), value2: String(columns) }), run: () => commands.insertTable(rows, columns) }))
    },
    { id: 'insert-sheet-table', label: uiT("ui.df3cf95fb873"), enabled: hasDeck, run: () => void chooseSheet().catch((error: unknown) => commands.notify(uiT('slides.spreadsheetFailed', { error: messageOf(error) }))) },
    { id: 'insert-document-slides', label: uiT("ui.233b2f29246f"), enabled: onSlides, run: () => void commands.insertSlidesFromDocument().catch((error: unknown) => commands.notify(uiT('slides.documentFailed', { error: messageOf(error) }))) },
    ...headerFooterCommands().map((command, index) => ({ ...command, dividerBefore: index === 0 }))
  ]
}

const hasTable = () => {
  const doc = commands.live()

  return Boolean(doc && doc.selected.length === 1 && doc.selection[0]?.kind === 'table')
}

function tableCommands(): OfficeCommand[] {
  return [
    { id: 'table-row-above', label: uiT("ui.a6c1f35ccb5a"), enabled: hasTable, run: () => commands.insertRow('above') },
    { id: 'table-row-below', label: uiT("ui.928ae5db553d"), enabled: hasTable, run: () => commands.insertRow('below') },
    { id: 'table-column-left', label: uiT("ui.ca764f106c30"), enabled: hasTable, run: () => commands.insertColumn('left') },
    { id: 'table-column-right', label: uiT("ui.c56e17b4d400"), enabled: hasTable, run: () => commands.insertColumn('right') },
    { id: 'table-delete-row', label: uiT("ui.43654c6556c7"), enabled: () => commands.hasTableCell(), run: () => commands.deleteRows(), dividerBefore: true },
    { id: 'table-delete-column', label: uiT("ui.f4ede32c5528"), enabled: () => commands.hasTableCell(), run: () => commands.deleteColumns() },
    {
      id: 'table-borders',
      label: uiT("ui.0de9f358ad56"),
      enabled: hasTable,
      run: () => {},
      dividerBefore: true,
      submenu: BORDER_CHOICES.map((choice) => ({ id: `borders-${choice}`, label: borderLabel(choice), run: () => commands.setBorders(choice), dividerBefore: choice === 'top' || choice === 'none' }))
    }
  ]
}

function formatCommands(): OfficeCommand[] {
  const align = (value: 'left' | 'center' | 'right' | 'justify', label: string, shortcut: string): OfficeCommand => ({ id: `align-${value}`, label, shortcut, enabled: canFormat, run: () => commands.setAlign(value) })

  return [
    { id: 'bold', label: uiT("ui.94fee62e68e2"), shortcut: 'mod+b', enabled: canFormat, run: () => commands.toggleSwitch('bold') },
    { id: 'italic', label: uiT("ui.9bf37cb58a69"), shortcut: 'mod+i', enabled: canFormat, run: () => commands.toggleSwitch('italic') },
    { id: 'underline', label: uiT("ui.02f843261112"), shortcut: 'mod+u', enabled: canFormat, run: () => commands.toggleSwitch('underline') },
    { id: 'strike', label: uiT("ui.9aabbcb2c18d"), shortcut: 'mod+shift+x', enabled: canFormat, run: () => commands.toggleSwitch('strike') },
    { id: 'bigger', label: uiT("ui.8d1dae52b0b7"), shortcut: 'mod+shift+>', enabled: canFormat, run: () => commands.stepSize(1), dividerBefore: true },
    { id: 'smaller', label: uiT("ui.00417195b1e2"), shortcut: 'mod+shift+<', enabled: canFormat, run: () => commands.stepSize(-1) },
    align('left', alignLabel('left'), 'mod+shift+l'),
    { ...align('center', uiT('ui.45c19322f7b9'), 'mod+shift+e'), dividerBefore: false },
    align('right', alignLabel('right'), 'mod+shift+r'),
    align('justify', uiT('ui.f3bd3473d7d8'), 'mod+shift+j'),
    { id: 'bullets', label: uiT("ui.20c579c3da98"), shortcut: 'mod+shift+8', enabled: canFormat, run: () => commands.toggleListKind('bullet'), dividerBefore: true },
    { id: 'numbering', label: uiT("ui.7b3ffc4c2065"), shortcut: 'mod+shift+7', enabled: canFormat, run: () => commands.toggleListKind('number') },
    { id: 'level-up', label: uiT("ui.7331f071b9a1"), enabled: canFormat, run: () => commands.shiftLevels(1) },
    { id: 'level-down', label: uiT("ui.1a94c07fb328"), enabled: canFormat, run: () => commands.shiftLevels(-1) },
    {
      id: 'anchor',
      label: uiT("ui.e8f2be97ea95"),
      enabled: canFormat,
      run: () => {},
      dividerBefore: true,
      submenu: (['top', 'middle', 'bottom'] as const).map((anchor) => ({ id: `anchor-${anchor}`, label: anchor === 'top' ? uiT('office.position.top') : anchor === 'middle' ? uiT('office.position.middle') : uiT('office.position.bottom'), run: () => commands.setAnchor(anchor) }))
    },
    {
      id: 'autofit',
      label: uiT("ui.9f017d6201c2"),
      enabled: canFormat,
      run: () => {},
      submenu: [
        { id: 'fit-none', label: uiT("ui.cf1c8f8cbe3c"), run: () => commands.setAutoFit('none') },
        { id: 'fit-shrink', label: uiT("ui.6a67590d6216"), run: () => commands.setAutoFit('shrink') },
        { id: 'fit-grow', label: uiT("ui.7f280a06d53e"), run: () => commands.setAutoFit('grow') }
      ]
    }
  ]
}

function arrangeCommands(): OfficeCommand[] {
  const edges: AlignEdge[] = ['left', 'center', 'right', 'top', 'middle', 'bottom']

  return [
    { id: 'front', label: arrangeLabel('front'), shortcut: 'mod+shift+]', enabled: canEditSelection, run: () => commands.arrange('front') },
    { id: 'forward', label: arrangeLabel('forward'), shortcut: 'mod+]', enabled: canEditSelection, run: () => commands.arrange('forward') },
    { id: 'backward', label: arrangeLabel('backward'), shortcut: 'mod+[', enabled: canEditSelection, run: () => commands.arrange('backward') },
    { id: 'back', label: arrangeLabel('back'), shortcut: 'mod+shift+[', enabled: canEditSelection, run: () => commands.arrange('back') },
    { id: 'align', label: uiT("ui.b1b1b4e5e8d7"), enabled: canEditSelection, run: () => {}, dividerBefore: true, submenu: edges.map((edge) => ({ id: `align-${edge}`, label: alignLabel(edge), run: () => commands.alignSelection(edge) })) },
    {
      id: 'distribute',
      label: uiT("ui.b0585a6eba7b"),
      enabled: () => (commands.live()?.selected.length ?? 0) > 2 && notTyping(),
      run: () => {},
      submenu: [
        { id: 'distribute-h', label: uiT("ui.2377ca3fd4a0"), run: () => commands.distributeSelection('horizontal') },
        { id: 'distribute-v', label: uiT("ui.54a646214d07"), run: () => commands.distributeSelection('vertical') }
      ]
    },
    { id: 'group', label: uiT("ui.34ca0e766088"), shortcut: 'mod+alt+g', enabled: () => notTyping() && commands.canGroup(), run: () => commands.groupSelection(), dividerBefore: true },
    { id: 'ungroup', label: uiT("ui.b57ef478f9ba"), shortcut: 'mod+alt+shift+g', enabled: () => notTyping() && commands.canUngroup(), run: () => commands.ungroupSelection() },
    { id: 'convert-to-shapes', label: uiT("ui.05d12597dcde"), enabled: () => notTyping() && commands.canConvert(), run: () => commands.convertSelection() }
  ]
}

const zoom = (step: 'in' | 'out' | 'reset') => () => slidesSession.active()?.editor?.zoom?.(step)

/** Herald Slides: decks of slides drawn in the page, edited in place and presented full screen. */
export function SlidesWindow({ payload }: { payload?: Record<string, unknown> }) {
  useUiT()
  const [canOpen, setCanOpen] = useState(true)

  useEffect(() => {
    void officeAbilities().then((abilities) => setCanOpen(openFormats('slides', abilities).length > 0))
  }, [])

  // The Hermes menu lists the documents open in other windows: a click is when it may open next.
  useEffect(() => {
    const refresh = () => void refreshOpenDocuments()
    refresh()
    window.addEventListener('pointerdown', refresh, true)

    return () => window.removeEventListener('pointerdown', refresh, true)
  }, [])

  const menus = useMemo(
    () =>
      officeMenus({
        session: slidesSession,
        canSave: true,
        file: [{ id: 'new-from-document', label: uiT("ui.7443c2e435ef"), run: () => void commands.newFromDocument().catch((error: unknown) => commands.notify(uiT('slides.documentFailed', { error: messageOf(error) }))), dividerBefore: true }],
        edit: [
          { id: 'cut', label: uiT("ui.1f45f02561f4"), shortcut: 'mod+x', enabled: canEditSelection, run: () => commands.copyToClipboard(true), dividerBefore: true },
          { id: 'copy', label: uiT("ui.e21f935f11d7"), shortcut: 'mod+c', enabled: canEditSelection, run: () => commands.copyToClipboard(false) },
          { id: 'duplicate', label: uiT("ui.02cdaabfca80"), shortcut: 'mod+d', enabled: canEditSelection, run: commands.duplicateSelection },
          { id: 'delete', label: uiT("ui.e2d0a54968ea"), enabled: canEditSelection, run: commands.deleteSelection },
          { id: 'select-all', label: uiT("ui.d1ec69e64b96"), shortcut: 'mod+a', enabled: () => hasDeck() && notTyping(), run: commands.selectAll, dividerBefore: true }
        ],
        menus: [
          { id: 'insert', label: uiT("ui.8aa318eb7eaa"), items: insertCommands() },
          { id: 'slide', label: uiT("ui.6bb4c1177681"), items: slideCommands() },
          { id: 'format', label: uiT("ui.2f343666aaa8"), items: formatCommands() },
          { id: 'arrange', label: uiT("ui.d557a972ab06"), items: arrangeCommands() },
          { id: 'table', label: uiT("ui.16d1c9050a0b"), items: tableCommands() },
          {
            id: 'view',
            label: uiT("ui.dcc839a4015c"),
            items: [
              { id: 'zoom-in', label: uiT("ui.5a982cf9dc11"), shortcut: 'mod+=', enabled: hasDeck, run: zoom('in') },
              { id: 'zoom-out', label: uiT("ui.24649ee0c7a9"), shortcut: 'mod+-', enabled: hasDeck, run: zoom('out') },
              { id: 'zoom-fit', label: uiT("ui.a670624c9f93"), shortcut: 'mod+0', enabled: hasDeck, run: zoom('reset') },
              ...masterViewCommands().map((command, index) => ({ ...command, dividerBefore: index === 0 }))
            ]
          },
          slidesHermesMenu({ docKey: () => (hasDeck() ? slidesSession.$activeKey.get() : null) })
        ]
      }),
    [$uiLanguage.get(), ]
  )

  const open = (file: string) => slidesSession.open(file).catch((error: unknown) => slidesSession.notify(uiT('office.openFailed', { file: file.split('/').pop() ?? file, error: messageOf(error) }), 'error'))

  return (
    <div
      className="contents"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
        }
      }}
      onDrop={(event) => {
        const files = [...event.dataTransfer.files]
        const slides = files.filter((file) => /\.(pptx|pptm)$/i.test(file.name))
        const pictures = files.filter((file) => file.type.startsWith('image/'))

        if (!slides.length && !pictures.length) {
          return
        }

        event.preventDefault()
        slides.forEach((file) => {
          const path = window.heraldOS.fs.pathForFile(file)

          if (path) {
            void open(path)
          }
        })

        if (pictures.length) {
          void commands.insertPictures(pictures)
        }
      }}
    >
      <OfficeWindow
        session={slidesSession}
        menus={menus}
        payload={payload}
        noun="presentation"
        canOpen={canOpen}
        start={{ icon: 'slides', blurb: uiT("office.start.slides"), newLabel: uiT("office.new.slides"), hint: uiT("ui.3dc3d4a86476") }}
        toolbar={(doc: OfficeDocument<Deck>) => {
          const live = decks.get(doc.key)

          return live ? <Toolbar key={doc.key} doc={live} /> : null
        }}
        renderEditor={(doc) => <SlideEditor doc={doc} />}
      />
      <FromSheetDialog />
      <Present />
      <SlidesDialogs />
    </div>
  )
}
