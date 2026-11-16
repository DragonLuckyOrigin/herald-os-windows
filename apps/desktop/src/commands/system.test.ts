import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $settingsFocus } from '../features/settings/sections/shared.tsx'
import { matchIntent } from '../lib/voice/intents.ts'
import { $env, $prefs } from '../store/backend.ts'
import { $language } from '../store/i18n.ts'
import { type CommandContext, defineCommands, resetCommands, runCommand } from '../store/os-commands.ts'
import { commandGroups } from './index.ts'
import { systemCommands } from './system.ts'

// The stores read the preload bridge and the viewport when they load, and opening Settings asks
// whether motion is reduced; tests run without a DOM.
const opened = vi.hoisted(() => [] as string[])
const voiceEdges = vi.hoisted(() => ({
  hide: vi.fn<() => Promise<void>>(),
  show: vi.fn<() => Promise<void>>(),
  endConversation: vi.fn<(_reason?: 'user') => Promise<void>>(),
  endVoiceChat: vi.fn<() => Promise<'none'>>(),
  interruptSpeech: vi.fn(),
  startVoice: vi.fn<() => Promise<void>>(),
  toggleMute: vi.fn(),
  wake: { listening: true, paused: false, error: null as string | null }
}))

vi.mock('../store/voice.ts', () => ({
  endConversation: voiceEdges.endConversation,
  endVoiceChat: voiceEdges.endVoiceChat,
  interruptSpeech: voiceEdges.interruptSpeech,
  startVoice: voiceEdges.startVoice,
  toggleMute: voiceEdges.toggleMute
}))
vi.mock('../store/wake.ts', () => ({
  $wake: { get: () => voiceEdges.wake },
  setWakeWordEnabled: vi.fn(async () => undefined)
}))

vi.hoisted(() => {
  const prefs = { current: {} as Record<string, unknown> }
  Object.assign(globalThis, {
    window: {
      innerWidth: 1440,
      innerHeight: 900,
      matchMedia: () => ({ matches: true }),
      heraldOS: {
        prefs: { set: async (patch: Record<string, unknown>) => (prefs.current = { ...prefs.current, ...patch }) },
        window: { hide: voiceEdges.hide, show: voiceEdges.show },
        shell: { openExternal: async (url: string) => void opened.push(url) }
      }
    },
    document: { documentElement: { dataset: {}, style: { setProperty: () => undefined, removeProperty: () => undefined } } }
  })
})

const UI: CommandContext = { source: 'ui' }
const ENV = { platform: 'darwin' as const, hermesHome: '/h/.hermes', homeDir: '/h', version: '0.0.0', isDev: false, shellMode: 'desktop' as const }

beforeEach(() => {
  voiceEdges.hide.mockReset().mockResolvedValue(undefined)
  voiceEdges.show.mockReset().mockResolvedValue(undefined)
  voiceEdges.endConversation.mockReset().mockResolvedValue(undefined)
  voiceEdges.endVoiceChat.mockReset().mockResolvedValue('none')
  voiceEdges.interruptSpeech.mockReset()
  voiceEdges.startVoice.mockReset().mockResolvedValue(undefined)
  voiceEdges.toggleMute.mockReset()
  voiceEdges.wake = { listening: true, paused: false, error: null }
})

function command(id: string) {
  const found = systemCommands.find(entry => entry.id === id)

  if (!found) {
    throw new Error(`no command ${id}`)
  }

  return found
}

