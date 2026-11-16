import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc.ts'
import { fileURLToPath } from 'node:url'
import { WINDOWS_START_APPS } from '../catalog/windows.ts'

const edge = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), loginShellPath: vi.fn(), run: vi.fn(), execFile: vi.fn(), external: vi.fn(), apps: vi.fn(async () => [{ name: 'Installed Editor', path: 'C:\\Start\\Editor.lnk' }]) }))
vi.mock('electron', () => ({ app: { getAppPath: () => fileURLToPath(new URL('../..', import.meta.url)) }, ipcMain: { handle: (id: string, handler: (...args: any[]) => any) => edge.handlers.set(id, handler) }, shell: { openExternal: edge.external } }))
vi.mock('node:child_process', () => ({ execFile: edge.execFile }))
vi.mock('../platform/exec.ts', () => ({ run: edge.run }))
vi.mock('../platform/index.ts', () => ({ hostPlatform: () => ({ listInstalledApps: edge.apps }) }))
vi.mock('../backend/shell-env.ts', () => ({ loginShellPath: edge.loginShellPath }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))
const { registerCatalogIpc } = await import('./catalog.ts')
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); vi.resetAllMocks(); edge.handlers.clear() })

describe('Windows catalog IPC', () => {
  it('uses only the fixed native inventory query and never starts an application or installer', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    edge.run.mockResolvedValue({ code: 0, stdout: '[{"Name":"Packaged Editor","AppID":"Editor_id!App"}]', stderr: '' })
    registerCatalogIpc()
    const groups = await edge.handlers.get(IPC.catalogList)!({})
    expect(groups.find((group: { id: string }) => group.id === 'windows-apps').entries).toContainEqual(expect.objectContaining({ label: 'Installed Editor', installed: true }))
    expect(edge.apps).toHaveBeenCalledOnce()
    expect(groups.find((group: { id: string }) => group.id === 'windows-apps').entries).toContainEqual(expect.objectContaining({ label: 'Packaged Editor', installed: true }))
    for (const channel of [IPC.catalogInstall, IPC.catalogRemove]) {
      expect(await edge.handlers.get(channel)!({}, 'codex')).toMatchObject({ ok: false, output: expect.stringContaining('Windows installer') })
      expect(await edge.handlers.get(channel)!({}, 'codex & whoami')).toMatchObject({ ok: false, output: 'Not a catalog id' })
    }
    expect(edge.run).toHaveBeenCalledExactlyOnceWith('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_START_APPS], 8000, 2 * 1024 * 1024)
    expect(edge.execFile).not.toHaveBeenCalled()
    expect(edge.external).not.toHaveBeenCalled()
    expect(edge.loginShellPath).not.toHaveBeenCalled()
  })

  it('reports a failed native inventory instead of claiming there are no installed apps', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    edge.run.mockResolvedValue({ code: 1, stdout: '', stderr: 'unavailable' })
    registerCatalogIpc()
    await expect(edge.handlers.get(IPC.catalogList)!({})).rejects.toThrow('Windows application inventory failed')
  })
})
