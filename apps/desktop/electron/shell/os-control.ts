import { type BrowserWindow, ipcMain } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { type Duplex } from 'node:stream'
import { IPC, type OsControlReply, type OsControlRequest } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { WindowsControlPipe } from './windows-control-pipe.ts'

/*
 * OS control: how anything outside the renderer (the agent's `os_ui` tool through the bridge
 * plugin, the `herald-os` CLI) runs a command from the renderer's registry and gets the result.
 *
 * - `OsCommandBridge` is the main <-> renderer half: it posts an `OsControlRequest` to the Hermes
 *   window and resolves when the window replies (or times out).
 * - `OsControlServer` uses JSON-lines over a Unix socket or a protected Windows named pipe.
 *   In panels mode the existing `ControlSocket` hands `ui*` requests to `handleUiRequest`; in desktop mode the server
 *   runs on its own under the Herald OS data dir.
 *
 * Requests carry a per-launch token that main also gives the backend (HERALD_OS_CONTROL_TOKEN).
 * Windows and explicit legacy TCP clients authenticate with a small first frame and await its acknowledgement before sending
 * command data. Local connectivity is not authorization. Unix retains its existing wire format.
 */

const REPLY_TIMEOUT_MS = 8_000
/** Herald Canvas and Herald Office commands load, render and save whole images and documents. */
const CANVAS_TIMEOUT_MS = 90_000
const LONG_COMMAND = /^(canvas|docs|sheets|slides|office)\./

export class OsCommandBridge {
  private readonly pending = new Map<string, { resolve: (reply: OsControlReply) => void; timer: ReturnType<typeof setTimeout> }>()
  private counter = 0

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    ipcMain.on(IPC.osControlReply, (_event, reply: OsControlReply) => {
      const entry = this.pending.get(reply.requestId)

      if (entry) {
        clearTimeout(entry.timer)
        this.pending.delete(reply.requestId)
        entry.resolve(reply)
      }
    })
  }

  private send(request: { kind: 'run'; command: string; args: Record<string, unknown>; source: 'agent' | 'cli' | 'plugin' } | { kind: 'list' } | { kind: 'state' }): Promise<OsControlReply> {
    const win = this.getWindow()

    if (!win || win.isDestroyed()) {
      return Promise.resolve({ requestId: '', error: 'The Hermes window is not open.' })
    }

    const requestId = `oc${++this.counter}`
    const full = { ...request, requestId } as OsControlRequest

    const timeout = request.kind === 'run' && LONG_COMMAND.test(request.command) ? CANVAS_TIMEOUT_MS : REPLY_TIMEOUT_MS

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ requestId, error: 'The Hermes window did not answer in time.' })
      }, timeout)
      this.pending.set(requestId, { resolve, timer })
      win.webContents.send(IPC.osControlRequest, full)
    })
  }

  run(command: string, args: Record<string, unknown>, source: 'agent' | 'cli' | 'plugin'): Promise<OsControlReply> {
    return this.send({ kind: 'run', command, args, source })
  }

  list(): Promise<OsControlReply> {
    return this.send({ kind: 'list' })
  }

  state(): Promise<OsControlReply> {
    return this.send({ kind: 'state' })
  }
}

export interface UiControlRequest {
  cmd: string
  token?: string
  command?: string
  args?: unknown
  source?: string
}

let controlToken = ''

/** The per-launch token main hands to the backend and requires on `ui*` requests. */
export function osControlToken(): string {
  if (!controlToken) {
    controlToken = crypto.randomBytes(24).toString('base64url')
  }

  return controlToken
}

