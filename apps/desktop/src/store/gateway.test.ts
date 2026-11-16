import { afterEach, expect, it, vi } from 'vitest'
import { JsonRpcGatewayClient } from '@herald-os/client'
import { backendSocket } from '../lib/backend-socket.ts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('runs the unchanged upstream RPC/event client over the main-owned transport', async () => {
  let receive!: (event: any) => void
  const bridge = { open: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), ack: vi.fn().mockResolvedValue(undefined), onEvent: vi.fn(fn => { receive = fn; return vi.fn() }) }
  vi.stubGlobal('window', { heraldOS: { backendTransport: bridge } })
  vi.stubGlobal('CloseEvent', class extends Event { code = 1000; wasClean = true })
  vi.stubGlobal('WebSocket', Object.assign(vi.fn(), { OPEN: 1 }))
  const client = new JsonRpcGatewayClient({ socketFactory: backendSocket }), ready = vi.fn()
  client.on('gateway.ready', ready)
  const connected = client.connect('ws://herald-main.invalid/gateway'), id = bridge.open.mock.calls[0]![0]
  receive({ id, type: 'open' }); await connected
  const response = client.request('fixture.echo', { text: 'unverändert' })
  await new Promise(resolve => setTimeout(resolve, 0))
  const request = JSON.parse(bridge.send.mock.calls[0]![1])
  receive({ id, type: 'message', data: { sequence: 1, payload: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { text: 'unverändert' } }) } })
  await expect(response).resolves.toEqual({ text: 'unverändert' })
  receive({ id, type: 'message', data: { sequence: 2, payload: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { fixture: true } } }) } })
  expect(ready).toHaveBeenCalledOnce(); expect(bridge.ack).toHaveBeenCalledWith(id, 2)
  expect(WebSocket).not.toHaveBeenCalled()
  client.close(); await new Promise(resolve => setTimeout(resolve, 0)); receive({ id, type: 'close', data: { code: 1000 } })
})

it('the actual gateway store cancels pending reconnects after terminal backend state', async () => {
  vi.resetModules();vi.useFakeTimers()
  let receive!: (event: any) => void
  const bridge = { open: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), ack: vi.fn().mockResolvedValue(undefined), onEvent: vi.fn(fn => { receive = fn; return vi.fn() }) }
  vi.stubGlobal('window', { heraldOS: { backendTransport: bridge } })
  vi.stubGlobal('CloseEvent', class extends Event { code = 1006; wasClean = false })
  vi.stubGlobal('WebSocket', Object.assign(vi.fn(), { OPEN: 1 }))
  const { bindGatewayToBackend, $connection } = await import('./gateway.ts')
  const { $backend } = await import('./backend.ts')
  const unbind = bindGatewayToBackend()
  try {
    $backend.set({ phase: 'ready', attempt: 0, logTail: [], wsUrl: 'ws://herald-main.invalid/gateway' })
    const id=bridge.open.mock.calls[0]![0]
    receive({id,type:'open'});await Promise.resolve()
    expect($connection.get()).toBe('open')
    receive({id,type:'error'})
    $backend.set({phase:'failed',attempt:0,logTail:[],error:'synthetic identity loss'})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(bridge.open).toHaveBeenCalledTimes(1);expect(WebSocket).not.toHaveBeenCalled()
    expect(['closed','error']).toContain($connection.get())
  } finally { $backend.set({phase:'stopped',attempt:0,logTail:[]});unbind() }
})
