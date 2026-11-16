import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as settleIo } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))

import { OsCommandBridge, OsControlServer, osControlToken, validOsControlToken } from './os-control.ts'
import { publishControlFile, removeControlFile } from '../backend/control-file.ts'

const servers: OsControlServer[] = []
const clients: net.Socket[] = []
const directories: string[] = []

function makeServer(handle: (request: Record<string, unknown>) => Promise<Record<string, unknown>> = async request => ({ ok: true, result: request.cmd }), transport: 'unix' | 'tcp' = 'tcp', socketPath = '') {
  const server = new OsControlServer(socketPath, handle, transport)
  servers.push(server)
  return server
}

async function connect(endpoint: string, authenticate = true): Promise<net.Socket> {
  const client = endpoint.startsWith('tcp://')
    ? net.createConnection({ host: '127.0.0.1', port: Number(new URL(endpoint).port) })
    : net.createConnection(endpoint)
  clients.push(client)
  await new Promise<void>((resolve, reject) => {
    client.once('connect', resolve)
    client.once('error', reject)
  })
  if (authenticate && endpoint.startsWith('tcp://')) {
    expect(await request(client, { cmd: 'auth', token: osControlToken() })).toEqual({ ok: true })
  }
  return client
}

function response(client: net.Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    const cleanup = () => {
      client.removeListener('data', onData)
      client.removeListener('close', onClose)
      client.removeListener('error', onError)
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onClose = () => onError(new Error('control connection closed without a reply'))
    const onData = (chunk: Buffer) => {
      data += chunk.toString('utf8')
      if (!data.includes('\n')) return
      cleanup()
      try { resolve(JSON.parse(data.slice(0, data.indexOf('\n'))) as Record<string, unknown>) }
      catch (error) { reject(error) }
    }
    client.on('data', onData)
    client.once('close', onClose)
    client.once('error', onError)
  })
}

