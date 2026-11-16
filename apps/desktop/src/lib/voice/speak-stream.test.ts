import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SpeakStream } from './speak-stream.ts'

let receive: (event: any) => void
const bridge = { open: vi.fn(), send: vi.fn(), close: vi.fn(), ack: vi.fn(), onEvent: vi.fn() }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('CloseEvent', class extends Event { code = 1000; wasClean = true })
  const browser = Object.assign(vi.fn(), { OPEN: 1 })
  vi.stubGlobal('WebSocket', browser)
  vi.stubGlobal('window', { heraldOS: { backendTransport: bridge, voice: { audioWsUrl: vi.fn().mockResolvedValue('ws://herald-main.invalid/speak-stream') } } })
  bridge.onEvent.mockImplementation(fn => { receive = fn; return vi.fn() })
  for (const method of [bridge.open, bridge.send, bridge.close, bridge.ack]) method.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())

it('uses the main bridge, preserves text/done order, and flushes stop before close', async () => {
  const ended = vi.fn(), stream = new SpeakStream({ onEnd: ended })
  stream.feed('Prüftext'); stream.done(); await tick()
  const id = bridge.open.mock.calls[0]![0]
  expect(bridge.open).toHaveBeenCalledWith(id, 'speak-stream')
  receive({ id, type: 'open' }); await stream.whenReady(); await tick()
  stream.stop(); await tick()
  expect(bridge.send.mock.calls.map(call => JSON.parse(call[1]))).toEqual([{ text: 'Prüftext' }, { done: true }, { stop: true }])
  expect(bridge.send.mock.invocationCallOrder.at(-1)).toBeLessThan(bridge.close.mock.invocationCallOrder[0]!)
  expect(ended).toHaveBeenCalledOnce(); expect(ended).toHaveBeenCalledWith('stopped', undefined)
  expect(WebSocket).not.toHaveBeenCalled()
  receive({ id, type: 'close', data: { code: 1000 } })
})

it('does not open a late audio transport after the user has already stopped', async () => {
  let resolveUrl!: (url: string) => void
  vi.mocked(window.heraldOS.voice.audioWsUrl).mockImplementation(() => new Promise(resolve => { resolveUrl = resolve }))
  const ended = vi.fn(), stream = new SpeakStream({ onEnd: ended })
  stream.stop(); resolveUrl('ws://herald-main.invalid/speak-stream'); await stream.whenReady()
  expect(bridge.open).not.toHaveBeenCalled(); expect(WebSocket).not.toHaveBeenCalled(); expect(ended).toHaveBeenCalledOnce()
})

it('reports main transport rejection without a renderer socket fallback', async () => {
  bridge.open.mockRejectedValue(new Error('identity mismatch'))
  const ended = vi.fn(), stream = new SpeakStream({ onEnd: ended })
  await stream.whenReady()
  expect(ended).toHaveBeenCalledWith('error', 'speak-stream connection failed'); expect(WebSocket).not.toHaveBeenCalled()
})