/** Reject non-strings and unequal lengths before comparing the secret in constant time. */
export function validOsControlToken(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const expected = Buffer.from(osControlToken(), 'utf8')
  const actual = Buffer.from(value, 'utf8')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

const UI_COMMANDS = new Set(['ui', 'ui-list', 'ui-state'])

export function isUiRequest(cmd: string): boolean {
  return UI_COMMANDS.has(cmd)
}

/** Serve one `ui*` request through the bridge; `null` when `cmd` is not a UI request. */
export async function handleUiRequest(request: UiControlRequest, bridge: OsCommandBridge): Promise<Record<string, unknown> | null> {
  if (!isUiRequest(request.cmd)) {
    return null
  }

  if (!validOsControlToken(request.token)) {
    return { ok: false, error: 'invalid control token' }
  }

  let reply: OsControlReply

  switch (request.cmd) {
    case 'ui': {
      if (!request.command || typeof request.command !== 'string') {
        return { ok: false, error: 'ui needs a command id' }
      }

      const args = request.args && typeof request.args === 'object' && !Array.isArray(request.args) ? (request.args as Record<string, unknown>) : {}
      reply = await bridge.run(request.command, args, request.source === 'cli' ? 'cli' : 'agent')

      break
    }
    case 'ui-list':
      reply = await bridge.list()

      break
    default:
      reply = await bridge.state()
  }

  if (reply.error) {
    return { ok: false, error: reply.error }
  }

  const result = reply.result

  if (request.cmd === 'ui' && result && typeof result === 'object') {
    return { ...(result as Record<string, unknown>) }
  }

  return { ok: true, result }
}

const MAX_AUTH_BYTES = 4096
// Provisional safety ceiling: Canvas's existing 512 MiB file-import bound, base64 encoded, plus
// 1 MiB of metadata. Inline data: URLs were unbounded upstream. This is NOT a proven V8/Electron
// transport limit or a parity claim; large-image E2E/memory qualification must settle the limit.
const MAX_REQUEST_BYTES = Math.ceil(512 * 1024 * 1024 * 4 / 3) + 1024 * 1024
// Canvas export/preview return file paths, not raster bytes. Metadata can still be large; this
// provisional reply ceiling also requires qualification against real documents and plugin results.
const MAX_REPLY_BYTES = 16 * 1024 * 1024
const MAX_CONNECTIONS = 32
const FRAME_TIMEOUT_MS = 5_000
const AUTHENTICATED_FRAME_IDLE_MS = 30_000
// This is a connection bound, not the renderer's command timeout. Leave time for a Canvas reply.
const CONNECTION_REPLY_TIMEOUT_MS = CANVAS_TIMEOUT_MS + 5_000

/** JSON-lines control transport. The endpoint is available only after start() resolves. */
export class OsControlServer {
  private server: net.Server | null = null
  private pipe: WindowsControlPipe | null = null
  private starting: Promise<string> | null = null
  private readonly connections = new Set<Duplex>()

  constructor(
    readonly socketPath: string,
    private readonly handle: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
    private readonly transport: 'unix' | 'tcp' | 'pipe' = process.platform === 'win32' ? 'pipe' : 'unix',
    private readonly failed?: (error: Error) => void
  ) {}

  start(): Promise<string> {
    if (this.starting) {
      return this.starting
    }

    if (this.transport === 'pipe') {
      const pipe = new WindowsControlPipe(connection => this.accept(connection), undefined, error => {
        if (this.pipe !== pipe) return
        this.pipe = null
        this.starting = null
        for (const connection of this.connections) connection.destroy()
        void pipe.stop().catch(() => undefined)
        log('os-control', `Windows listener failed: ${error.message}`)
        this.failed?.(error)
      })
      this.pipe = pipe
      const starting = pipe.start().then(endpoint => {
        if (this.pipe !== pipe || !pipe.securityVerified) throw new Error('Windows control pipe startup was cancelled or failed')
        return endpoint
      }).catch(async error => {
        if (this.pipe === pipe) this.pipe = null
        await pipe.stop().catch(() => undefined)
        if (this.starting === starting) this.starting = null
        throw error
      })
      this.starting = starting
      return starting
    }

    const server = net.createServer(connection => this.accept(connection))
    this.server = server
    const starting = new Promise<string>((resolve, reject) => {
      const failed = (error: Error) => {
        if (this.server === server) {
          this.server = null
        }
        reject(error)
      }
      server.once('error', failed)
      server.on('error', error => log('os-control', `socket error: ${error.message}`))
      const listening = () => {
        try {
          if (this.server !== server) {
            throw new Error('OS control startup was cancelled')
          }
          const address = server.address()
          if (!address) {
            throw new Error('OS control has no listening address')
          }
          if (this.transport === 'unix') {
            fs.chmodSync(this.socketPath, 0o600)
          }
          const endpoint = typeof address === 'string' ? address : `tcp://127.0.0.1:${address.port}`
          server.removeListener('error', failed)
          log('os-control', `listening on ${endpoint}`)
          resolve(endpoint)
        } catch (error) {
          server.close(() => failed(error instanceof Error ? error : new Error(String(error))))
        }
      }
      try {
        if (this.transport === 'tcp') {
          // Node's exclusive option prevents cluster sharing; it is not SO_EXCLUSIVEADDRUSE.
          server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, listening)
        } else {
          void this.prepareUnixSocket().then(() => {
            if (this.server !== server) {
              failed(new Error('OS control startup was cancelled'))
              return
            }
            server.listen(this.socketPath, listening)
          }).catch(failed)
        }
      } catch (error) {
        failed(error instanceof Error ? error : new Error(String(error)))
      }
    })
    this.starting = starting
    void starting.catch(() => {
      if (this.starting === starting) {
        this.starting = null
      }
    })

    return starting
  }

  async stop(): Promise<void> {
    const server = this.server
    const pipe = this.pipe
    const starting = this.starting
    this.server = null
    this.pipe = null
    for (const connection of this.connections) {
      connection.destroy()
    }
    await pipe?.stop()
    await starting?.catch(() => undefined)
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
    if (this.starting === starting) {
      this.starting = null
    }
    // Node removes its own Unix listening socket on close. Never unlink a replacement here.
  }

  private async prepareUnixSocket(): Promise<void> {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 })
    let existing: fs.Stats
    try {
      existing = fs.lstatSync(this.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!existing.isSocket()) {
      throw new Error('The OS control path is occupied by a non-socket file')
    }
    const stale = await new Promise<boolean>((resolve, reject) => {
      const probe = net.createConnection(this.socketPath)
      probe.setTimeout(FRAME_TIMEOUT_MS)
      probe.once('connect', () => { probe.destroy(); resolve(false) })
      probe.once('timeout', () => { probe.destroy(); reject(new Error('The existing OS control socket did not answer')) })
      probe.once('error', (error: NodeJS.ErrnoException) => {
        probe.destroy()
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(true)
        else reject(error)
      })
    })
    if (!stale) throw new Error('Another shell is already listening on the OS control socket')
    try {
      const current = fs.lstatSync(this.socketPath)
      if (!current.isSocket() || current.dev !== existing.dev || current.ino !== existing.ino) {
        throw new Error('The OS control socket changed during startup')
      }
      fs.unlinkSync(this.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private accept(connection: Duplex): void {
    if ((!this.server && !this.pipe) || this.connections.size >= MAX_CONNECTIONS) {
      connection.destroy()
      return
    }
    this.connections.add(connection)
    let chunks: Buffer[] = []
    let frameBytes = 0
    let queued: Buffer | null = null
    let authenticated = this.transport === 'unix'
    let busy = false
    let rejected = false
    let frameTimer: ReturnType<typeof setTimeout> | undefined
    let timer = setTimeout(() => connection.destroy(), authenticated ? AUTHENTICATED_FRAME_IDLE_MS : FRAME_TIMEOUT_MS)
    const deadline = (milliseconds: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => connection.destroy(), milliseconds)
    }
    const reject = (error: string) => {
      if (rejected || connection.destroyed) return
      rejected = true
      clearTimeout(frameTimer)
      chunks = []
      queued = null
      connection.end(`${JSON.stringify({ ok: false, error })}\n`, () => connection.destroy())
      // A peer that does not read the error cannot retain this socket indefinitely.
      deadline(FRAME_TIMEOUT_MS)
      connection.pause()
    }
    const consume = (chunk: Buffer) => {
      if (busy || rejected || connection.destroyed) return
      if (authenticated && !frameTimer) {
        // Idle resets cannot keep an unfinished authenticated frame alive indefinitely.
        frameTimer = setTimeout(() => connection.destroy(), CONNECTION_REPLY_TIMEOUT_MS)
      }
      const index = chunk.indexOf(10)
      const part = index < 0 ? chunk : chunk.subarray(0, index)
      if (frameBytes + part.length + (index < 0 ? 0 : 1) > (authenticated ? MAX_REQUEST_BYTES : MAX_AUTH_BYTES)) {
        reject('control request is too large')
        return
      }
      chunks.push(part)
      frameBytes += part.length
      if (authenticated) deadline(AUTHENTICATED_FRAME_IDLE_MS)
      if (index < 0) return
      clearTimeout(frameTimer)
      frameTimer = undefined
      let request: unknown
      try {
        // One concatenation per completed frame; growing frames do not recopy earlier chunks.
        request = JSON.parse(Buffer.concat(chunks, frameBytes).toString('utf8').trim())
      } catch {
        reject('invalid JSON or request exceeds the runtime string capacity')
        return
      }
      chunks = []
      frameBytes = 0
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        reject('request must be an object')
        return
      }
      if (!validOsControlToken((request as Record<string, unknown>).token)) {
        reject('invalid control token')
        return
      }
      if (!authenticated) {
        if ((request as Record<string, unknown>).cmd !== 'auth' || index !== chunk.length - 1) {
          reject('control requires an auth frame and acknowledgement before requests')
          return
        }
        busy = true
        connection.pause()
        connection.write('{"ok":true}\n', () => {
          if (connection.destroyed) return
          authenticated = true
          busy = false
          deadline(AUTHENTICATED_FRAME_IDLE_MS)
          connection.resume()
        })
        return
      }
      busy = true
      queued = index < chunk.length - 1 ? chunk.subarray(index + 1) : null
      connection.pause()
      deadline(CONNECTION_REPLY_TIMEOUT_MS)
      void this.handleRequest(request as Record<string, unknown>).then(reply => {
        if (connection.destroyed) return
        let encoded: string
        try {
          encoded = `${JSON.stringify(reply)}\n`
        } catch {
          reject('could not encode control reply')
          return
        }
        if (Buffer.byteLength(encoded) > MAX_REPLY_BYTES) {
          reject('control reply is too large; the command may already have completed. Check its result before retrying.')
          return
        }
        connection.write(encoded, () => {
          if (connection.destroyed) return
          busy = false
          deadline(AUTHENTICATED_FRAME_IDLE_MS)
          const next = queued
          queued = null
          if (next) consume(next)
          if (!busy) connection.resume()
        })
      })
    }
    connection.on('data', (chunk: Buffer) => {
      consume(chunk)
    })
    connection.on('error', () => undefined)
    connection.on('close', () => {
      clearTimeout(timer)
      clearTimeout(frameTimer)
      chunks = []
      queued = null
      this.connections.delete(connection)
    })
  }

  private async handleRequest(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await this.handle(request)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
