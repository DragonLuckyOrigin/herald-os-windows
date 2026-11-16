import { t as uiT, useT as useUiT } from '../../../../store/i18n.ts'
import { useStore } from '@nanostores/react'
import { IconBackground, IconForms, IconLayersSubtract, IconPalette, IconPencil, IconPhotoPlus, IconRestore, IconTemplate, IconX } from '@tabler/icons-react'
import { type ReactNode, useRef, useState } from 'react'
import { cn } from '../../../../lib/cn.ts'
import type { SlidesDocument } from '../document.ts'
import { layoutOf, masterOf } from '../layouts.ts'
import type { LogoCorner } from '../model.ts'
import { BackgroundPanel } from './BackgroundPanel.tsx'
import * as commands from './commands.ts'
import { HeaderFooterDialog } from './HeaderFooterDialog.tsx'
import { $slidesDialog, closeSlidesDialog, insertLogo, layoutInFront, openHeaderFooter, renameLayoutInFront, resetDeckMaster, showMasterView, toggleBackgroundGraphics } from './master-commands.ts'
import { PopoverButton } from './pickers.tsx'
import { useDeck } from './Stage.tsx'
import { ThemeEditor } from './ThemeEditor.tsx'
import { ThemePanel } from './ThemePanel.tsx'

/*
 * The bar over the slide in the master view: what goes on the master (a logo, its background, the
 * header and footer, the theme) and on the layout in front (its background, whether it shows the
 * master's drawings, its name), putting Herald's master back, and the way out of the view. Also the
 * dialogs the bar, the panels and the menus open, mounted once in the window.
 */

const CORNERS: { corner: LogoCorner; name: string; place: string }[] = [
  { corner: 'top-left', get name() { return uiT('office.position.topLeft') }, place: 'items-start justify-start' },
  { corner: 'top-right', get name() { return uiT('office.position.topRight') }, place: 'items-start justify-end' },
  { corner: 'bottom-left', get name() { return uiT('office.position.bottomLeft') }, place: 'items-end justify-start' },
  { corner: 'bottom-right', get name() { return uiT('office.position.bottomRight') }, place: 'items-end justify-end' }
]

const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-line" />

function BarButton({ label, onClick, active, disabled, children }: { label: string; onClick: () => void; active?: boolean; disabled?: boolean; children: ReactNode }) {
  useUiT()
  return (
    <button
      type="button"
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn('flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 whitespace-nowrap text-fg-2 hover:bg-white/8 hover:text-fg disabled:opacity-40 [&_svg]:size-4', active && 'bg-white/12 text-fg')}
    >
      {children}
    </button>
  )
}

function LogoPanel({ doc, onDone }: { doc: SlidesDocument; onDone: () => void }) {
  useUiT()
  const [corner, setCorner] = useState<LogoCorner>('top-right')
  const [layoutOnly, setLayoutOnly] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const layout = layoutInFront(doc)

  return (
    <div className="flex w-[220px] flex-col gap-3 text-[12px] text-fg-2">
      <div className="text-[11px] font-medium tracking-wide text-fg-3 uppercase">{uiT("ui.adfde70bdb68")}</div>
      <div role="radiogroup" aria-label={uiT("ui.adfde70bdb68")} className="grid aspect-video grid-cols-2 grid-rows-2 gap-1 rounded-md border border-line p-1">
        {CORNERS.map(({ corner: at, name, place }) => (
          <button key={at} type="button" role="radio" aria-checked={corner === at} aria-label={name} title={name} onClick={() => setCorner(at)} className={cn('flex rounded-[3px] p-1.5 hover:bg-white/8', place, corner === at && 'bg-accent/15')}>
            <span className={cn('h-2.5 w-4 rounded-[2px]', corner === at ? 'bg-accent' : 'bg-fg-4')} />
          </button>
        ))}
      </div>
      {layout && (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={layoutOnly} onChange={(event) => setLayoutOnly(event.target.checked)} />
          {uiT("ui.24e81c31e164")}{layoutOf(masterOf(doc.presentation), layout).name}{uiT("ui.ee8500f4c0ad")}</label>
      )}
      <button type="button" onClick={() => file.current?.click()} className="h-8 rounded-md border border-line hover:bg-white/8">
        {uiT("ui.537f9c0a0275")}</button>
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const picked = event.target.files?.[0]
          event.target.value = ''

          if (picked) {
            insertLogo(picked, { corner, ...(layout && layoutOnly ? { layoutId: layout } : {}) }, doc).then(onDone, () => commands.notify(uiT('slides.pictureFailed')))
          }
        }}
      />
    </div>
  )
}

