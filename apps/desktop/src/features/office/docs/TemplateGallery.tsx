import { t as uiT, useT as useUiT, $language as $uiLanguage } from '../../../store/i18n.ts'
import { IconPencil, IconTrash } from '@tabler/icons-react'
import type { Editor } from '@tiptap/core'
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { DocJSON } from '../../../../shared/office/document.ts'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { messageOf } from '../../canvas/errors.ts'
import { $editors, $templateGallery, docsSession } from './store.ts'
import { type Direction, freshName, moveSelection, rowLength } from './templates/gallery.ts'
import { documentFromTemplate, TEMPLATES } from './templates/index.ts'
import { removeTemplate, renameTemplate, type SavedTemplate, savedTemplates } from './templates/saved.ts'
import { thumbnailOf } from './templates/thumbnail.ts'

/*
 * The gallery a new document starts from: the blank document, first and selected so that New and
 * then Enter make one, Herald's templates and the person's own, each a live thumbnail of its first
 * page. The arrow keys move, Enter makes the document and Escape goes back. Only the person's own
 * New opens it: a document asked for by Hermes or another app is blank, with no dialog.
 */

const TEMPLATE_DESCRIPTIONS = {"blank":"ui.a05bde21300c","letter":"ui.80232b025d24","cover-letter":"ui.14fee0999fb7","cv":"ui.a4b3e3d2471d","report":"ui.3b3d497a42d1","memo":"ui.63cef4dd300d","meeting-notes":"ui.b15c7d2aca4e","essay":"ui.acf9b874d77d","project-proposal":"ui.31c31fc756b8","newsletter":"ui.36b3fa777441","invoice":"ui.c5e60f4dbd0d","thank-you-note":"ui.41200213e00f","recipe":"ui.8edd1242f627"} as const

const TEMPLATE_NAMES = {"blank":"office.template.blank","letter":"office.template.letter","cover-letter":"office.template.cover-letter","cv":"office.template.cv","report":"office.template.report","memo":"office.template.memo","meeting-notes":"office.template.meeting-notes","essay":"office.template.essay","project-proposal":"office.template.project-proposal","newsletter":"office.template.newsletter","invoice":"office.template.invoice","thank-you-note":"office.template.thank-you-note","recipe":"office.template.recipe"} as const
const THUMB = { width: 124, height: 175 }

const DIRECTIONS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'home', End: 'end' }

const locale = (): string => (typeof navigator === 'undefined' ? 'en-GB' : navigator.language)

interface Card {
  key: string
  name: string
  displayName?: string
  description: string
  doc: DocJSON
  saved?: SavedTemplate
}

const savedCard = (template: SavedTemplate): Card => {
  const date = new Date(template.savedAt)

  return { key: `saved-${template.id}`, name: template.name, description: Number.isNaN(date.getTime()) ? uiT("office.template.own") : uiT("office.template.saved", { date: date.toLocaleDateString(locale(), { day: "numeric", month: "long", year: "numeric" }) }), doc: template.doc, saved: template }
}

/** A document's first page, scaled down to fit the card at the page's own proportions. */
function Thumbnail({ doc, scope }: { doc: DocJSON; scope: string }) {
  useUiT()
  const thumb = useMemo(() => thumbnailOf(doc, `[data-thumb="${scope}"]`, { locale: locale() }), [$uiLanguage.get(), doc, scope])
  const { page } = thumb
  const { margins } = page
  const zoom = Math.min(THUMB.width / ((page.width * 96) / 72), THUMB.height / ((page.height * 96) / 72))
  const sides = { left: `${margins.left}pt`, right: `${margins.right}pt` }

  return (
    <div className="grid shrink-0 place-items-center" style={THUMB} aria-hidden="true">
      <div data-thumb={scope} className="pointer-events-none relative overflow-hidden bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,.3),0_4px_14px_rgba(0,0,0,.28)] select-none" style={{ width: `${page.width}pt`, height: `${page.height}pt`, zoom }}>
        <style>{thumb.css}</style>
        {thumb.header && <div className="absolute" style={{ top: `${margins.header ?? 36}pt`, ...sides }} dangerouslySetInnerHTML={{ __html: thumb.header }} />}
        <div className="absolute overflow-hidden" style={{ top: `${margins.top}pt`, bottom: `${margins.bottom}pt`, ...sides }} dangerouslySetInnerHTML={{ __html: thumb.body }} />
        {thumb.footer && <div className="absolute" style={{ bottom: `${margins.footer ?? 36}pt`, ...sides }} dangerouslySetInnerHTML={{ __html: thumb.footer }} />}
      </div>
    </div>
  )
}

function CardAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  useUiT()
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event: MouseEvent) => {
        event.stopPropagation()
        onClick()
      }}
      className="grid size-6 place-items-center rounded-md bg-black/60 text-white/85 hover:bg-black/80 hover:text-white"
    >
      {children}
    </button>
  )
}

/** Put the caret at the start of a new document as soon as its editor is there. */
function focusWhenReady(key: string): void {
  const focus = (editors: Readonly<Record<string, Editor>>): boolean => {
    editors[key]?.commands.focus('start')

    return Boolean(editors[key])
  }

  if (focus($editors.get())) {
    return
  }

  const stop = $editors.listen((editors) => {
    if (focus(editors)) {
      queueMicrotask(stop)
    }
  })
  setTimeout(stop, 10000)
}

export function TemplateGallery() {
  useUiT()
  const builtIn = useMemo<Card[]>(() => TEMPLATES.map((template) => ({ key: template.id, name: template.name, displayName: uiT(TEMPLATE_NAMES[template.id as keyof typeof TEMPLATE_NAMES]), description: uiT(TEMPLATE_DESCRIPTIONS[template.id as keyof typeof TEMPLATE_DESCRIPTIONS]), doc: documentFromTemplate(template.id, { locale: locale() }) })), [$uiLanguage.get(), ])
  const [saved, setSaved] = useState<SavedTemplate[]>([])
  const [selected, setSelected] = useState(0)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SavedTemplate | null>(null)
  const elements = useRef<(HTMLDivElement | null)[]>([])
  const before = useRef<Element | null>(document.activeElement)
  const created = useRef(false)
  // The template being renamed, so that Enter and the blur after it rename it once.
  const naming = useRef<string | null>(null)
  const cards = useMemo(() => [...builtIn, ...saved.map(savedCard)], [$uiLanguage.get(), builtIn, saved])
  const current = cards[Math.min(selected, cards.length - 1)]

  useEffect(() => {
    let live = true
    void savedTemplates()
      .then((list) => live && setSaved(list))
      .catch((error: unknown) => docsSession.notify(uiT('docs.templates.readFailed', { error: messageOf(error) }), 'error'))

    return () => {
      live = false
    }
  }, [])

  // The selected card has the focus, so the keys and a screen reader follow the selection.
  useEffect(() => {
    if (!renaming && !deleting) {
      elements.current[selected]?.focus()
    }
  }, [selected, cards.length, renaming, deleting])

  // Closed without a new document, the focus goes back where it was.
  useEffect(
    () => () => {
      if (!created.current && before.current instanceof HTMLElement && before.current.isConnected) {
        before.current.focus()
      }
    },
    []
  )

  const close = () => $templateGallery.set(false)

  const create = (card: Card | undefined) => {
    if (!card) {
      return
    }

    created.current = true
    close()
    const names = docsSession.$documents.get().map((doc) => doc.name)
    const model = card.saved ? structuredClone(card.saved.doc) : card.key === 'blank' ? null : documentFromTemplate(card.key, { locale: locale() })
    const doc = model ? docsSession.create({ model, name: freshName(card.name, names) }) : docsSession.create()
    focusWhenReady(doc.key)
  }

  const startRename = (template: SavedTemplate) => {
    naming.current = template.id
    setRenaming(template.id)
  }

  const rename = (template: SavedTemplate, name: string | null) => {
    if (naming.current !== template.id) {
      return
    }

    naming.current = null
    setRenaming(null)
    const wanted = name?.trim()

    if (!wanted || wanted === template.name) {
      return
    }

    renameTemplate(template.id, wanted)
      .then((info) => setSaved((list) => list.map((entry) => (entry.id === template.id ? { ...entry, name: info.name } : entry))))
      .catch((error: unknown) => docsSession.notify(uiT('docs.templates.renameFailed', { name: template.name, error: messageOf(error) }), 'error'))
  }

  const remove = (template: SavedTemplate) => {
    setDeleting(null)
    removeTemplate(template.id)
      .then(() => {
        setSaved((list) => list.filter((entry) => entry.id !== template.id))
        setSelected((index) => Math.min(index, cards.length - 2))
      })
      .catch((error: unknown) => docsSession.notify(uiT('docs.templates.deleteFailed', { name: template.name, error: messageOf(error) }), 'error'))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const direction = DIRECTIONS[event.key]

    // The name field takes its own keys.
    if (target.tagName === 'INPUT') {
      return
    }

    if (event.key === 'Escape') {
      if (deleting) {
        setDeleting(null)
      } else {
        close()
      }
    } else if (event.key === 'Enter') {
      // A button takes its own Enter.
      if (target.closest('button')) {
        return
      }

      if (deleting) {
        remove(deleting)
      } else {
        create(current)
      }
    } else if (direction && !deleting) {
      const tops = elements.current.slice(0, builtIn.length).map((element) => element?.offsetTop ?? 0)
      setSelected(moveSelection([builtIn.length, saved.length], rowLength(tops), selected, direction))
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && current?.saved && !deleting) {
      setDeleting(current.saved)
    } else {
      return
    }

    event.preventDefault()
    event.stopPropagation()
  }

  const cardView = (card: Card, index: number) => (
    <div
      key={card.key}
      ref={(element) => {
        elements.current[index] = element
      }}
      role="option"
      aria-selected={index === selected}
      tabIndex={index === selected ? 0 : -1}
      title={card.description}
      onClick={() => setSelected(index)}
      onDoubleClick={() => create(card)}
      className={cn('group/reveal-row relative flex cursor-default flex-col items-center gap-2 rounded-xl border p-2 outline-none transition-colors duration-120', index === selected ? 'border-accent-strong/70 bg-accent-soft' : 'border-transparent hover:bg-white/6')}
    >
      <Thumbnail doc={card.doc} scope={card.key} />
      {card.saved && renaming === card.saved.id ? (
        <input
          autoFocus
          aria-label={uiT("ui.7b905ed0eaf2")}
          defaultValue={card.name}
          maxLength={120}
          onFocus={(event) => event.target.select()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              rename(card.saved!, event.currentTarget.value)
            } else if (event.key === 'Escape') {
              rename(card.saved!, null)
            }
          }}
          onBlur={(event) => rename(card.saved!, event.currentTarget.value)}
          className="glass-input h-5 w-full min-w-0 rounded-md px-1.5 text-center text-[12px] text-fg outline-none"
        />
      ) : (
        <div className="w-full truncate text-center text-[12px] text-fg">{card.displayName ?? card.name}</div>
      )}
      {card.saved && renaming !== card.saved.id && (
        <div className={cn('absolute top-3 right-3 flex gap-1', index === selected ? 'opacity-100' : 'reveal')} onDoubleClick={(event) => event.stopPropagation()}>
          <CardAction
            label={uiT("ui.6cb4f3ee4bfe", { value1: String(card.name) })}
            onClick={() => {
              setSelected(index)
              startRename(card.saved!)
            }}
          >
            <IconPencil size={13} />
          </CardAction>
          <CardAction
            label={uiT("ui.ff5250d441b2", { value1: String(card.name) })}
            onClick={() => {
              setSelected(index)
              setDeleting(card.saved!)
            }}
          >
            <IconTrash size={13} />
          </CardAction>
        </div>
      )}
    </div>
  )

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-black/35 p-6" onMouseDown={close}>
      <div role="dialog" aria-label={uiT("ui.1b2684405463")} className="float menu-surface flex max-h-full w-full max-w-[790px] flex-col rounded-2xl animate-pop" onMouseDown={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="px-5 pt-5 pb-3 text-[14px] font-medium text-fg">{uiT("ui.1b2684405463")}</div>
        <div role="listbox" aria-label={uiT("ui.56b564b75c7f")} className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          <div role="group" aria-label={uiT("ui.132979bd218e")} className="grid grid-cols-[repeat(auto-fill,140px)] justify-center gap-x-2 gap-y-1">
            {builtIn.map(cardView)}
          </div>
          <div role="group" aria-label={uiT("ui.bc183962239b")} className="pt-4">
            <div aria-hidden="true" className="px-1 pb-1.5 text-[11.5px] font-medium tracking-wide text-fg-3 uppercase">
              {uiT("ui.e1691b7d2e50")}</div>
            {saved.length ? (
              <div className="grid grid-cols-[repeat(auto-fill,140px)] justify-center gap-x-2 gap-y-1">{cards.slice(builtIn.length).map((card, index) => cardView(card, builtIn.length + index))}</div>
            ) : (
              <p className="px-1 text-[12px] text-fg-3">{uiT("ui.fad3e3e50c8f")}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          {deleting ? (
            <>
              <span className="min-w-0 flex-1 text-[12.5px] text-fg-2">{uiT("ui.abb4e32af48b")}{deleting.name}{uiT("ui.665f431608b0")}</span>
              <GlassButton variant="ghost" onClick={() => setDeleting(null)}>
                {uiT("ui.0ef70263b054")}</GlassButton>
              <GlassButton variant="danger" autoFocus onClick={() => remove(deleting)}>
                {uiT("ui.85941fb9c992")}</GlassButton>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-[12px] text-fg-3">{current?.description}</span>
              <GlassButton variant="ghost" onClick={close}>
                {uiT("ui.0ef70263b054")}</GlassButton>
              <GlassButton variant="primary" onClick={() => create(current)}>
                {uiT("ui.672ffa473180")}</GlassButton>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
