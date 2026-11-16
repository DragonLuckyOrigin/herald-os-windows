import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import afterPack, { spawnHelpers } from './after-pack.mjs'

describe('afterPack', () => {
  let root = ''

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** A packed app whose node-pty has a spawn-helper, as npm leaves it (0644), in each of `dirs`. */
  function packed(platform: 'darwin' | 'linux', dirs: string[]) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-'))
    const resources = path.join(root, 'Herald OS.app', 'Contents', 'Resources')
    const pty = path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
    fs.mkdirSync(path.join(pty, 'prebuilds', 'win32-x64'), { recursive: true })
    fs.writeFileSync(path.join(pty, 'prebuilds', 'win32-x64', 'pty.node'), '')

    for (const dir of dirs) {
      fs.mkdirSync(path.join(pty, dir), { recursive: true })
      fs.writeFileSync(path.join(pty, dir, 'spawn-helper'), '')
      fs.chmodSync(path.join(pty, dir, 'spawn-helper'), 0o644)
    }

    const mode = (file: string) => fs.statSync(path.join(pty, file)).mode & 0o777

    return { pty, mode, context: { appOutDir: root, electronPlatformName: platform, packager: { getResourcesDir: () => resources } } }
  }

  it('makes every spawn-helper executable before the app is signed', async () => {
    const { pty, mode, context } = packed('darwin', ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release'])
    const helpers = ['prebuilds/darwin-arm64/spawn-helper', 'prebuilds/darwin-x64/spawn-helper', 'build/Release/spawn-helper']
    const originalModes = new Map(helpers.map(helper => [helper, fs.statSync(path.join(pty, helper)).mode]))
    const untouchedMode = mode('prebuilds/win32-x64/pty.node')

    expect(spawnHelpers(pty).map(file => path.relative(pty, file).split(path.sep).join('/')).sort()).toEqual(['build/Release/spawn-helper', 'prebuilds/darwin-arm64/spawn-helper', 'prebuilds/darwin-x64/spawn-helper'])
    const chmod = vi.spyOn(fs, 'chmodSync')
    await afterPack(context)

    for (const helper of helpers) {
      const call = chmod.mock.calls.find(([file]) => file === path.join(pty, helper))
      expect(call).toBeDefined()
      expect(call?.[1]).toBe(originalModes.get(helper)! | 0o755)
      if (process.platform !== 'win32') expect(mode(helper)).toBe(0o755)
    }
    expect(chmod).toHaveBeenCalledTimes(helpers.length)
    expect(chmod.mock.calls.some(([file]) => file === path.join(pty, 'prebuilds/win32-x64/pty.node'))).toBe(false)
    expect(mode('prebuilds/win32-x64/pty.node')).toBe(untouchedMode)
  })

  it('stops a Mac build that would ship no spawn-helper', async () => {
    const { context } = packed('darwin', [])

    await expect(afterPack(context)).rejects.toThrow(/spawn-helper/)
  })

  it('leaves a Linux build alone, where node-pty starts shells without one', async () => {
    const { context } = packed('linux', [])

    await expect(afterPack(context)).resolves.toBeUndefined()
  })

  it('runs for every build, and the helpers it fixes are unpacked from app.asar', () => {
    const { build } = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { build: { afterPack: string; asarUnpack: string[] } }

    expect(build.afterPack).toBe('scripts/after-pack.mjs')
    expect(build.asarUnpack).toEqual(expect.arrayContaining(['**/node-pty/prebuilds/**', '**/node-pty/build/Release/spawn-helper']))
  })
})
