import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => Object.assign(globalThis, { window: { heraldOS: {} } }))
import { HeraldLogo } from './herald-logo.tsx'
afterEach(() => vi.unstubAllGlobals())
it.each(['Win32', 'MacIntel'])('renders the authentic Herald mark on %s', platform => {
  vi.stubGlobal('navigator', { platform })
  const html = renderToStaticMarkup(createElement(HeraldLogo, { height: 36, className: 'brand-fixture' }))
  expect(html).toContain('herald-mark.png')
  expect(html).toContain('alt="Herald OS"')
  expect(html).toContain('height="36"')
  expect(html).toContain('brand-fixture')
  expect(html).not.toContain('dragon-mark.png')
})
