import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AudioWsKind, BackendRuntime, BackendState, RestRequest } from '../../shared/ipc.ts'
import { osEnv } from '../env.ts'
import { log } from '../log.ts'
import { hermesHome, heraldOsDataDir } from '../paths.ts'
import { ensureBridgePlugin } from './bridge-plugin.ts'
import { type AttachTarget, type WindowsV3Policy, WindowsV3RoleError, attachTarget, foreignGateway, windowsAttachTarget, readWindowsV3Policy, readWindowsV3Discovery } from './coexist.ts'
import { HeldWindowsV3Identity, WindowsV3UnavailableError, localWindowsPath } from './connection-identity.ts'
import { AttachedTransport, ATTACHED_GATEWAY_URL, ATTACHED_AUDIO_URL } from './attached-transport.ts'
import { backendReadsLocalFiles } from './local-files.ts'
import { type ControlPublication, ControlCleanupError, ControlPublicationError, publishControlFile, removeControlFile } from './control-file.ts'
import { waitForStatus } from './probe.ts'
import { LineBuffer, parseReadyLine, readyFileName, staleReadyFiles } from './ready.ts'
import { pendingInstall, resolveBackendRuntime } from './resolve.ts'
import { withoutInheritedSession } from './session-env.ts'
import { loginShellPath } from './shell-env.ts'

class WindowsV3ProfileError extends Error {
  constructor() {
    super('SC1: Das laufende native Agentenprofil default konnte nicht bestätigt werden. Keine automatische Wiederholung, Profilumschaltung oder Datenverschiebung.')
  }
}

const READY_TIMEOUT_MS = 90_000
const STATUS_TIMEOUT_MS = 60_000
const MAX_RESTARTS = 4
const BACKOFF_MS = [1_000, 3_000, 7_000, 15_000]
const LOG_TAIL_LINES = 200
/** How often the shell looks again for a Hermes Agent to start while it waits for one. */
export const WAIT_POLL_MS = 3_000

/** What the boot screen says while there is no Hermes to start (`install`: the image's note, see pendingInstall). */
export function waitingReason(install: string | null): string {
  switch (install) {
    case null:
      return 'No Hermes runtime found. Install Hermes Agent (curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash) or set HERALD_OS_HERMES_ROOT; Herald OS starts it as soon as it is installed.'
    case 'offline':
      return 'Hermes Agent comes from the internet, and this computer was offline when it first started. Join a network and it installs by itself, which takes a few minutes; Herald OS starts it then.'
    case 'installing':
      return 'Installing Hermes Agent. It takes a few minutes; Herald OS starts it when it is ready.'
    case 'retrying':
      return 'Hermes Agent did not install, so it tries again in a few minutes (journalctl -u herald-os-hermes says why). Herald OS starts it when it is ready.'
    default:
      return 'Hermes Agent is not installed yet. It installs by itself once this computer is online; Herald OS starts it then.'
  }
}

export type BackendListener = (state: BackendState) => void

/**
 * Owns the `hermes serve` child: resolve -> spawn -> ready -> probe -> ready state, restart with
 * bounded backoff on unexpected exit, and REST forwarding that adds the token in main (ADR-007).
 */
export class BackendManager {
  private state: BackendState = { phase: 'idle', attempt: 0, logTail: [] }
  private child: ChildProcess | null = null
  private token = ''
  private attachedTransport: AttachedTransport | null = null
  private v3Abort: AbortController | null = null
  private v3Work: Promise<void> | null = null
  /** Control socket the bridge plugin's `os_ui` tool dials, and the token it must present. */
  private control: { socketPath: string; token: string; boundUnixSocket?: string } | null = null
  private controlPublication: ControlPublication | null = null
  private controlFileWork: Promise<void> = Promise.resolve()
  private listeners = new Set<BackendListener>()

  /** boundUnixSocket must come from the awaited desktop Unix listener, never a configured path. */
  setControl(socketPath: string, token: string, boundUnixSocket?: string): void {
    this.control = { socketPath, token, boundUnixSocket }
  }
  private stopping = false
  private startGeneration = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private waitTimer: ReturnType<typeof setInterval> | null = null
  private readonly tail: string[] = []

