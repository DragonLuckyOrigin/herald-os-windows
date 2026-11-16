import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_DEFAULTS } from '../../shared/voice-prefs.ts'

// The wake word's microphone feed after the capture graph could not reopen the microphone: it is
// told, says why it cannot hear, and clears that once frames arrive again.

const mic = vi.hoisted(() => ({
  frame: null as ((frame: { pcm: Int16Array; level: number; ms: number }) => void) | null,
  failed: null as ((error: Error) => void) | null,
  /** Why opening the microphone fails, or null when it opens. */
  refuse: null as Error | null
}))
const notified = vi.hoisted(() => [] as Array<{ title: string; actions?: unknown }>)
const wakeEdges = vi.hoisted(() => {
  const edges = {
    detected: null as (() => void) | null,
    failStart: null as Error | null,
    resumeSupported: false,
    show: vi.fn<() => Promise<void>>(),
    startVoice: vi.fn<(_source: 'wake') => Promise<void>>()
  }
  Object.assign(globalThis, { window: { heraldOS: { window: { show: edges.show } } } })

  return edges
})

vi.mock('../lib/voice/audio-capture.ts', () => {
  class MicrophoneUnavailableError extends Error {
    constructor(
      readonly reason: string,
      message: string
    ) {
      super(message)
    }
  }

  return {
    MicrophoneUnavailableError,
    microphoneDenied: (error: unknown) => error instanceof MicrophoneUnavailableError && error.reason === 'denied',
    subscribeMicrophone: async (frame: typeof mic.frame, failed: typeof mic.failed) => {
      if (mic.refuse) {
        throw mic.refuse
      }

      mic.frame = frame
      mic.failed = failed

      return () => undefined
    }
  }
})
vi.mock('../lib/voice/earcons.ts', () => ({ earcons: { wake: () => undefined } }))
vi.mock('./backend.ts', () => ({
  $prefs: atom({ voice: { ...VOICE_DEFAULTS, enabled: true, wakeWord: true } }),
  $env: atom({ platform: 'darwin' }),
  updatePrefs: async () => undefined
}))
vi.mock('./gateway.ts', () => ({
  $gatewayReady: atom(true),
  gatewayRequest: vi.fn(async (method: string) => {
    if (method === 'wake.resume') return { resumed: wakeEdges.resumeSupported }
    if (method !== 'wake.start') return {}
    if (wakeEdges.failStart) throw wakeEdges.failStart
    return { started: true, capture: 'client', phrase: 'hey hermes' }
  }),
  onGatewayEvent: (name: string, callback: () => void) => {
    if (name === 'wake.detected') wakeEdges.detected = callback
    return () => { if (wakeEdges.detected === callback) wakeEdges.detected = null }
  }
}))
vi.mock('./notifications.ts', () => ({ notify: (input: { title: string; actions?: unknown }) => void notified.push(input) }))
vi.mock('./shell.ts', () => ({ isMainSurface: true }))
vi.mock('./voice.ts', () => ({ startVoice: wakeEdges.startVoice }))

import { $prefs as $wakePrefs } from './backend.ts'

beforeEach(() => {
  mic.frame = null
  mic.failed = null
  mic.refuse = null
  notified.length = 0
  wakeEdges.detected = null
  wakeEdges.failStart = null
  wakeEdges.resumeSupported = false
  wakeEdges.show.mockReset().mockResolvedValue(undefined)
  wakeEdges.startVoice.mockReset().mockResolvedValue(undefined)
  $wakePrefs.set({ ...$wakePrefs.get(), voice: { ...VOICE_DEFAULTS, enabled: true, wakeWord: true } })
})

