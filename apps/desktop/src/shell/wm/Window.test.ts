import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { $env, $prefs } from '../../store/backend.ts'
import { type OSWindow } from '../../store/windows.ts'
import { Window } from './Window.tsx'

// The real stores read the preload boundary and viewport. SSR does not mount effects or call IPC.
vi.hoisted(() => Object.assign(globalThis, {
  window: { innerWidth: 1440, innerHeight: 900, navigator: { languages: ['en-US'] }, heraldOS: {} }
}))

const env = (platform: NodeJS.Platform) => $env.set({ platform, hermesHome: '/test', homeDir: '/test', version: '0', isDev: false, shellMode: 'desktop' })
const win: OSWindow = { id: 'chat-1', appId: 'chat-popout', title: 'A chat', bounds: { x: 20, y: 50, width: 700, height: 500 }, z: 1, phase: 'open', maximized: false, payload: { sessionId: 'session-1' } }
const render = (patch: Partial<OSWindow> = {}, chrome = true) => renderToStaticMarkup(createElement(Window, { win: { ...win, ...patch }, chrome, children: 'Chat remains mounted' }))
const labels = (html: string) => [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map(match => match[1])

beforeEach(() => {
  env('win32')
  $prefs.set({ ...$prefs.get(), language: 'en' })
})

describe('Herald window controls', () => {
  it('shows Windows controls in the expected order and restores maximized windows', () => {
    expect(labels(render())).toEqual(['Minimize', 'Maximize', 'Close'])
    expect(labels(render({ maximized: true }))).toEqual(['Minimize', 'Restore', 'Close'])
    expect(labels(render({ id: 'main' }))).toEqual(['Minimize', 'Maximize', 'Hide'])
  })

  it('uses German accessible names without translating user chat titles', () => {
    $prefs.set({ ...$prefs.get(), language: 'de-DE' })
    const html = render({ title: 'My own title' })
    expect(labels(html)).toEqual(['Minimieren', 'Maximieren', 'Schließen'])
    expect(html).toContain('aria-label="My own title"')
  })

  it.each(['darwin', 'linux'] as const)('preserves the existing %s control variant', platform => {
    env(platform)
    expect(labels(render())).toEqual(['Close', 'Minimize', 'Zoom'])
  })

  it('keeps chat content mounted while minimized and respects chromeless windows', () => {
    expect(render({ phase: 'minimized' })).toContain('Chat remains mounted')
    expect(labels(render({}, false))).toEqual([])
  })
})
