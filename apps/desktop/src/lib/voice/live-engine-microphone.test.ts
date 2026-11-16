import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceHost } from './engine.ts'
import { VOICE_DEFAULTS } from '../../../shared/voice-prefs.ts'
import { $speakLevel } from './speak-stream.ts'

// The Live engine against a hold whose track is replaced after it was taken (a reopen while the
// session was still being set up): the sender must get the track open now, not the stale one.

const capture = vi.hoisted(() => ({
  current: null as unknown,
  release: vi.fn(),
  holder: null as { onTrack: (track: unknown) => void; onFailed: (error: Error) => void } | null,
  /** Resolves the hold once called; set to keep the hold pending until the test lets it go. */
  gate: null as Promise<void> | null
}))
const transport = vi.hoisted(() => ({ post: vi.fn(async () => ({ transport: { sdp: 'answer' } })) }))
vi.mock('../rest.ts', () => ({ rest: { post: transport.post } }))

vi.mock('./audio-capture.ts', () => ({
  MicrophoneUnavailableError: class extends Error {},
  setMicrophoneMuted: () => undefined,
  holdMicrophoneStream: async (holder: { onTrack: (track: unknown) => void; onFailed: (error: Error) => void }) => {
    capture.holder = holder
    const taken = capture.current

    if (capture.gate) {
      await capture.gate
    }

    return {
      // The stream as it was when the hold was taken; only `track` follows a reopen.
      stream: { id: 'stream', getAudioTracks: () => [taken] },
      get track() {
        return capture.current
      },
      release: capture.release
    }
  }
}))

const added: unknown[] = []
const replaceTrack = vi.fn(async (_track: unknown) => undefined)
const pauseAudio = vi.fn()
const closePeer = vi.fn()
let channel: FakeChannel
let channelState = 'connecting'
class FakeChannel {
  readyState = channelState
  send = vi.fn()
  close = vi.fn()
  listeners = new Map<string, (event: { data: string }) => void>()
  addEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, listener) }
  receive(event: unknown) { this.listeners.get('message')?.({ data: JSON.stringify(event) }) }
}
let offerResult: () => Promise<unknown> = () => Promise.reject(new Error('stop here'))

class FakePeerConnection {
  connectionState = 'new'
  iceGatheringState = 'complete'
  addEventListener() {}
  addTrack(track: unknown) {
    added.push(track)

    return { replaceTrack }
  }
  createDataChannel() {
    channel = new FakeChannel()
    return channel
  }
  localDescription = { sdp: 'v=0' }
  closed = false
  createOffer() {
    return offerResult()
  }
  setLocalDescription() {
    return Promise.resolve()
  }
  setRemoteDescription() { return Promise.resolve() }
  close() {
    this.closed = true
    closePeer()
  }
}

