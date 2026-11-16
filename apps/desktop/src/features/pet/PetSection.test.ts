import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => Object.assign(globalThis, { window: { heraldOS: {} }, document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } } }))
const { $prefs } = await import('../../store/backend.ts')
const { PetSection, PetCard } = await import('./PetSection.tsx')

it('renders the empty pet state and controls in German without starting gallery access', () => {
  $prefs.set({ ...$prefs.get(), language: 'de-DE' })
  const html = renderToStaticMarkup(createElement(PetSection))
  expect(html.includes('Begleiter anzeigen')).toBe(true)
  expect(html.includes('Begleiter finden')).toBe(true)
  expect(html.includes('Show the pet')).toBe(false)
})

it.each([['en', 'Install'], ['de-DE', 'Installieren']] as const)('keeps the install affordance in %s and distinguishes use and selected states', (language, label) => {
  $prefs.set({ ...$prefs.get(), language })
  const props = { slug: 'fixture', name: 'Original name', onPick() {} }
  const install = renderToStaticMarkup(createElement(PetCard, { ...props, action: 'install' }))
  expect(install).toContain(label)
  expect(install).toContain('tabler-icon-download')
  expect(install).toContain('Original name')
  const use = renderToStaticMarkup(createElement(PetCard, { ...props, action: 'use' }))
  expect(use).not.toContain('tabler-icon-download')
  const selected = renderToStaticMarkup(createElement(PetCard, { ...props, action: 'use', selected: true }))
  expect(selected).toContain('disabled=""')
  expect(selected).toContain('aria-pressed="true"')
  expect(selected).toContain('tabler-icon-check')
})