  getState(): BackendState {
    return { ...this.state, logTail: this.tail.slice(-LOG_TAIL_LINES) }
  }

  /** Process id of the running `hermes serve`, if any. */
  childPid(): number | null {
    return this.child?.pid ?? null
  }

  onState(listener: BackendListener): () => void {
    this.listeners.add(listener)
    listener(this.getState())

    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    // Startup can follow an early restart before the verified control endpoint was supplied.
    try {
      await this.restart()
    } catch (error) {
      // Main starts this in the background; restart has already published the failed state.
      log('backend', `startup cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** User-driven restart: resets the attempt budget. */
  async restart(): Promise<void> {
    log('backend', 'restart requested')
    this.stopping = true
    this.clearRestartTimer()
    this.clearWaitTimer()
    const killing = this.killChild()
    const generation = this.startGeneration
    try {
      await killing
      if (generation !== this.startGeneration) return
      await this.clearControlFile()
    } catch (error) {
      if (generation === this.startGeneration) this.update({ phase: 'failed', error: error instanceof Error ? error.message : String(error), wsUrl: undefined, baseUrl: undefined, port: undefined })
      throw error
    }
    if (generation !== this.startGeneration) return
    this.stopping = false
    await this.launch(0)
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearRestartTimer()
    this.clearWaitTimer()
    const killing = this.killChild()
    const generation = this.startGeneration
    try {
      await killing
      if (generation !== this.startGeneration) return
      await this.clearControlFile()
    } catch (error) {
      if (generation === this.startGeneration) this.update({ phase: 'failed', error: error instanceof Error ? error.message : String(error), wsUrl: undefined, baseUrl: undefined, port: undefined })
      throw error
    }
    if (generation === this.startGeneration) this.update({ phase: 'stopped', error: undefined, wsUrl: undefined, baseUrl: undefined, port: undefined })
  }

  private queueControlFile(work: () => Promise<void>): Promise<void> {
    const next = this.controlFileWork.then(work)
    // Report this failure to its caller, but let the next operation retry. A failed removal keeps
    // controlPublication set until its own cleanup succeeds; an old error is not pending work.
    this.controlFileWork = next.catch(() => undefined)
    return next
  }

  private clearControlFile(): Promise<void> {
    return this.queueControlFile(() => this.removeControlPublication())
  }

  /** Only call within controlFileWork: a failed unlink may move ownership to a verified tombstone. */
  private async removeControlPublication(): Promise<void> {
    if (!this.controlPublication) return
    try {
      await removeControlFile(this.controlPublication)
      this.controlPublication = null
    } catch (error) {
      if (error instanceof ControlCleanupError) this.controlPublication = error.publication
      throw error
    }
  }

  /**
   * Windows returns a secret-free main-transport marker. Other platforms retain the existing
   * tokenized loopback audio contract (ADR-007 amendment).
   */
  audioWsUrl(kind: AudioWsKind): string {
    if (process.platform === 'win32') {
      if (kind !== 'speak-stream' || this.state.phase !== 'ready' || !this.attachedTransport) throw new Error('SC1 authenticated audio transport unavailable')
      return ATTACHED_AUDIO_URL
    }
    const { port, phase } = this.state

    if (!port || phase !== 'ready') {
      throw new Error('Hermes backend is not ready')
    }

    const paths: Record<AudioWsKind, string> = { 'speak-stream': '/api/audio/speak-stream' }

    return `ws://127.0.0.1:${port}${paths[kind]}?token=${encodeURIComponent(this.token)}`
  }

  async rest<T>(request: RestRequest): Promise<T> {
    if (process.platform === 'win32') {
      if (this.state.phase !== 'ready' || !this.attachedTransport) throw new Error('SC1 authenticated transport unavailable')
      return this.attachedTransport.rest<T>(request)
    }
    const { baseUrl } = this.state

    if (!baseUrl || this.state.phase !== 'ready') {
      throw new Error('Hermes backend is not ready')
    }

    if (!request.path.startsWith('/api/')) {
      throw new Error(`refusing REST path outside /api: ${request.path}`)
    }

    const url = new URL(baseUrl + request.path)

    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value))
      }
    }

    const response = await fetch(url, {
      method: request.method,
      headers: {
        'X-Hermes-Session-Token': this.token,
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(60_000)
    })

    const text = await response.text()

    if (!response.ok) {
      let detail = response.statusText

      try {
        const parsed = JSON.parse(text) as { detail?: unknown; error?: unknown }
        detail = String(parsed.detail ?? parsed.error ?? detail)
      } catch {
        detail = text || detail
      }

      throw new Error(`${request.method} ${request.path} -> ${response.status}: ${detail}`)
    }

    return (text ? JSON.parse(text) : null) as T
  }

  private async launch(attempt: number): Promise<void> {
    if (this.stopping) return
    const generation = ++this.startGeneration
    this.clearWaitTimer()
    this.update({ phase: attempt === 0 ? 'resolving' : 'restarting', attempt, error: undefined, install: undefined, localFiles: undefined })

    // Windows is unconditionally attach-only, including Explorer launches without environment.
    // This branch precedes install/runtime/plugin discovery and every managed Core side effect.
    if (process.platform === 'win32') {
      if(process.env.HERALD_OS_ATTACH_CONFIG===undefined) {
        try {await this.acquireWindowsV3(readWindowsV3Policy(),generation,0,Date.now())}
        catch {if(generation===this.startGeneration)this.update({phase:'failed',error:'SC1: Geschützte V3-Verbindungspolicy fehlt oder ist ungültig.',wsUrl:undefined,baseUrl:undefined,port:undefined})}
        return
      }
      await this.attachWindows(generation)
      return
    }

    let attach: AttachTarget | null

    try {
      attach = attachTarget()
    } catch (error) {
      this.update({ phase: 'failed', error: error instanceof Error ? error.message : String(error) })

      return
    }

    if (attach) {
      await this.attach(attach, attempt, generation)

      return
    }

    if (process.env.HERALD_OS_REQUIRE_ATTACHED_BACKEND === '1') {
      this.update({ phase: 'failed', error: 'This launch requires an existing Hermes backend, but no attach URL was provided.' })

      return
    }

    const install = pendingInstall()
    const runtime = install ? null : resolveBackendRuntime()

    if (!runtime) {
      this.wait(install, generation)

      return
    }

    this.update({ runtime, phase: 'starting' })

    try {
      const bridgeError = (await ensureBridgePlugin(runtime)) ?? undefined
      if (generation !== this.startGeneration || this.stopping) return
      const port = await this.spawnServe(runtime, generation)

      if (generation !== this.startGeneration) {
        return
      }

      const baseUrl = `http://127.0.0.1:${port}`
      await waitForStatus(baseUrl, this.token, STATUS_TIMEOUT_MS)

      if (generation !== this.startGeneration) {
        return
      }

      const wsUrl = `ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(this.token)}`
      this.update({ phase: 'ready', port, baseUrl, wsUrl, error: undefined, sharedGateway: this.sharedGateway()?.pid, bridgeError, localFiles: true })
      log('backend', `ready on ${baseUrl} via ${runtime.label}`)
    } catch (error) {
      if (generation !== this.startGeneration) {
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      log('backend', `start failed: ${message}`)
      const killing = this.killChild()
      const retryGeneration = this.startGeneration
      try {
        await killing
      } catch (cleanupError) {
        if (retryGeneration === this.startGeneration) {
          this.stopping = true
          const cleanup = `Could not confirm backend exit: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
          log('backend', cleanup)
          this.update({ phase: 'failed', error: `${message}; ${cleanup}`, wsUrl: undefined, baseUrl: undefined, port: undefined })
        }
        return
      }
      if (retryGeneration !== this.startGeneration || this.stopping) return
      this.scheduleRestart(attempt, message)
    }
  }

  /**
   * No Hermes to start: say why, and look again every few seconds. On the image that means waiting
   * for firstboot.sh's note to go (Hermes is installed and set up then); elsewhere, for one to resolve.
   */
  private wait(install: string | null, generation: number): void {
    if (process.platform === 'win32') { this.update({ phase: 'failed', error: 'SC1: Windows startet keinen Hermes Core.' }); return }
    log('backend', install ? `waiting for Hermes Agent to be installed (${install})` : 'no Hermes runtime found; waiting for one to be installed')
    this.update({ phase: 'waiting', runtime: undefined, install: install ?? undefined, error: waitingReason(install) })
    this.waitTimer = setInterval(() => {
      if (generation !== this.startGeneration) {
        this.clearWaitTimer()

        return
      }

      const now = pendingInstall()

      if (!now && resolveBackendRuntime()) {
        log('backend', 'Hermes Agent is installed; starting it')
        void this.launch(0)
      } else if ((now ?? undefined) !== this.state.install) {
        this.update({ install: now ?? undefined, error: waitingReason(now) })
      }
    }, WAIT_POLL_MS)
  }

  /** Use a backend that is already running (HERALD_OS_BACKEND_URL) instead of starting a second one. */
  private async attach(target: AttachTarget, attempt: number, generation: number): Promise<void> {
    this.update({ runtime: { kind: 'attached', label: `the Hermes backend at ${target.baseUrl}`, command: [] }, phase: 'starting' })

    try {
      this.token = target.token
      await waitForStatus(target.baseUrl, this.token, STATUS_TIMEOUT_MS)

      if (generation !== this.startGeneration) {
        return
      }

      // It did not get our control socket in its environment; the bridge plugin reads this instead.
      if (this.control) {
        const control = this.control
        try {
          await this.queueControlFile(async () => {
            if (generation !== this.startGeneration) return
            await this.removeControlPublication()
            let publication: ControlPublication
            try {
              publication = await publishControlFile(heraldOsDataDir(), { socket: control.socketPath, token: control.token }, {
                boundUnixSocket: control.boundUnixSocket,
                warn: message => log('backend', message)
              })
            } catch (error) {
              // A linked publication can survive a failed rollback. Keep its verified owner record
              // inside the serialized work item so restart/stop can retry exactly that cleanup.
              if (error instanceof ControlPublicationError) this.controlPublication = error.publication
              throw error
            }
            this.controlPublication = publication
            if (generation !== this.startGeneration) {
              await this.removeControlPublication()
            }
          })
        } catch (error) {
          const message = `Could not publish private OS control: ${error instanceof Error ? error.message : String(error)}`
          log('backend', message)
          if (generation === this.startGeneration) {
            this.update({ phase: 'failed', error: message, wsUrl: undefined, baseUrl: undefined, port: undefined })
          }
          return
        }
      }

      const reads = await backendReadsLocalFiles(target.baseUrl, this.token, heraldOsDataDir())

      if (generation !== this.startGeneration) {
        return
      }

      // Until it shows that it reads this computer's files, an attached Hermes may run anywhere: a tunnel's end is a loopback address too.
      const localFiles = reads === true
      const url = new URL(target.baseUrl)
      const port = Number(url.port) || 80
      this.update({ phase: 'ready', port, baseUrl: target.baseUrl, wsUrl: `ws://${url.host}/api/ws?token=${encodeURIComponent(this.token)}`, error: undefined, sharedGateway: undefined, bridgeError: undefined, localFiles })
      const files = reads === true ? '' : `; ${reads === false ? "it does not read this computer's files" : "it could not be asked whether it reads this computer's files (an older Hermes?)"}, so attachments are uploaded to it`
      log('backend', `attached to ${target.baseUrl}${files}`)
    } catch (error) {
      if (generation === this.startGeneration) {
        this.scheduleRestart(attempt, `could not reach ${target.baseUrl}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** One admission at a time, using the existing manager's generation and retry timer.
   * Native discovery is read-only; this branch never discovers a runtime to start. */
  private acquireWindowsV3(policy:WindowsV3Policy,generation:number,attempt:number,waitingSince:number):Promise<void> {
    if(this.v3Work || this.stopping || generation!==this.startGeneration)return Promise.resolve()
    const abort=new AbortController();this.v3Abort=abort
    const work=this.admitWindowsV3(policy,generation,attempt,waitingSince,abort.signal)
    this.v3Work=work
    return work.finally(()=>{if(this.v3Work===work)this.v3Work=null;if(this.v3Abort===abort)this.v3Abort=null})
  }

  private async admitWindowsV3(policy:WindowsV3Policy,generation:number,attempt:number,waitingSince:number,signal:AbortSignal):Promise<void> {
    let identity:HeldWindowsV3Identity|undefined,transport:AttachedTransport|undefined,admitted=false,failure:Error|undefined,readyAt=0
    try {
      const candidate=readWindowsV3Discovery(policy)
      identity=await HeldWindowsV3Identity.acquire(candidate.record,policy,signal)
      signal.throwIfAborted()
      if(generation!==this.startGeneration || this.stopping)return
      // Native verification takes time. Never authenticate with a publication captured before it
      // unless the current generation and complete token still agree.
      const current=readWindowsV3Discovery(policy)
      if(JSON.stringify(current.record)!==JSON.stringify(candidate.record) || current.token!==candidate.token)throw new WindowsV3UnavailableError('SC1 native publication changed during verification')
      transport=new AttachedTransport({baseUrl:current.baseUrl,token:current.token,process:identity.anchor},error=>{
        failure=error
        if(!admitted || generation!==this.startGeneration || this.attachedTransport!==transport)return
        this.attachedTransport=null
        const stable=Date.now()-readyAt>=30_000
        this.retryWindowsV3(policy,generation,stable?0:attempt,stable?Date.now():waitingSince,error)
      },identity)
      identity=undefined // The transport owns this exact held handle, never a reopened PID.
      this.attachedTransport=transport
      this.update({phase:'starting',runtime:{kind:'attached',label:'Hermes Stable – geprüfte native Verbindung',command:[]},wsUrl:undefined,baseUrl:undefined,port:undefined})
      const deadline=performance.now()+5000
      const host=await transport.rest<{ok?:unknown;protocolVersion?:unknown;pid?:unknown;role?:unknown}>({method:'GET',path:'/api/host/identity'},5000)
      if(host?.ok!==true || host.protocolVersion!==1 || host.pid!==current.record.pid)throw new Error('SC1 authenticated host identity mismatch')
      if(host.role!==current.record.role)throw new WindowsV3RoleError(current.record.role,host.role)
      if(performance.now()>=deadline)throw new WindowsV3UnavailableError('SC1 identity probe timed out')
      const status=await transport.rest<{hermes_home?:unknown;install_id?:unknown}>({method:'GET',path:'/api/status'},deadline-performance.now())
      if(localWindowsPath(status?.hermes_home).toLowerCase()!==policy.home.toLowerCase() || status?.install_id!==policy.installId)throw new Error('SC1 authenticated HOME or installation mismatch')
      if(performance.now()>=deadline)throw new WindowsV3UnavailableError('SC1 default profile probe timed out')
      // Native current names this host's launch profile; active is only a future CLI preference.
      const profile=await transport.rest<{current?:unknown}>({method:'GET',path:'/api/profiles/active'},deadline-performance.now())
      if(profile?.current!=='default')throw new WindowsV3ProfileError()
      if(failure)throw failure
      signal.throwIfAborted()
      if(generation!==this.startGeneration || this.stopping || this.attachedTransport!==transport)return
      admitted=true;readyAt=Date.now()
      this.update({phase:'ready',attempt:0,wsUrl:ATTACHED_GATEWAY_URL,baseUrl:undefined,port:undefined,localFiles:false,error:undefined,sharedGateway:undefined,bridgeError:undefined})
    }catch(error){
      if(generation===this.startGeneration && !this.stopping && !signal.aborted){
        if(this.attachedTransport===transport)this.attachedTransport=null
        this.retryWindowsV3(policy,generation,attempt,waitingSince,failure??error)
      }
    }finally{identity?.close();if(!admitted){transport?.close();if(this.attachedTransport===transport)this.attachedTransport=null}}
  }

  private retryWindowsV3(policy:WindowsV3Policy,generation:number,attempt:number,waitingSince:number,error:unknown):void {
    if(generation!==this.startGeneration || this.stopping)return
    this.clearRestartTimer()
    if(!(error instanceof WindowsV3UnavailableError)) {
      this.update({phase:'failed',error:error instanceof WindowsV3RoleError || error instanceof WindowsV3ProfileError?error.message:'SC1: Native Vertrauens- oder Authentifizierungsprüfung fehlgeschlagen. Keine automatische Wiederholung.',wsUrl:undefined,baseUrl:undefined,port:undefined})
      return
    }
    const remaining=120_000-(Date.now()-waitingSince)
    this.update({phase:remaining<=0?'waiting':'restarting',attempt:attempt+1,error:remaining<=0?'Hermes Stable bleibt offline. Erneut verbinden startet eine neue Prüfung; keinen Core.':'Warte auf autorisierten Hermes Stable Core. Herald OS startet keinen Core.',wsUrl:undefined,baseUrl:undefined,port:undefined})
    if(remaining<=0)return
    this.restartTimer=setTimeout(()=>{this.restartTimer=null;void this.acquireWindowsV3(policy,generation,attempt+1,waitingSince)},Math.min(remaining,[1000,2000,4000,8000][Math.min(attempt,3)]))
  }

  /** V2 remains an explicit static diagnostic contract, with no fallback to V3. */
  private async attachWindows(generation: number): Promise<void> {
    let transport: AttachedTransport | null = null
    try {
      const target = windowsAttachTarget()
      transport = new AttachedTransport(target, error => {
        if (generation !== this.startGeneration) return
        this.attachedTransport = null
        this.update({ phase: 'failed', error: error.message, wsUrl: undefined, baseUrl: undefined, port: undefined })
      })
      this.attachedTransport = transport
      this.update({ phase: 'starting', runtime: { kind: 'attached', label: 'Autorisierter Hermes Core', command: [] } })
      await transport.rest({ method: 'GET', path: '/api/status' })
      if (generation !== this.startGeneration || this.stopping || this.attachedTransport !== transport) { transport.close(); return }
      // No path probe with credentials and no claim that a Python process authenticates its code.
      // File uploads remain available. Reverse-control publication follows the existing secure writer.
      if (this.control) {
        const control=this.control
        await this.queueControlFile(async () => {
          if (generation !== this.startGeneration) return
          await this.removeControlPublication()
          try { this.controlPublication=await publishControlFile(heraldOsDataDir(),{socket:control.socketPath,token:control.token},{boundUnixSocket:control.boundUnixSocket,warn:message=>log('backend',message)}) }
          catch(error) {if(error instanceof ControlPublicationError)this.controlPublication=error.publication;throw error}
          if (generation !== this.startGeneration) await this.removeControlPublication()
        })
      }
      if (generation !== this.startGeneration || this.stopping || this.attachedTransport !== transport) { transport.close(); return }
      this.update({phase:'ready',port:undefined,baseUrl:undefined,wsUrl:ATTACHED_GATEWAY_URL,localFiles:false,error:undefined,sharedGateway:undefined,bridgeError:undefined})
    } catch {
      transport?.close()
      if (generation !== this.startGeneration) return
      this.attachedTransport=null
      this.update({phase:'failed',error:'SC1: Die geschützte Anbindung an den autorisierten Hermes Core konnte nicht bestätigt werden. Konfiguration, Prozessidentität, Dateirechte und Erreichbarkeit prüfen. Es wird kein Core gestartet.',wsUrl:undefined,baseUrl:undefined,port:undefined})
    }
  }

  openAttachedSocket(kind: 'gateway' | 'speak-stream') {
    if (process.platform !== 'win32' || this.state.phase !== 'ready' || !this.attachedTransport) throw new Error('SC1 authenticated socket unavailable')
    return this.attachedTransport.webSocket(kind)
  }

  /** Another app's messaging gateway on this Hermes home (Hermes Desktop, say), for Settings to mention. */
  sharedGateway(): { pid: number } | null {
    return foreignGateway(hermesHome(), { appPid: process.pid, backendPid: this.child?.pid ?? null }, { alive: isProcessAlive, parentOf: parentPid })
  }

  private async spawnServe(runtime: BackendRuntime, generation: number): Promise<number> {
    if (process.platform === 'win32' || process.env.HERALD_OS_REQUIRE_ATTACHED_BACKEND === '1') {
      throw new Error('Managed Hermes spawn is forbidden for an attached-only launch')
    }

    const shellPath = await loginShellPath()
    if (generation !== this.startGeneration || this.stopping) throw new Error('Backend startup was superseded')
    // No awaits after this guard until the child and its handlers belong to this generation.
    this.token = crypto.randomBytes(32).toString('base64url')
    const [command, ...head] = runtime.command
    const args = [...head, 'serve', '--host', '127.0.0.1', '--port', '0']
    const dataDir = heraldOsDataDir()
    const readyFile = path.join(dataDir, readyFileName(process.pid))
    fs.mkdirSync(dataDir, { recursive: true })
    fs.rmSync(readyFile, { force: true })

    for (const name of staleReadyFiles(fs.readdirSync(dataDir), process.pid, isProcessAlive)) {
      fs.rmSync(path.join(dataDir, name), { force: true })
    }

    const env = serveEnvironment(process.env, {
      PATH: shellPath,
      HERMES_HOME: hermesHome(),
      // Sessions start in the user's world, not inside the runtime checkout.
      TERMINAL_CWD: osEnv('DEFAULT_CWD') || os.homedir(),
      HERMES_DASHBOARD_SESSION_TOKEN: this.token,
      // The loopback token exemption, in-process cron ticker and orphan reaping upstream key on
      // this flag; Herald OS spawns and owns the backend exactly the way Desktop does.
      HERMES_DESKTOP: '1',
      HERALD_OS: '1',
      HERMES_PARENT_PID: String(process.pid),
      // Remove parent-identity markers inherited from an outer Hermes session
      // (the app may have been launched from a running Hermes CLI or Desktop
      // shell). A leaked HERMES_PARENT_START_MARKER + HERMES_PARENT_NONCE pairs
      // with the marker-parsing watchdog in upstream web_server_lifecycle.py:
      // the backend would conclusively decide "parent replaced" against the
      // real Electron PID and exit immediately after setup.ready. With no
      // marker, the watchdog degrades to plain PID liveness, which is safe.
      HERMES_PARENT_START_MARKER: undefined,
      HERMES_PARENT_NONCE: undefined,
      HERMES_SPAWN: undefined,
      HERMES_DESKTOP_READY_FILE: readyFile,
      PYTHONUNBUFFERED: '1',
      ...(this.control ? { HERALD_OS_CONTROL_SOCKET: this.control.socketPath, HERALD_OS_CONTROL_TOKEN: this.control.token } : {})
    })

    log('backend', `spawning ${[command, ...args].join(' ')} (cwd ${runtime.root ?? process.cwd()})`)
    const child = spawn(command, args, {
      cwd: runtime.root ?? undefined,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    })
    this.child = child

    return new Promise<number>((resolve, reject) => {
      let settled = false
      const stdout = new LineBuffer()
      const stderr = new LineBuffer()
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          clearInterval(filePoll)
          fs.rmSync(readyFile, { force: true })
          fn()
        }
      }
      const timer = setTimeout(() => settle(() => reject(new Error('timed out waiting for HERMES_BACKEND_READY'))), READY_TIMEOUT_MS)
      // Fallback for interpreters whose fd 1 is not our pipe: upstream also publishes the port in a ready file.
      const filePoll = setInterval(() => {
        try {
          const parsed = JSON.parse(fs.readFileSync(readyFile, 'utf8')) as { port?: unknown }

          if (typeof parsed.port === 'number') {
            settle(() => resolve(parsed.port as number))
          }
        } catch {
          // Not written yet.
        }
      }, 500)

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        for (const line of stdout.push(chunk)) {
          this.record(`[out] ${line}`)
          const port = parseReadyLine(line)

          if (port !== null) {
            settle(() => resolve(port))
          }
        }
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        for (const line of stderr.push(chunk)) {
          this.record(`[err] ${line}`)
        }
      })
      child.on('error', error => settle(() => reject(error)))
      child.on('exit', (code, signal) => {
        for (const line of [...stdout.flush(), ...stderr.flush()]) {
          this.record(line)
        }

        log('backend', `serve exited code=${code} signal=${signal}`)

        if (this.child === child) {
          this.child = null
        }

        settle(() => reject(new Error(`hermes serve exited early (code ${code ?? 'null'}, signal ${signal ?? 'none'})`)))

        if (settled && generation === this.startGeneration && !this.stopping && this.state.phase === 'ready') {
          this.scheduleRestart(this.state.attempt, `backend exited unexpectedly (code ${code ?? 'null'})`)
        }
      })
    })
  }

  private scheduleRestart(previousAttempt: number, reason: string): void {
    if (process.platform === 'win32') { this.update({ phase: 'failed', error: reason, wsUrl: undefined, baseUrl: undefined, port: undefined }); return }
    if (this.stopping) {
      return
    }

    const next = previousAttempt + 1

    if (next > MAX_RESTARTS) {
      this.update({ phase: 'failed', error: reason, wsUrl: undefined, baseUrl: undefined, port: undefined })

      return
    }

    const delay = BACKOFF_MS[Math.min(next - 1, BACKOFF_MS.length - 1)]
    log('backend', `restart ${next}/${MAX_RESTARTS} in ${delay}ms: ${reason}`)
    this.update({ phase: 'restarting', attempt: next, error: reason, wsUrl: undefined, baseUrl: undefined, port: undefined })
    this.clearRestartTimer()
    this.restartTimer = setTimeout(() => void this.launch(next), delay)
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private clearWaitTimer(): void {
    if (this.waitTimer) {
      clearInterval(this.waitTimer)
      this.waitTimer = null
    }
  }

  private async killChild(): Promise<void> {
    this.attachedTransport?.close()
    this.attachedTransport = null
    const child = this.child
    // Any in-flight launch belongs to a previous generation now.
    this.startGeneration++
    this.v3Abort?.abort()
    if(this.v3Work)await this.v3Work

    if (!child || child.exitCode !== null || child.signalCode != null) {
      if (this.child === child) this.child = null
      return
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let force: ReturnType<typeof setTimeout> | undefined
      let confirmation: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(force)
        clearTimeout(confirmation)
        child.off('exit', exited)
        child.off('error', failed)
        if (error) reject(error)
        else resolve()
      }
      const exited = () => finish()
      const failed = (error: Error) => finish(error)
      const signal = (name: NodeJS.Signals) => {
        try {
          const sent = child.kill(name)
          // Successful signal delivery (including child.killed) does not prove process exit.
          if (child.exitCode !== null || child.signalCode != null) finish()
          else if (!sent) finish(new Error(`Could not send ${name} to backend ${child.pid}; exit unconfirmed`))
        } catch (error) {
          if (child.exitCode !== null || child.signalCode != null) finish()
          else finish(error instanceof Error ? error : new Error(String(error)))
        }
      }
      child.once('exit', exited)
      child.once('error', failed)
      force = setTimeout(() => {
        confirmation = setTimeout(() => finish(new Error(`Backend ${child.pid} exit unconfirmed after SIGKILL`)), 1000)
        signal('SIGKILL')
      }, 4000)
      signal('SIGTERM')
    })
    // Failed or timed-out termination retains ownership for a later confirmed exit or retry.
    if (this.child === child) this.child = null
  }

  private record(line: string): void {
    this.tail.push(line)

    if (this.tail.length > LOG_TAIL_LINES * 2) {
      this.tail.splice(0, this.tail.length - LOG_TAIL_LINES)
    }

    log('serve', line)
  }

  private update(patch: Partial<BackendState>): void {
    this.state = { ...this.state, ...patch }
    const snapshot = this.getState()

    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }
}

/**
 * The environment `hermes serve` runs with: the app's, then `own`. A session the app inherited
 * (HERMES_SESSION_* and the rest, see session-env.ts) would otherwise be the backend's, and through
 * it every gateway and command the backend starts.
 */
export function serveEnvironment(inherited: NodeJS.ProcessEnv, own: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...withoutInheritedSession(inherited), ...own }
  delete env.ELECTRON_RUN_AS_NODE

  return env
}

function parentPid(pid: number): number | null {
  try {
    if (process.platform === 'linux') {
      // /proc/<pid>/stat: "pid (comm) state ppid …"; comm may contain spaces, so split after the ")".
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')

      return Number(fields[1]) || null
    }

    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })

    return Number(out.trim()) || null
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