beforeEach(() => {
  added.length = 0
  channelState = 'connecting'
  replaceTrack.mockReset().mockResolvedValue(undefined)
  pauseAudio.mockClear()
  closePeer.mockClear()
  capture.release.mockClear()
  capture.gate = null
  transport.post.mockClear()
  offerResult = () => Promise.reject(new Error('stop here'))
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
  vi.stubGlobal(
    'Audio',
    class {
      autoplay = false
      pause = pauseAudio
    }
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const liveHost = () => ({
  prefs: () => ({ ...VOICE_DEFAULTS, liveIdleSeconds: 1 }),
  setState: vi.fn(), setCaptions: vi.fn(), setLiveSeconds: vi.fn(),
  submit: vi.fn(async (): Promise<string | null> => 'session'),
  runIntent: vi.fn(async () => ({ handled: false, spoken: '', ok: false })),
  interrupt: vi.fn(async () => {}), approvalPending: () => false,
  answerApproval: vi.fn(() => null), observeTurn: vi.fn(() => () => {}),
  ended: vi.fn(), notify: vi.fn(), recordLiveSeconds: vi.fn()
} satisfies VoiceHost)

async function openLive() {
  const { LiveEngine } = await import('./live-engine.ts')
  channelState = 'open'
  offerResult = async () => ({ sdp: 'offer', type: 'offer' })
  capture.current = { id: 'shared-track' }
  const host = liveHost()
  const engine = new LiveEngine(host)
  await engine.start()
  return { host, engine }
}

describe('LiveEngine open-channel teardown', () => {
  it('settles the existing close timeout without resetting a newer conversation meter', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-22T10:00:00Z'))
    const { engine, host } = await openLive()
    host.prefs = () => ({ ...VOICE_DEFAULTS, liveIdleSeconds: 60 })
    await vi.advanceTimersByTimeAsync(1000)
    await engine.stop()
    $speakLevel.set(0.7)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(closePeer).toHaveBeenCalledOnce()
    expect(capture.release).toHaveBeenCalledOnce()
    expect(host.recordLiveSeconds).toHaveBeenCalledExactlyOnceWith(16)
    expect($speakLevel.get()).toBe(0.7)
    expect(host.ended).not.toHaveBeenCalled()
    $speakLevel.set(0)
  })

  it('closes its peer and releases the hold if sender detach fails', async () => {
    const { engine, host } = await openLive()
    replaceTrack.mockRejectedValueOnce(new Error('synthetic detach failure'))
    await expect(engine.stop()).resolves.toBeUndefined()
    expect(closePeer).toHaveBeenCalledOnce()
    expect(capture.release).toHaveBeenCalledOnce()
    expect(pauseAudio).toHaveBeenCalledOnce()
    expect(host.ended).not.toHaveBeenCalled()
  })

  it.each(['interrupt', 'stop'] as const)('does not submit after an intent check settles following %s', async action => {
    const { engine, host } = await openLive()
    let settle!: () => void
    host.runIntent.mockImplementationOnce(() => new Promise(resolve => { settle = () => resolve({ handled: false, spoken: '', ok: false }) }))
    try {
      channel.receive({ type: 'session.input_transcript.delta', delta: 'check a synthetic task' })
      channel.receive({ type: 'session.delegation.created', delegation: { id: 'checking' } })
      expect(host.runIntent).toHaveBeenCalledOnce()
      await engine[action]()
      vi.clearAllMocks()
      settle()
      await Promise.resolve()
      await Promise.resolve()
      expect(host.submit).not.toHaveBeenCalled()
      expect(host.setState).not.toHaveBeenCalled()
      expect(channel.send).not.toHaveBeenCalled()
    } finally { await engine.stop(); channel.receive({ type: 'session.closed' }) }
  })

  it('silences and detaches only its own audio before the close acknowledgement, once', async () => {
    const { engine, host } = await openLive()
    try {
      await engine.stop()
      await engine.stop()
      expect(pauseAudio).toHaveBeenCalledOnce()
      expect(replaceTrack).toHaveBeenCalledExactlyOnceWith(null)
      expect(capture.release).toHaveBeenCalledOnce()
      expect(channel.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([{ type: 'session.close' }])
      // Closing accounting remains available; late cleanup must not silence a newer conversation.
      $speakLevel.set(0.6)
      channel.receive({ type: 'session.closed', usage: { seconds: 7 } })
      expect(host.recordLiveSeconds).toHaveBeenCalledExactlyOnceWith(7)
      expect(pauseAudio).toHaveBeenCalledOnce()
      expect(host.ended).not.toHaveBeenCalled()
      expect($speakLevel.get()).toBe(0.6)
      $speakLevel.set(0)
    } finally { channel.receive({ type: 'session.closed' }) }
  })

  it('ignores transcripts, commands, errors and idle callbacks while awaiting close', async () => {
    vi.useFakeTimers()
    const { engine, host } = await openLive()
    try {
      channel.receive({ type: 'session.input_transcript.delta', delta: 'stop' })
      await engine.stop()
      vi.clearAllMocks()
      channel.receive({ type: 'session.input_transcript.delta', delta: 'open settings' })
      channel.receive({ type: 'session.delegation.created', delegation: { id: 'late' } })
      channel.receive({ type: 'error', error: { message: 'late error' } })
      await vi.advanceTimersByTimeAsync(2000)
      expect(host.runIntent).not.toHaveBeenCalled()
      expect(host.submit).not.toHaveBeenCalled()
      expect(host.answerApproval).not.toHaveBeenCalled()
      expect(host.setState).not.toHaveBeenCalled()
      expect(host.setCaptions).not.toHaveBeenCalled()
      expect(host.notify).not.toHaveBeenCalled()
      expect(host.ended).not.toHaveBeenCalled()
    } finally { channel.receive({ type: 'session.closed' }) }
  })

  it.each(['interrupt', 'stop'] as const)('does not announce a failed request when a pending ACK settles after %s', async action => {
    const { engine, host } = await openLive()
    let settle!: (value: string | null) => void
    host.submit.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
    try {
      channel.receive({ type: 'session.input_transcript.delta', delta: 'what is the weather' })
      channel.receive({ type: 'session.delegation.created', delegation: { id: 'pending' } })
      await vi.waitFor(() => expect(host.submit).toHaveBeenCalledOnce())
      await engine[action]()
      vi.clearAllMocks()
      settle(null)
      await Promise.resolve()
      await Promise.resolve()
      expect(channel.send).not.toHaveBeenCalled()
      expect(host.setState).not.toHaveBeenCalled()
      expect(host.notify).not.toHaveBeenCalled()
    } finally { await engine.stop(); channel.receive({ type: 'session.closed' }) }
  })

  it('releases an old Hermes observer for a local route command while preserving its Live delegation confirmation', async () => {
    const { engine, host } = await openLive()
    const release = vi.fn()
    host.observeTurn.mockReturnValue(release)
    host.runIntent
      .mockResolvedValueOnce({ handled: false, spoken: '', ok: false })
      .mockImplementationOnce(async () => {
        engine.prepareLocalInterrupt()
        return { handled: true, spoken: 'Chat opened.', ok: true }
      })
    try {
      channel.receive({ type: 'session.input_transcript.delta', delta: 'first Hermes request' })
      channel.receive({ type: 'session.delegation.created', delegation: { id: 'old-turn' } })
      await vi.waitFor(() => expect(host.observeTurn).toHaveBeenCalledOnce())
      channel.send.mockClear()
      host.interrupt.mockClear()

      channel.receive({ type: 'session.input_transcript.delta', delta: 'open another chat' })
      channel.receive({ type: 'session.delegation.created', delegation: { id: 'route-command' } })
      await vi.waitFor(() => expect(channel.send).toHaveBeenCalled())

      const sent = channel.send.mock.calls.map(([raw]) => JSON.parse(raw))
      expect(release).toHaveBeenCalledOnce()
      expect(host.interrupt).not.toHaveBeenCalled()
      expect(sent).not.toContainEqual(expect.objectContaining({ type: 'session.instructions.append' }))
      expect(sent).toContainEqual(expect.objectContaining({ type: 'session.commentary.append', delegation_id: 'route-command', content: 'Chat opened.' }))
    } finally { await engine.stop(); channel.receive({ type: 'session.closed' }) }
  })
})

describe('LiveEngine microphone', () => {
  it.each(['offer', 'response'])('does not resume setup after stop during %s', async stage => {
    const { LiveEngine } = await import('./live-engine.ts')
    const setState = vi.fn()
    const host = new Proxy({}, { get: (_target, key) => key === 'setState' ? setState : vi.fn() }) as unknown as VoiceHost
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    offerResult = async () => {
      if (stage === 'offer') await gate
      return { sdp: 'offer', type: 'offer' }
    }
    if (stage === 'response') {
      transport.post.mockImplementationOnce(async () => { await gate; return { transport: { sdp: 'answer' } } })
    }
    capture.current = { id: 'track' }
    const engine = new LiveEngine(host)
    const starting = engine.start()
    await vi.waitFor(() => expect(stage === 'offer' ? added.length : transport.post.mock.calls.length).toBe(1))
    await engine.stop()
    release()
    await starting
    expect(setState).not.toHaveBeenCalledWith('listening')
    expect(capture.release).toHaveBeenCalledOnce()
    if (stage === 'offer') expect(transport.post).not.toHaveBeenCalled()
  })

  it('adds the track open at connect time, and releases the hold when setup fails', async () => {
    const { LiveEngine } = await import('./live-engine.ts')
    const host = new Proxy({}, { get: () => vi.fn() }) as unknown as VoiceHost
    const stale = { id: 'stale' }
    const fresh = { id: 'fresh' }
    capture.current = stale

    const engine = new LiveEngine(host)
    const starting = engine.start()

    // The reopen lands after the hold was taken but before the sender exists.
    capture.current = fresh
    capture.holder?.onTrack(fresh)

    await expect(starting).rejects.toThrow('stop here')
    expect(added).toEqual([fresh])
    expect(capture.release).toHaveBeenCalledTimes(1)
  })

  it('releases the hold, adds no track and ends quietly when stopped while the mic was opening', async () => {
    const { LiveEngine } = await import('./live-engine.ts')
    const ended = vi.fn()
    const host = new Proxy({}, { get: (_target, key) => (key === 'ended' ? ended : vi.fn()) }) as unknown as VoiceHost
    let open: () => void = () => undefined
    capture.gate = new Promise(resolve => (open = resolve))
    capture.current = { id: 'track' }

    const engine = new LiveEngine(host)
    const starting = engine.start()
    await engine.stop()
    open()

    await expect(starting).resolves.toBeUndefined()
    expect(added).toEqual([])
    expect(capture.release).toHaveBeenCalledTimes(1)
    expect(ended).not.toHaveBeenCalled()
  })

  it('ends the session and releases the mic when the microphone cannot be reopened', async () => {
    const { LiveEngine } = await import('./live-engine.ts')
    const ended = vi.fn()
    const host = new Proxy({}, { get: (_target, key) => (key === 'ended' ? ended : vi.fn()) }) as unknown as VoiceHost
    capture.current = { id: 'track' }
    // Leave the session mid-setup, so the failure arrives while the engine holds the mic.
    offerResult = () => new Promise(() => undefined)

    const engine = new LiveEngine(host)
    void engine.start()
    await vi.waitFor(() => expect(added).toHaveLength(1))

    capture.holder?.onFailed(Object.assign(new Error('Microphone access was denied.'), { name: 'MicrophoneUnavailableError' }))

    expect(capture.release).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledWith('error', 'The microphone stopped working: Microphone access was denied.')
  })
})