function request(client: net.Socket, payload: unknown): Promise<Record<string, unknown>> {
  const reply = response(client)
  client.write(`${JSON.stringify(payload)}\n`)
  return reply
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const client of clients.splice(0)) client.destroy()
  await Promise.all(servers.splice(0).map(server => server.stop()))
  vi.useRealTimers()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('OS control loopback transport', () => {
  it('validates only the exact per-launch token', () => {
    const token = osControlToken()
    expect(validOsControlToken(token)).toBe(true)
    for (const other of [undefined, null, 0, {}, '', `${token}x`, token.slice(1), `${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`]) {
      expect(validOsControlToken(other)).toBe(false)
    }
  })
  it('publishes a bound loopback port and accepts the per-launch token', async () => {
    const server = makeServer()
    const endpoint = await server.start()
    expect(endpoint).toMatch(/^tcp:\/\/127\.0\.0\.1:[1-9][0-9]*$/)
    expect(await server.start()).toBe(endpoint)
    const client = await connect(endpoint)
    expect(client.remoteAddress).toBe('127.0.0.1')
    expect(await request(client, { cmd: 'ui-state', token: osControlToken() })).toEqual({ ok: true, result: 'ui-state' })
  })

  it.each([{}, { token: 'wrong' }, { token: 3 }, [], null, 3])('rejects unauthenticated or non-object input before dispatch: %j', async payload => {
    const handle = vi.fn(async () => ({ ok: true, result: '' }))
    const client = await connect(await makeServer(handle).start())
    expect((await request(client, payload)).ok).toBe(false)
    expect(handle).not.toHaveBeenCalled()
  })

  it.each([
    { cmd: 'ui-state', token: 'correct' },
    { cmd: 'auth', token: 'wrong' },
    { cmd: 'auth' }
  ])('requires TCP authentication before accepting a command: %j', async payload => {
    const handle = vi.fn(async () => ({ ok: true }))
    const client = await connect(await makeServer(handle).start(), false)
    expect((await request(client, { ...payload, token: payload.token === 'correct' ? osControlToken() : payload.token })).ok).toBe(false)
    expect(handle).not.toHaveBeenCalled()
  })

  it('accepts an authenticated inline-image frame larger than the old 1 MiB cutoff', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><desc>${'x'.repeat(1024 * 1024)}</desc><rect width="2" height="2" fill="red"/></svg>`
    const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    const handle = vi.fn(async (_request: Record<string, unknown>) => ({ ok: true }))
    const client = await connect(await makeServer(handle).start())
    expect((await request(client, { cmd: 'ui', command: 'canvas.addLayer', args: { source }, token: osControlToken() })).ok).toBe(true)
    expect(handle.mock.calls[0]?.[0]).toMatchObject({ command: 'canvas.addLayer', args: { source } })
    // This is a wire test, not evidence that Electron/Canvas can render large inline images.
  })

  it('handles fragmented UTF-8 and sequential requests on a connection', async () => {
    const client = await connect(await makeServer().start())
    const wire = Buffer.from(`${JSON.stringify({ cmd: 'café', token: osControlToken() })}\n`)
    const split = wire.indexOf(Buffer.from('é')) + 1
    const reply = response(client)
    client.write(wire.subarray(0, split))
    client.write(wire.subarray(split))
    expect(await reply).toEqual({ ok: true, result: 'café' })
    expect(await request(client, { cmd: 'ui-list', token: osControlToken() })).toEqual({ ok: true, result: 'ui-list' })
  })

  it('rejects invalid JSON and oversized unfinished frames without dispatch', async () => {
    const handle = vi.fn(async () => ({ ok: true, result: '' }))
    const endpoint = await makeServer(handle).start()
    const invalid = await connect(endpoint)
    const invalidReply = response(invalid)
    invalid.write('{broken\n')
    expect((await invalidReply).error).toContain('invalid JSON')
    const large = await connect(endpoint, false)
    const largeReply = response(large)
    large.write('x'.repeat(4097))
    expect((await largeReply).error).toBe('control request is too large')
    expect(handle).not.toHaveBeenCalled()
  })

  it('does not apply the input-frame deadline while an authenticated Canvas request runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let finish!: (reply: { ok: boolean; result: string }) => void
    let entered!: () => void
    const handling = new Promise<void>(resolve => { entered = resolve })
    const server = makeServer(async () => {
      entered()
      return await new Promise<{ ok: boolean; result: string }>(resolve => { finish = resolve })
    })
    const client = await connect(await server.start())
    const reply = request(client, { cmd: 'ui', command: 'canvas.render', token: osControlToken() })
    await handling
    await vi.advanceTimersByTimeAsync(90_000)
    expect(client.destroyed).toBe(false)
    finish({ ok: true, result: 'rendered' })
    expect(await reply).toEqual({ ok: true, result: 'rendered' })
  })

  it('bounds replies and converts handler failures into a protocol error', async () => {
    const large = await connect(await makeServer(async () => ({ result: 'x'.repeat(16 * 1024 * 1024) })).start())
    expect((await request(large, { token: osControlToken() })).error).toContain('command may already have completed')
    const failed = await connect(await makeServer(async () => { throw new Error('command failed') }).start())
    expect(await request(failed, { token: osControlToken() })).toEqual({ ok: false, error: 'command failed' })
  })

  it('closes incomplete connections at the input deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const client = await connect(await makeServer().start(), false)
    const closed = new Promise<void>(resolve => client.once('close', () => resolve()))
    client.write('{')
    await vi.advanceTimersByTimeAsync(5_000)
    await closed
  })

  it('does not let an authenticated peer extend an unfinished frame forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const handle = vi.fn(async () => ({ ok: true }))
    const client = await connect(await makeServer(handle).start())
    const closed = new Promise<void>(resolve => client.once('close', () => resolve()))
    client.write('{')
    await settleIo(20)
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(20_000)
      client.write(' ')
      await settleIo(20)
    }
    await vi.advanceTimersByTimeAsync(15_000)
    await closed
    expect(handle).not.toHaveBeenCalled()
  })

  it('releases a rejected half-open peer after flushing its error', async () => {
    const endpoint = await makeServer().start()
    const client = net.createConnection({ host: '127.0.0.1', port: Number(new URL(endpoint).port), allowHalfOpen: true })
    clients.push(client)
    await new Promise<void>(resolve => client.once('connect', resolve))
    const ended = new Promise<void>(resolve => client.once('end', resolve))
    expect((await request(client, { cmd: 'auth', token: 'wrong' })).ok).toBe(false)
    await ended
    // With allowHalfOpen, the client still has its write side. The server must release its slot.
    for (let index = 0; index < 32; index++) {
      const accepted = await connect(endpoint)
      expect((await request(accepted, { token: osControlToken() })).ok).toBe(true)
    }
  })

  it('closes a stalled handler after the Canvas reply allowance', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let entered!: () => void
    const handling = new Promise<void>(resolve => { entered = resolve })
    const client = await connect(await makeServer(async () => {
      entered()
      return await new Promise<Record<string, unknown>>(() => undefined)
    }).start())
    const closed = new Promise<void>(resolve => client.once('close', () => resolve()))
    client.write(`${JSON.stringify({ cmd: 'ui', token: osControlToken() })}\n`)
    await handling
    await vi.advanceTimersByTimeAsync(95_000)
    await closed
  })

  it('bounds simultaneous accepted connections', async () => {
    const endpoint = await makeServer().start()
    for (let index = 0; index < 32; index++) {
      const client = await connect(endpoint)
      expect((await request(client, { token: osControlToken() })).ok).toBe(true)
    }
    const extra = net.createConnection({ host: '127.0.0.1', port: Number(new URL(endpoint).port) })
    clients.push(extra)
    await new Promise<void>((resolve, reject) => {
      extra.once('close', () => resolve())
      extra.once('error', reject)
    })
  })

  it('closes owned connections on stop and can bind again', async () => {
    const server = makeServer()
    const client = await connect(await server.start())
    const closed = new Promise<void>(resolve => client.once('close', () => resolve()))
    await server.stop()
    await closed
    const next = await connect(await server.start())
    expect((await request(next, { cmd: 'ui-state', token: osControlToken() })).ok).toBe(true)
  })

  it('rejects publication when stopped during startup', async () => {
    const server = makeServer()
    const starting = expect(server.start()).rejects.toThrow('cancelled')
    await server.stop()
    await starting
  })
})

describe.skipIf(process.platform === 'win32')('Unix compatibility and ownership', () => {
  function socketPath(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hos-'))
    directories.push(directory)
    return path.join(directory, 'c.sock')
  }

  it('retains the Unix endpoint, private socket permissions and authenticated replies', async () => {
    const endpoint = socketPath()
    const server = makeServer(undefined, 'unix', endpoint)
    expect(await server.start()).toBe(endpoint)
    expect(fs.statSync(endpoint).mode & 0o777).toBe(0o600)
    const client = await connect(endpoint)
    expect((await request(client, { cmd: 'ui-state', token: osControlToken() })).ok).toBe(true)
    await server.stop()
    expect(fs.existsSync(endpoint)).toBe(false)
  })

  it('does not remove another live shell or a non-socket file', async () => {
    const endpoint = socketPath()
    await makeServer(undefined, 'unix', endpoint).start()
    const legacyFile = path.join(path.dirname(endpoint), 'control.json')
    const legacy = JSON.stringify({ socket: endpoint, token: 'older-controller-token' })
    fs.writeFileSync(legacyFile, legacy, { mode: 0o600 })
    await expect(makeServer(undefined, 'unix', endpoint).start()).rejects.toThrow('already listening')
    expect(fs.readFileSync(legacyFile, 'utf8')).toBe(legacy)
    expect((await request(await connect(endpoint), { cmd: 'ui-state', token: osControlToken() })).ok).toBe(true)
    const occupied = socketPath()
    fs.writeFileSync(occupied, 'keep')
    await expect(makeServer(undefined, 'unix', occupied).start()).rejects.toThrow('non-socket')
    expect(fs.readFileSync(occupied, 'utf8')).toBe('keep')
  })

  it('reclaims only a stale socket after a refused connection', async () => {
    const endpoint = socketPath()
    const oldPath = `${endpoint}.old`
    const old = net.createServer()
    await new Promise<void>(resolve => old.listen(oldPath, resolve))
    fs.renameSync(oldPath, endpoint)
    await new Promise<void>(resolve => old.close(() => resolve()))
    expect(fs.lstatSync(endpoint).isSocket()).toBe(true)
    const server = makeServer(undefined, 'unix', endpoint)
    expect(await server.start()).toBe(endpoint)
    expect((await request(await connect(endpoint), { cmd: 'ui-state', token: osControlToken() })).ok).toBe(true)
  })

  it('migrates a legacy file only for the Unix endpoint this desktop server actually bound', async () => {
    const endpoint = socketPath()
    const folder = path.dirname(endpoint)
    const file = path.join(folder, 'control.json')
    fs.writeFileSync(file, JSON.stringify({ socket: endpoint, token: 'old-token' }), { mode: 0o600 })
    const boundUnixSocket = await makeServer(undefined, 'unix', endpoint).start()
    const current = await publishControlFile(folder, { socket: boundUnixSocket, token: osControlToken() }, { boundUnixSocket })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ pid: process.pid, instance: current.instance, token: osControlToken() })
    expect(fs.readdirSync(folder).some(name => name.endsWith('.cleanup'))).toBe(false)
    await removeControlFile(current)
  })

  it.each(['missing proof', 'different proof', 'different socket', 'extra key', 'pid only', 'oversized', 'symlink'])(
    'preserves a legacy candidate with %s', async reason => {
      const endpoint = socketPath()
      const folder = path.dirname(endpoint)
      const file = path.join(folder, 'control.json')
      const bound = await makeServer(undefined, 'unix', endpoint).start()
      const data: Record<string, unknown> = { socket: reason === 'different socket' ? `${endpoint}.other` : endpoint, token: 'old-token' }
      if (reason === 'extra key') data.extra = true
      if (reason === 'pid only') data.pid = process.pid
      if (reason === 'oversized') data.token = 'x'.repeat(4096)
      const content = JSON.stringify(data)
      if (reason === 'symlink') {
        fs.writeFileSync(`${file}.personal`, content, { mode: 0o600 })
        fs.symlinkSync(`${file}.personal`, file)
      } else fs.writeFileSync(file, content, { mode: 0o600 })
      const boundUnixSocket = reason === 'missing proof' ? undefined : reason === 'different proof' ? `${bound}.other` : bound

      await expect(publishControlFile(folder, { socket: bound, token: osControlToken() }, { boundUnixSocket })).rejects.toThrow('unknown control file')
      expect(fs.readFileSync(file, 'utf8')).toBe(content)
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(reason === 'symlink')
    }
  )

  it('restores a legacy replacement with identical content but a different file identity', async () => {
    const endpoint = socketPath()
    const folder = path.dirname(endpoint)
    const file = path.join(folder, 'control.json')
    const content = JSON.stringify({ socket: endpoint, token: 'old-token' })
    fs.writeFileSync(file, content, { mode: 0o600 })
    const original = fs.lstatSync(file, { bigint: true })
    const boundUnixSocket = await makeServer(undefined, 'unix', endpoint).start()
    const realRename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((source, target) => {
      fs.writeFileSync(`${file}.replacement`, content, { mode: 0o600 })
      realRename(`${file}.replacement`, file)
      realRename(source, target)
    })

    await expect(publishControlFile(folder, { socket: boundUnixSocket, token: osControlToken() }, { boundUnixSocket })).rejects.toThrow('endpoint was restored')
    expect(fs.readFileSync(file, 'utf8')).toBe(content)
    expect(fs.lstatSync(file, { bigint: true }).ino).not.toBe(original.ino)
    expect(fs.readdirSync(folder).some(name => name.endsWith('.cleanup'))).toBe(true)
  })
})

it('retains the renderer Canvas timeout of 90 seconds', async () => {
  vi.useFakeTimers()
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const bridge = new OsCommandBridge(() => win as never)
  let completed = false
  const reply = bridge.run('canvas.render', {}, 'agent').then(value => { completed = true; return value })
  await vi.advanceTimersByTimeAsync(8_000)
  expect(completed).toBe(false)
  await vi.advanceTimersByTimeAsync(82_000)
  expect((await reply).error).toBe('The Hermes window did not answer in time.')
})