describe('wake word window activation', () => {
  it('shows the main window before starting the existing wake conversation', async () => {
    vi.resetModules()
    const { bindWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(wakeEdges.detected).not.toBeNull())
    await vi.waitFor(() => expect(mic.frame).not.toBeNull())

    wakeEdges.detected?.()
    await vi.waitFor(() => expect(wakeEdges.startVoice).toHaveBeenCalledExactlyOnceWith('wake'))

    expect(wakeEdges.show).toHaveBeenCalledOnce()
    expect(wakeEdges.show.mock.invocationCallOrder[0]).toBeLessThan(wakeEdges.startVoice.mock.invocationCallOrder[0]!)
  })

  it('keeps wake armed without starting a hidden voice session when the window cannot be shown', async () => {
    wakeEdges.show.mockRejectedValueOnce(new Error('window manager unavailable'))
    vi.resetModules()
    const { $wake, bindWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(mic.frame).not.toBeNull())

    wakeEdges.detected?.()
    await vi.waitFor(() => expect(wakeEdges.show).toHaveBeenCalledOnce())
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(wakeEdges.startVoice).not.toHaveBeenCalled()
    expect($wake.get()).toMatchObject({ listening: true, paused: false })

    wakeEdges.detected?.()
    await vi.waitFor(() => expect(wakeEdges.startVoice).toHaveBeenCalledExactlyOnceWith('wake'))
  })

  it('coalesces overlapping detections into one window activation and one conversation', async () => {
    let releaseShow!: () => void
    wakeEdges.show.mockReturnValueOnce(new Promise<void>(resolve => { releaseShow = resolve }))
    vi.resetModules()
    const { bindWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(mic.frame).not.toBeNull())

    wakeEdges.detected?.()
    wakeEdges.detected?.()
    await vi.waitFor(() => expect(wakeEdges.show).toHaveBeenCalledOnce())
    releaseShow()
    await vi.waitFor(() => expect(wakeEdges.startVoice).toHaveBeenCalledExactlyOnceWith('wake'))
  })

  it('contains a rejected conversation start and accepts the next wake event', async () => {
    wakeEdges.startVoice.mockRejectedValueOnce(new Error('Synthetic start failure'))
    vi.resetModules()
    const { bindWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(mic.frame).not.toBeNull())

    wakeEdges.detected?.()
    await vi.waitFor(() => expect(wakeEdges.startVoice).toHaveBeenCalledTimes(1))
    await new Promise<void>(resolve => setImmediate(resolve))
    wakeEdges.detected?.()
    await vi.waitFor(() => expect(wakeEdges.startVoice).toHaveBeenCalledTimes(2))
  })

  it('does nothing while wake listening is paused for a conversation', async () => {
    vi.resetModules()
    const { bindWake, pauseWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(mic.frame).not.toBeNull())
    await pauseWake()

    wakeEdges.detected?.()
    await Promise.resolve()

    expect(wakeEdges.show).not.toHaveBeenCalled()
    expect(wakeEdges.startVoice).not.toHaveBeenCalled()
  })

  it('drops a detected event that becomes stale while the window is being shown', async () => {
    let releaseShow!: () => void
    wakeEdges.show.mockReturnValueOnce(new Promise<void>(resolve => { releaseShow = resolve }))
    vi.resetModules()
    const { bindWake, pauseWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(mic.frame).not.toBeNull())

    wakeEdges.detected?.()
    await vi.waitFor(() => expect(wakeEdges.show).toHaveBeenCalledOnce())
    await pauseWake()
    const { resumeWake } = await import('./wake.ts')
    await resumeWake()
    releaseShow()
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(wakeEdges.startVoice).not.toHaveBeenCalled()
  })

  it('keeps a detection stale when resume falls back to a fresh arm without a preceding pause', async () => {
    let releaseShow!: () => void
    wakeEdges.show.mockReturnValueOnce(new Promise<void>(resolve => { releaseShow = resolve }))
    vi.resetModules()
    const { bindWake, resumeWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(mic.frame).not.toBeNull())

    wakeEdges.detected?.()
    await vi.waitFor(() => expect(wakeEdges.show).toHaveBeenCalledOnce())
    await resumeWake()
    releaseShow()
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(wakeEdges.startVoice).not.toHaveBeenCalled()
  })

  it('keeps the detector armed when the native resume succeeds', async () => {
    wakeEdges.resumeSupported = true
    vi.resetModules()
    const { $wake, bindWake, pauseWake, resumeWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect($wake.get().listening).toBe(true))
    await pauseWake()

    await resumeWake()

    expect($wake.get()).toMatchObject({ listening: true, paused: false, error: null })
  })

  it('keeps a detected event stale when settings disarm and then rearm wake while the window is being shown', async () => {
    let releaseShow!: () => void
    wakeEdges.show.mockReturnValueOnce(new Promise<void>(resolve => { releaseShow = resolve }))
    vi.resetModules()
    const { $wake, bindWake } = await import('./wake.ts')
    const { $prefs } = await import('./backend.ts')
    bindWake()
    await vi.waitFor(() => expect(mic.frame).not.toBeNull())

    wakeEdges.detected?.()
    await vi.waitFor(() => expect(wakeEdges.show).toHaveBeenCalledOnce())
    $prefs.set({ ...$prefs.get(), voice: { ...$prefs.get().voice, wakeWord: false } })
    await vi.waitFor(() => expect($wake.get().listening).toBe(false))
    $prefs.set({ ...$prefs.get(), voice: { ...$prefs.get().voice, enabled: true, wakeWord: true } })
    await vi.waitFor(() => expect($wake.get().listening).toBe(true))
    releaseShow()
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(wakeEdges.startVoice).not.toHaveBeenCalled()
  })

  it('marks wake unavailable when resume falls back to a fresh arm that throws', async () => {
    vi.resetModules()
    const { $wake, bindWake, pauseWake, resumeWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect($wake.get().listening).toBe(true))
    await pauseWake()
    wakeEdges.failStart = new Error('Synthetic wake start failure')

    await expect(resumeWake()).resolves.toBeUndefined()
    expect($wake.get()).toMatchObject({
      listening: false,
      paused: false,
      error: 'Wake word unavailable: Synthetic wake start failure'
    })
  })
})

