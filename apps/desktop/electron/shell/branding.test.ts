import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn() } }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))
import { brandingDir, brandingView, setBranding } from './branding.ts'
const hostPlatform = process.platform
let root = ''
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-branding-'))
  vi.stubEnv('APPDATA', path.join(root, 'appdata'))
  vi.spyOn(os, 'homedir').mockReturnValue(root)
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  fs.rmSync(root, { recursive: true, force: true })
})
it('writes only local Herald branding and does not adopt or overwrite legacy and DRAGON branding', () => {
  const sentinels = [path.join(root, '.config', 'herald-os', 'branding', 'branding.json'), path.join(root, 'appdata', 'DRAGON OS', 'branding', 'branding.json')]
  for (const file of sentinels) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{"name":"protected"}') }
  expect(brandingView().name).toBeNull()
  expect(setBranding({ name: ' Herald test ' }).name).toBe('Herald test')
  expect(JSON.parse(fs.readFileSync(path.join(root, 'appdata', 'Herald OS', 'branding', 'branding.json'), 'utf8'))).toMatchObject({ name: 'Herald test' })
  for (const file of sentinels) expect(fs.readFileSync(file, 'utf8')).toBe('{"name":"protected"}')
  const logo = path.join(root, 'logo.png')
  fs.copyFileSync(new URL('../../build/icon.png', import.meta.url), logo)
  expect(setBranding({ logo }).logo).toMatch(/^data:image\/png;base64,/)
  expect(() => setBranding({ logo: path.join(root, 'unsupported.txt') })).toThrow('must be')
  expect(brandingView().name).toBe('Herald test')
})
it('uses native roaming AppData when APPDATA is absent', () => {
  vi.stubEnv('APPDATA', undefined)
  setBranding({ name: 'Fallback' })
  expect(fs.existsSync(path.join(root, 'AppData', 'Roaming', 'Herald OS', 'branding', 'branding.json'))).toBe(true)
})
it('retains the original non-Windows branding location and validation', () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  expect(brandingDir()).toBe(path.join(root, '.config', 'herald-os', 'branding'))
  setBranding({ name: ' Mac test ' })
  expect(JSON.parse(fs.readFileSync(path.join(root, '.config', 'herald-os', 'branding', 'branding.json'), 'utf8'))).toMatchObject({ name: 'Mac test' })
})