describe('the DRAGON sleep command', () => {
  beforeEach(() => {
    $env.set({ ...ENV, platform: 'win32' })
    resetCommands()
    defineCommands(systemCommands)
  })

  afterEach(() => $env.set(ENV))

  it.each(['Dragon Sleep', 'Dragon System Off'])('routes %s through one bounded sleep action', async phrase => {
    const intent = matchIntent(phrase)
    expect(intent).toMatchObject({ command: 'voice.sleep', args: {} })
    await expect(runCommand(intent!.command, intent!.args, UI)).resolves.toMatchObject({ ok: true, summary: 'Herald OS is sleeping' })

    expect(voiceEdges.hide).toHaveBeenCalledOnce()
    expect(voiceEdges.endConversation).toHaveBeenCalledExactlyOnceWith('user')
    expect(voiceEdges.endConversation.mock.invocationCallOrder[0]).toBeLessThan(voiceEdges.hide.mock.invocationCallOrder[0]!)
    expect(voiceEdges.show).not.toHaveBeenCalled()
    expect(voiceEdges.interruptSpeech).not.toHaveBeenCalled()
    expect(voiceEdges.endVoiceChat).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux'] as const)('fails closed on %s before ending or hiding', async platform => {
    $env.set({ ...ENV, platform })

    await expect(runCommand('voice.sleep', {}, UI)).resolves.toMatchObject({
      ok: false,
      error: 'DRAGON Sleep is available only on Windows.'
    })
    expect(voiceEdges.endConversation).not.toHaveBeenCalled()
    expect(voiceEdges.hide).not.toHaveBeenCalled()
    expect(voiceEdges.show).not.toHaveBeenCalled()
  })

  it('keeps the window visible while conversation teardown is still pending', async () => {
    let completeEnd!: () => void
    voiceEdges.endConversation.mockImplementationOnce(() => new Promise<void>(resolve => { completeEnd = resolve }))

    const sleep = runCommand('voice.sleep', {}, UI)

    expect(voiceEdges.endConversation).toHaveBeenCalledExactlyOnceWith('user')
    await Promise.resolve()
    expect(voiceEdges.hide).not.toHaveBeenCalled()
    completeEnd()
    await expect(sleep).resolves.toMatchObject({ ok: true, summary: 'Herald OS is sleeping' })
    expect(voiceEdges.hide).toHaveBeenCalledOnce()
  })

  it('ends the conversation even when the window cannot be hidden', async () => {
    const failure = new Error('window manager unavailable')
    voiceEdges.hide.mockRejectedValueOnce(failure)

    await expect(runCommand('voice.sleep', {}, UI)).resolves.toMatchObject({
      ok: false,
      error: 'Herald OS could not be hidden. The voice conversation ended; Herald OS remains visible.'
    })
    expect(voiceEdges.endConversation).toHaveBeenCalledExactlyOnceWith('user')
    expect(voiceEdges.show).toHaveBeenCalledOnce()
    expect(voiceEdges.interruptSpeech).not.toHaveBeenCalled()
    expect(voiceEdges.endVoiceChat).not.toHaveBeenCalled()
  })

  it('fails terminally without hiding when ending the conversation rejects', async () => {
    voiceEdges.endConversation.mockRejectedValueOnce(new Error('Synthetic end failure'))

    await expect(runCommand('voice.sleep', {}, UI)).resolves.toMatchObject({
      ok: false,
      error: 'The voice conversation could not be ended safely. Herald OS remains visible.'
    })
    expect(voiceEdges.hide).not.toHaveBeenCalled()
    expect(voiceEdges.endConversation).toHaveBeenCalledExactlyOnceWith('user')
    expect(voiceEdges.show).not.toHaveBeenCalled()
  })

  it('keeps the UI visible and reports a terminal failure when native wake did not rearm', async () => {
    voiceEdges.endConversation.mockImplementationOnce(async () => {
      voiceEdges.wake = { listening: false, paused: false, error: 'Synthetic wake failure' }
    })

    await expect(runCommand('voice.sleep', {}, UI)).resolves.toMatchObject({
      ok: false,
      error: 'Wake listening is unavailable. Herald OS remains visible.'
    })
    expect(voiceEdges.hide).not.toHaveBeenCalled()
    expect(voiceEdges.endConversation).toHaveBeenCalledExactlyOnceWith('user')
    expect(voiceEdges.show).not.toHaveBeenCalled()
  })

  it('does not attempt a potentially ambiguous hide when wake failed to rearm', async () => {
    voiceEdges.hide.mockRejectedValueOnce(new Error('Synthetic hide failure'))
    voiceEdges.endConversation.mockImplementationOnce(async () => {
      voiceEdges.wake = { listening: false, paused: false, error: 'Synthetic wake failure' }
    })

    await expect(runCommand('voice.sleep', {}, UI)).resolves.toMatchObject({
      ok: false,
      error: 'Wake listening is unavailable. Herald OS remains visible.'
    })
    expect(voiceEdges.hide).not.toHaveBeenCalled()
    expect(voiceEdges.show).not.toHaveBeenCalled()
  })

  it('keeps the UI visible when wake remains paused after the conversation ends', async () => {
    voiceEdges.endConversation.mockImplementationOnce(async () => {
      voiceEdges.wake = { listening: true, paused: true, error: null }
    })

    await expect(runCommand('voice.sleep', {}, UI)).resolves.toMatchObject({
      ok: false,
      error: 'Wake listening is unavailable. Herald OS remains visible.'
    })
    expect(voiceEdges.hide).not.toHaveBeenCalled()
    expect(voiceEdges.show).not.toHaveBeenCalled()
  })

  it('does not claim the UI is visible when hide and recovery show both fail', async () => {
    voiceEdges.hide.mockRejectedValueOnce(new Error('Synthetic hide failure'))
    voiceEdges.show.mockRejectedValueOnce(new Error('Synthetic show failure'))

    await expect(runCommand('voice.sleep', {}, UI)).resolves.toMatchObject({
      ok: false,
      error: 'Herald OS could not confirm that the window is visible. Reopen Herald OS.'
    })
  })
})

