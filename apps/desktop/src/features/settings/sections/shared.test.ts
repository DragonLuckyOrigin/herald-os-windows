import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { SettingsFilterContext, SettingsRow } from './shared.tsx'

it('filters using the German label, description and retained technical keywords', () => {
  const render = (query: string) => renderToStaticMarkup(createElement(SettingsFilterContext.Provider, { value: query }, createElement(SettingsRow, { label: 'Bewegung reduzieren', description: 'Animationen verringern', keywords: 'reduce motion animation' }, createElement('button', null, 'Ändern'))))
  expect(render('bewegung')).toContain('data-settings-row')
  expect(render('animation')).toContain('data-settings-row')
  expect(render('reduce motion')).toContain('data-settings-row')
  expect(render('unbekannt')).toBe('')
})

it('lets long labels and controls wrap while keeping the label before the control', () => {
  const html = renderToStaticMarkup(createElement(SettingsRow, { label: 'Eine besonders lange deutsche Einstellung' }, createElement('button', null, 'Einstellung ändern')))
  expect(html).toContain('flex-wrap')
  expect(html.indexOf('Eine besonders lange')).toBeLessThan(html.indexOf('<button'))
})
