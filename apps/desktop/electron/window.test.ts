import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HeraldOSPrefs } from '../shared/ipc.ts'

const harness = vi.hoisted(() => ({ options: null as Record<string, unknown> | null, root: '' }))

vi.mock('electron', () => ({
  app: { getAppPath: () => harness.root },
  BrowserWindow: class {
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), setZoomFactor: vi.fn() }
    loadFile = vi.fn(async () => undefined)
    loadURL = vi.fn(async () => undefined)
    once = vi.fn()
    show = vi.fn()

    constructor(options: Record<string, unknown>) {
      harness.options = options
    }
  },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  shell: { openExternal: vi.fn(async () => undefined) }
}))
vi.mock('./env.ts', () => ({ osEnv: () => undefined }))
vi.mock('./office/presenter.ts', () => ({ audienceWindow: () => null }))
vi.mock('./paths.ts', () => ({ devServerUrl: () => undefined, isShellPage: () => true, rendererIndex: () => 'index.html' }))

import { appIconPath, createMainWindow } from './window.ts'

const hostPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  harness.options = null
  if (harness.root) fs.rmSync(harness.root, { recursive: true, force: true })
  harness.root = ''
})

describe('the Windows main window', () => {
  it('keeps renderer microphone capture active while DRAGON OS is hidden for wake listening', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    createMainWindow({ fullscreenOnLaunch: false } as HeraldOSPrefs)

    expect(harness.options?.webPreferences).toMatchObject({
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    })
  })
})

it('selects the original Herald icon in source and packaged Windows layouts', () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  harness.root = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-window-icon-'))
  const sourceIcon = path.join(harness.root, 'build', 'icon.png')
  const packagedIcon = path.join(harness.root, 'dist', 'renderer', 'brand', 'herald-icon.png')
  for (const file of [sourceIcon, packagedIcon]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'icon fixture') }
  expect(appIconPath()).toBe(sourceIcon)
  fs.unlinkSync(sourceIcon)
  expect(appIconPath()).toBe(packagedIcon)
})