describe('the language command', () => {
  it('accepts German through the command schema and rejects invalid language codes', async () => {
    resetCommands()
    defineCommands(systemCommands)
    expect(await runCommand('language.set', { language: 'de-DE' }, UI)).toMatchObject({ ok: true })
    expect($prefs.get().language).toBe('de-DE')
    expect($language.get()).toBe('de-DE')
    expect(await runCommand('language.set', { language: 'de-XX' }, UI)).toMatchObject({ ok: false })
    expect($language.get()).toBe('de-DE')
  })
  beforeEach(() => {
    $env.set({ ...ENV, languages: ['zh-Hans-CN', 'en-US'] })
    $prefs.set({ ...$prefs.get(), language: undefined })
  })

  it('switches every string Herald translates, and goes back to following the system', async () => {
    expect($language.get()).toBe('zh-CN')

    expect(await command('language.set').run({ language: 'en' }, UI)).toMatchObject({ ok: true, summary: 'Herald OS is in English' })
    expect($prefs.get().language).toBe('en')
    expect($language.get()).toBe('en')

    expect(await command('language.set').run({ language: 'system' }, UI)).toMatchObject({ ok: true, summary: 'Herald OS follows the system language: 简体中文' })
    expect($language.get()).toBe('zh-CN')
  })

  it('opens the language setting under General', () => {
    command('settings.open').run({ section: 'language' }, UI)

    expect($settingsFocus.get()).toMatchObject({ section: 'general' })
  })
})

describe('the language on the voice fast path', () => {
  beforeEach(() => {
    resetCommands()
    defineCommands(Object.values(commandGroups).flat())
  })

  it('matches the language phrases against the whole catalogue', () => {
    expect(matchIntent('switch to chinese')).toMatchObject({ command: 'language.set', args: { language: 'zh-CN' } })
    expect(matchIntent('Hey Hermes, set the language to english')).toMatchObject({ command: 'language.set', args: { language: 'en' } })
    expect(matchIntent('use the system language')).toMatchObject({ command: 'language.set', args: { language: 'system' } })
    expect(matchIntent('switch to missions')).toMatchObject({ command: 'page.open' })
  })
})

describe('the Privacy & Security pane command', () => {
  beforeEach(() => {
    opened.length = 0
    resetCommands()
    defineCommands(systemCommands)
  })

  it('opens the pane a permission message names, on macOS', async () => {
    $env.set(ENV)

    expect(await runCommand('privacy.openPane', { pane: 'Camera' }, UI)).toMatchObject({ ok: true })
    expect(await runCommand('privacy.openPane', { pane: 'microphone' }, UI)).toMatchObject({ ok: true })
    expect(opened).toEqual(['x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Camera', 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone'])
  })

  it('refuses a pane it does not know, and opens nothing', async () => {
    $env.set(ENV)

    expect(await runCommand('privacy.openPane', { pane: 'users' }, UI)).toMatchObject({ ok: false })
    expect(await command('privacy.openPane').run({ pane: 'toString' }, UI)).toMatchObject({ ok: false })
    expect(opened).toEqual([])
  })

  it('opens nothing off macOS', async () => {
    $env.set({ ...ENV, platform: 'linux' })

    expect(await runCommand('privacy.openPane', { pane: 'camera' }, UI)).toMatchObject({ ok: false, error: 'System Settings panes exist only on macOS.' })
    expect(opened).toEqual([])
  })

  it('stays out of the command bar', () => {
    expect(command('privacy.openPane').hidden).toBe(true)
  })
})

describe('native Windows destinations', () => {
  beforeEach(() => {
    opened.length = 0
    resetCommands()
    defineCommands(systemCommands)
    $env.set({ ...ENV, platform: 'win32' })
  })

  it('opens the requested native Settings page and calendar through the guarded shell IPC', async () => {
    expect(await runCommand('settings.openWindows', { panel: 'audio' }, UI)).toMatchObject({ ok: true })
    expect(await runCommand('calendar.openNative', {}, UI)).toMatchObject({ ok: true })
    expect(opened).toEqual(['ms-settings:sound', 'ms-outlook:launch:calendar'])
  })

  it('rejects arbitrary URLs and prototype names before invoking the shell', async () => {
    for (const panel of ['toString', '__proto__', 'ms-settings:privacy', 'audio?x=1']) {
      expect(await command('settings.openWindows').run({ panel }, UI)).toMatchObject({ ok: false })
    }
    expect(opened).toEqual([])
  })

  it('does not open Windows destinations on another host', async () => {
    $env.set(ENV)
    expect(await runCommand('settings.openWindows', { panel: 'wifi' }, UI)).toMatchObject({ ok: false })
    expect(await runCommand('calendar.openNative', {}, UI)).toMatchObject({ ok: false })
    expect(opened).toEqual([])
  })

  it('returns native launch failures as a visible command error', async () => {
    window.heraldOS.shell.openExternal = async () => { throw new Error('No application handles this URL') }
    for (const [id, args] of [['calendar.openNative', {}], ['settings.openWindows', { panel: 'audio' }]] as const) {
      expect(await runCommand(id, args, UI)).toMatchObject({ ok: false, error: 'No application handles this URL' })
    }
  })
})
