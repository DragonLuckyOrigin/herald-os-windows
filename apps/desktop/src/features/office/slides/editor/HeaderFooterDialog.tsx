import { t as uiT, useT as useUiT, $language as $uiLanguage } from '../../../../store/i18n.ts'
import { useMemo, useState } from 'react'
import { GlassButton } from '../../../../components/ui/glass.tsx'
import { cn } from '../../../../lib/cn.ts'
import { Modal } from '../../shell/dialogs.tsx'
import { DATE_FORMATS, type DateFormat, type HeaderFooter } from '../deck.ts'
import type { SlidesDocument } from '../document.ts'
import { formatDate, headerFooterOf } from '../footers.ts'
import { SlideView } from '../view/SlideView.tsx'
import { applyHeaderFooter } from './master-commands.ts'

/*
 * What every slide shows in the master's date, footer and slide number places: the date of the day
 * in one of PowerPoint's formats (or a text that stays), the slide's number and a footer, left off
 * title slides when asked. The slide in front shows them as they are set.
 */

const PREVIEW_WIDTH = 196

export function HeaderFooterDialog({ doc, onClose }: { doc: SlidesDocument; onClose: () => void }) {
  useUiT()
  const deck = doc.presentation
  const [settings, setSettings] = useState<HeaderFooter>(() => ({ ...headerFooterOf(deck) }))
  const [fixed, setFixed] = useState(() => Boolean(headerFooterOf(deck).dateText))
  const [dateText, setDateText] = useState(() => headerFooterOf(deck).dateText ?? '')
  const today = useMemo(() => new Date(), [$uiLanguage.get(), ])
  const set = (patch: Partial<HeaderFooter>) => setSettings((now) => ({ ...now, ...patch }))
  const chosen = useMemo((): HeaderFooter => ({ ...settings, dateText: fixed ? dateText : '' }), [$uiLanguage.get(), settings, fixed, dateText])
  const slide = doc.mode === 'slides' ? doc.slide : deck.slides[0]
  const preview = useMemo(() => ({ ...deck, headerFooter: chosen }), [$uiLanguage.get(), deck, chosen])

  return (
    <Modal title={uiT("ui.aaf783850031")} onClose={onClose}>
      <div className="flex gap-4 text-[12px] text-fg-2">
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <label className="flex items-center gap-2 text-fg">
            <input type="checkbox" checked={settings.date} onChange={(event) => set({ date: event.target.checked })} />
            {uiT("ui.e3567b290c12")}</label>
          <fieldset disabled={!settings.date} className={cn('ml-5 flex flex-col gap-1.5', !settings.date && 'opacity-50')}>
            <label className="flex items-center gap-2">
              <input type="radio" name="hs-footer-date" checked={!fixed} onChange={() => setFixed(false)} />
              {uiT("ui.909f9cb49ae1")}</label>
            <select
              value={settings.dateFormat}
              onChange={(event) => set({ dateFormat: event.target.value as DateFormat })}
              disabled={fixed}
              aria-label={uiT("ui.43123f5ccaa8")}
              className="glass-input ml-5 h-7 rounded-md px-2 text-[12px] text-fg outline-none disabled:opacity-50"
            >
              {DATE_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {formatDate(format, today)}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2">
              <input type="radio" name="hs-footer-date" checked={fixed} onChange={() => setFixed(true)} />
              {uiT("ui.86b78cb48afc")}</label>
            <input
              value={dateText}
              onChange={(event) => setDateText(event.target.value)}
              disabled={!fixed}
              placeholder={formatDate(settings.dateFormat, today)}
              aria-label={uiT("ui.997fde9fafc7")}
              className="glass-input ml-5 h-7 rounded-md px-2 text-[12px] text-fg outline-none placeholder:text-fg-4 disabled:opacity-50"
            />
          </fieldset>
          <label className="flex items-center gap-2 text-fg">
            <input type="checkbox" checked={settings.number} onChange={(event) => set({ number: event.target.checked })} />
            {uiT("ui.1c092b4da0e3")}</label>
          <label className="flex items-center gap-2 text-fg">
            <input type="checkbox" checked={settings.footer} onChange={(event) => set({ footer: event.target.checked })} />
            {uiT("ui.90cfb69d8a19")}</label>
          <input
            value={settings.footerText}
            onChange={(event) => set({ footerText: event.target.value })}
            disabled={!settings.footer}
            placeholder={uiT("ui.0b02725af8b6")}
            aria-label={uiT("ui.0b02725af8b6")}
            className="glass-input ml-5 h-7 rounded-md px-2 text-[12px] text-fg outline-none placeholder:text-fg-4 disabled:opacity-50"
          />
          <label className="mt-1 flex items-center gap-2 text-fg">
            <input type="checkbox" checked={settings.skipTitle} onChange={(event) => set({ skipTitle: event.target.checked })} />
            {uiT("ui.5d7d7c6c06a4")}</label>
        </div>
        {slide && (
          <div className="flex shrink-0 flex-col gap-1">
            <span className="text-[11px] font-medium tracking-wide text-fg-3 uppercase">{uiT("ui.324b134f57c7")}</span>
            <SlideView deck={preview} slide={slide} scale={PREVIEW_WIDTH / deck.size.width} mode="thumb" className="pointer-events-none rounded-[3px] ring-1 ring-black/10" />
          </div>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <GlassButton variant="ghost" onClick={onClose}>
          {uiT("ui.0ef70263b054")}</GlassButton>
        <GlassButton
          variant="primary"
          onClick={() => {
            applyHeaderFooter(chosen, doc)
            onClose()
          }}
        >
          {uiT("ui.4d5d7549f92f")}</GlassButton>
      </div>
    </Modal>
  )
}
