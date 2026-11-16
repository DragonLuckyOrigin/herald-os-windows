import { afterEach, describe, expect, it, vi } from 'vitest'
import * as labels from './platform-labels.ts'
import { $env } from '../store/backend.ts'
import { shortcutLabel, voiceKeyLabel } from './platform-labels.ts'

const onPlatform = (platform: NodeJS.Platform) => $env.set({ platform, hermesHome: '/h/.hermes', homeDir: '/h', version: '0.0.0', isDev: false, shellMode: 'panels' })

afterEach(() => { $env.set(null); vi.unstubAllGlobals() })

describe('presentationPlatform', () => {
  it('uses the Herald identity on every platform, including before main reports', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' })
    expect(labels.desktopProductName()).toBe('Herald OS')
    expect(labels.desktopProductName('win32')).toBe('Herald OS')
    expect(labels.desktopProductName('darwin')).toBe('Herald OS')
    expect(labels.desktopProductName('linux')).toBe('Herald OS')
  })

  it('uses the reported platform before browser hints without changing operational hostPlatform', () => {
    expect(typeof labels.presentationPlatform).toBe('function')
    vi.stubGlobal('navigator', { platform: 'Win32' })
    expect(labels.presentationPlatform('darwin')).toBe('darwin')
    expect(labels.presentationPlatform('linux')).toBe('linux')
    expect(labels.presentationPlatform()).toBe('win32')
    expect(labels.hostPlatform()).toBe('darwin')
  })

  it.each([['Win32', 'win32'], ['Win64', 'win32'], ['MacIntel', 'darwin'], ['Linux x86_64', 'linux'], ['', undefined], ['Unknown', undefined]])('maps browser platform %s for presentation only', (platform, expected) => {
    expect(typeof labels.presentationPlatform).toBe('function')
    vi.stubGlobal('navigator', { platform })
    expect(labels.presentationPlatform()).toBe(expected)
  })

  it('does not disguise an explicitly reported unsupported platform as a Mac', () => {
    expect(typeof labels.presentationPlatform).toBe('function')
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(labels.presentationPlatform('freebsd')).toBeUndefined()
  })
})

describe('shortcutLabel', () => {
  it('spells shortcuts the Mac way on macOS', () => {
    onPlatform('darwin')

    expect(shortcutLabel('1')).toBe('⌘1')
    expect(shortcutLabel('A', { shift: true })).toBe('⌘⇧A')
  })

  it('names Ctrl on Herald OS Linux, which has no Command key', () => {
    onPlatform('linux')

    expect(shortcutLabel('K')).toBe('Ctrl+K')
    expect(shortcutLabel('A', { shift: true })).toBe('Ctrl+Shift+A')
  })
})

describe('voiceKeyLabel', () => {
  it('names the session hotkey on Linux, whatever the Electron hotkey says', () => {
    onPlatform('linux')

    expect(voiceKeyLabel('Alt+Space')).toBe('Super+V')
  })

  it('names the configured hotkey on macOS, and nothing when it is cleared', () => {
    onPlatform('darwin')

    expect(voiceKeyLabel('Alt+Space')).toBe('Alt+Space')
    expect(voiceKeyLabel(' ')).toBeUndefined()
  })
})