function RenamePanel({ doc, onDone }: { doc: SlidesDocument; onDone: () => void }) {
  useUiT()
  const layout = layoutInFront(doc)
  const [name, setName] = useState(() => (layout ? layoutOf(masterOf(doc.presentation), layout).name : ''))

  return (
    <form
      className="flex w-[240px] items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        renameLayoutInFront(name, doc)
        onDone()
      }}
    >
      <input autoFocus value={name} onChange={(event) => setName(event.target.value)} aria-label={uiT("ui.38a82ab9f497")} className="glass-input h-7 min-w-0 flex-1 rounded-md px-2 text-[12px] text-fg outline-none" />
      <button type="submit" className="h-7 rounded-md bg-accent px-2.5 text-[12px] font-medium text-accent-fg hover:bg-accent-strong">
        {uiT("ui.32a50be4327f")}</button>
    </form>
  )
}

function ResetPanel({ doc, onDone }: { doc: SlidesDocument; onDone: () => void }) {
  useUiT()
  return (
    <div className="flex w-[260px] flex-col gap-2.5 text-[12px] text-fg-2">
      <p>{uiT("ui.25e06d69a74f")}</p>
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onDone} className="h-7 rounded-md px-2.5 hover:bg-white/8 hover:text-fg">
          {uiT("ui.0ef70263b054")}</button>
        <button
          type="button"
          onClick={() => {
            resetDeckMaster(doc)
            onDone()
          }}
          className="h-7 rounded-md bg-danger/15 px-2.5 text-danger hover:bg-danger/25"
        >
          {uiT("ui.9957b7ef6db3")}</button>
      </div>
    </div>
  )
}

export function MasterBar({ doc }: { doc: SlidesDocument }) {
  useUiT()
  useDeck(doc)
  const layout = layoutInFront(doc)
  const own = layout ? layoutOf(masterOf(doc.presentation), layout) : null

  return (
    <div data-slides-keep-editing="" className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-accent/6 px-2 text-[12px]">
      <span className="flex shrink-0 items-center gap-1.5 px-1.5 font-medium text-fg">
        <IconTemplate size={15} className="text-accent-strong" />{uiT("ui.5b6c090f1c5a")}</span>
      <span className="max-w-44 shrink-0 truncate px-1 text-fg-3">{own ? uiT("ui.eb1e3c6c69dd", { value1: String(own.name) }) : uiT("ui.a52ca61e32bc")}</span>
      <Divider />
      <PopoverButton label={uiT("ui.62436bf1965b")} className="shrink-0 whitespace-nowrap" panel={(close) => <LogoPanel doc={doc} onDone={close} />}>
        <IconPhotoPlus />{uiT("ui.4d3dbab8df7d")}</PopoverButton>
      <PopoverButton label={uiT("ui.ea2b8a878841")} className="shrink-0 whitespace-nowrap" panel={(close) => <BackgroundPanel doc={doc} onDone={close} />}>
        <IconBackground />{uiT("ui.a8b430be58e1")}</PopoverButton>
      <BarButton label={uiT("ui.270cfd35dce6")} active={Boolean(own && !own.showMaster)} disabled={!own} onClick={() => toggleBackgroundGraphics(doc)}>
        <IconLayersSubtract />{uiT("ui.716aa585fe77")}</BarButton>
      <PopoverButton label={uiT("ui.2ab61b5f3166")} className="shrink-0 whitespace-nowrap" disabled={!own} panel={(close) => <RenamePanel doc={doc} onDone={close} />}>
        <IconPencil />{uiT("ui.1269753b3e6f")}</PopoverButton>
      <Divider />
      <BarButton label={uiT("ui.8ee0ef6e8a92")} onClick={() => openHeaderFooter(doc)}>
        <IconForms />{uiT("ui.a718c159f7c8")}</BarButton>
      <PopoverButton label={uiT("ui.efb52e7172b7")} className="shrink-0 whitespace-nowrap" panel={(close) => <ThemePanel doc={doc} onDone={close} />}>
        <IconPalette />{uiT("ui.25bb50e8034c")}</PopoverButton>
      <PopoverButton label={uiT("ui.73a24c835f01")} className="shrink-0 whitespace-nowrap" panel={(close) => <ResetPanel doc={doc} onDone={close} />}>
        <IconRestore />{uiT("ui.be8af2aaa32c")}</PopoverButton>
      <div className="ml-auto flex shrink-0 items-center pl-2">
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => showMasterView(false, doc)}
          className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 whitespace-nowrap text-[12px] font-medium text-accent-fg hover:bg-accent-strong"
        >
          <IconX size={14} />{uiT("ui.3a0238db7f6e")}</button>
      </div>
    </div>
  )
}

/** The theme editor or the header and footer dialog, whichever is open; mounted once in the window, outside its editors. */
export function SlidesDialogs() {
  useUiT()
  const dialog = useStore($slidesDialog)

  if (dialog?.kind === 'theme') {
    return <ThemeEditor doc={dialog.doc} theme={dialog.theme} fresh={dialog.fresh} scope={dialog.scope} onClose={closeSlidesDialog} />
  }

  return dialog?.kind === 'header-footer' ? <HeaderFooterDialog doc={dialog.doc} onClose={closeSlidesDialog} /> : null
}