describe('wake word after a failed microphone reopen', () => {
  it('reports that it cannot hear, and recovers when frames come back', async () => {
    vi.resetModules()
    const { $wake, bindWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(mic.failed).not.toBeNull())
    expect($wake.get()).toMatchObject({ listening: true, error: null })

    mic.failed?.(new Error('Microphone access was denied.'))
    expect($wake.get().error).toBe('Wake word cannot hear: Microphone access was denied.')

    mic.frame?.({ pcm: new Int16Array(1280), level: 0.1, ms: 80 })
    expect($wake.get().error).toBeNull()
  })

  it('keeps an error that did not come from the microphone when frames resume', async () => {
    vi.resetModules()
    const { $wake, bindWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(mic.failed).not.toBeNull())

    const owned = 'Another Hermes client (tui) owns the wake word.'
    $wake.set({ ...$wake.get(), error: owned })
    mic.frame?.({ pcm: new Int16Array(1280), level: 0.1, ms: 80 })
    expect($wake.get().error).toBe(owned)

    // A microphone failure that something else then overrides: frames resuming leave the newer error.
    mic.failed?.(new Error('Microphone access was denied.'))
    $wake.set({ ...$wake.get(), error: owned })
    mic.frame?.({ pcm: new Int16Array(1280), level: 0.1, ms: 80 })
    expect($wake.get().error).toBe(owned)
  })
})

describe('wake word when the microphone is refused', () => {
  it('offers to open the Microphone pane in System Settings', async () => {
    vi.resetModules()
    const { MicrophoneUnavailableError } = await import('../lib/voice/audio-capture.ts')
    mic.refuse = new MicrophoneUnavailableError('denied', 'Microphone access is denied. Allow Herald OS in System Settings > Privacy & Security > Microphone.')
    const { $wake, bindWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(notified).toHaveLength(1))

    expect(notified[0]).toMatchObject({ title: 'Wake word', actions: [{ label: 'Open System Settings', command: 'privacy.openPane', args: { pane: 'microphone' } }] })
    expect($wake.get()).toMatchObject({ listening: false, error: mic.refuse.message })
  })

  it('offers no button when the microphone failed for another reason', async () => {
    vi.resetModules()
    const { MicrophoneUnavailableError } = await import('../lib/voice/audio-capture.ts')
    mic.refuse = new MicrophoneUnavailableError('no-device', 'No microphone was found.')
    const { bindWake } = await import('./wake.ts')
    bindWake()
    await vi.waitFor(() => expect(notified).toHaveLength(1))

    expect(notified[0].actions).toBeUndefined()
  })
})
