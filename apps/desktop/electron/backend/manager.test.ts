import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendRuntime } from '../../shared/ipc.ts'

const found = vi.hoisted(() => ({ runtime: null as BackendRuntime | null, install: null as string | null }))

vi.mock('./resolve.ts', () => ({ resolveBackendRuntime: () => found.runtime, pendingInstall: () => found.install }))
vi.mock('./bridge-plugin.ts', () => ({ ensureBridgePlugin: async () => null }))
vi.mock('./shell-env.ts', () => ({ loginShellPath: async () => process.env.PATH ?? '' }))
vi.mock('../log.ts', () => ({ log: () => undefined }))
vi.mock('./coexist.ts',async importOriginal=>({
  ...await importOriginal<typeof import('./coexist.ts')>(),
  readWindowsV3Policy:vi.fn(),readWindowsV3Discovery:vi.fn()
}))

import { BackendManager, WAIT_POLL_MS, waitingReason } from './manager.ts'
import { readWindowsV3Policy, readWindowsV3Discovery, type WindowsV3Policy } from './coexist.ts'
import { HeldWindowsV3Identity, WindowsV3UnavailableError } from './connection-identity.ts'
import { AttachedTransport } from './attached-transport.ts'

let dir: string
let manager: BackendManager
const hostPlatform=process.platform

/** A Hermes whose `serve` exits at once, so a start gets as far as spawning it and no further. */
const installed = (): BackendRuntime => ({ kind: 'managed', label: 'managed Hermes install', root: dir, command: [process.execPath, '-e', 'process.exit(3)'] })

beforeEach(() => {
  vi.mocked(readWindowsV3Policy).mockReset().mockImplementation(()=>{throw new Error('isolated missing policy')})
  vi.mocked(readWindowsV3Discovery).mockReset().mockImplementation(()=>{throw new Error('isolated missing discovery')})
  // These original lifecycle tests exercise the managed-runtime contract retained on Linux.
  Object.defineProperty(process,'platform',{value:'linux',configurable:true})
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-manager-'))
  vi.stubEnv('HERMES_HOME', dir)
  vi.stubEnv('HERALD_OS_BACKEND_URL', undefined)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  found.runtime = null
  found.install = null
  manager = new BackendManager()
})

afterEach(async () => {
  await manager.stop()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
  Object.defineProperty(process,'platform',{value:hostPlatform,configurable:true})
})

describe('Windows V3 admission and generation lifecycle',()=>{
  const policy:WindowsV3Policy={version:3,discovery:'hermes-host-v1',home:'C:\\fixture\\stable',installId:'a'.repeat(32),rendezvousDir:'C:\\fixture\\discovery',packageFamily:'NousResearch.HermesBundled_e60prshbsznhj',publisher:'CN=Nous Research Inc., O=Nous Research Inc., L=Austin, S=Texas, C=US',minimumPackageVersion:'2026.6864.2132.0'}
  const candidate=(pid=42)=>({record:{protocolVersion:1 as const,role:'serve' as const,host:'127.0.0.1' as const,port:57945,pid,createTime:100+pid,startTime:(100+pid)*100,home:'',tokenFingerprint:'b'.repeat(16)},token:'synthetic-generation-'+pid,baseUrl:'http://127.0.0.1:57945'})
  function identity(pid=42) {
    return {anchor:{pid,creationTime:'133801234567890123',ownerSid:'S-1-5-21-1-2-3-1001',imagePath:'C:\\fixture\\python.exe',imageSha256:'a'.repeat(64)},assertAlive:vi.fn(),verifySocket:vi.fn(),close:vi.fn()} as unknown as HeldWindowsV3Identity
  }
  function probes(pid=42) {
    return vi.spyOn(AttachedTransport.prototype,'rest').mockImplementation(async request=>request.path==='/api/host/identity'?{ok:true,protocolVersion:1,pid,role:'serve'}:request.path==='/api/profiles/active'?{current:'default',active:'another-cli-preference'}:{hermes_home:policy.home,install_id:policy.installId})
  }
  beforeEach(()=>{
    Object.defineProperty(process,'platform',{value:'win32',configurable:true})
    vi.stubEnv('HERALD_OS_ATTACH_CONFIG',undefined)
    vi.useFakeTimers()
    vi.mocked(readWindowsV3Policy).mockReturnValue(policy)
    vi.mocked(readWindowsV3Discovery).mockReturnValue(candidate())
  })
  it('publishes ready only after held admission and all authenticated identity/profile probes',async()=>{
    const held=identity(),acquire=vi.spyOn(HeldWindowsV3Identity,'acquire').mockResolvedValue(held),rest=probes()
    await manager.start()
    expect(acquire).toHaveBeenCalledOnce();expect(readWindowsV3Discovery).toHaveBeenCalledTimes(2)
    expect(rest.mock.calls.map(([r])=>r.path)).toEqual(['/api/host/identity','/api/status','/api/profiles/active'])
    expect(manager.getState().phase).toBe('ready');expect(manager.childPid()).toBeNull()
    expect(JSON.stringify(manager.getState())).not.toContain('synthetic-generation')
    await manager.stop();expect(held.close).toHaveBeenCalledOnce()
  })
  it.each(['desktop-serve','serve','unknown'])('binds authenticated role %s to the explicitly selected Desktop publication',async role=>{
    vi.mocked(readWindowsV3Policy).mockReturnValue({...policy,discovery:'hermes-desktop-host-v1'})
    const desktop={...candidate(),record:{...candidate().record,role:'desktop-serve' as const}}
    vi.mocked(readWindowsV3Discovery).mockReturnValue(desktop)
    const held=identity();vi.spyOn(HeldWindowsV3Identity,'acquire').mockResolvedValue(held)
    const rest=probes();rest.mockResolvedValueOnce({ok:true,protocolVersion:1,pid:42,role})
    await manager.start()
    expect(manager.getState().phase).toBe(role==='desktop-serve'?'ready':'failed')
    expect(manager.childPid()).toBeNull()
    if(role!=='desktop-serve') {
      expect(manager.getState().error).toMatch(/Host-Rolle.*desktop-serve/)
      expect(manager.getState().error).toContain(role==='serve'?'serve':'unbekannt')
      expect(rest).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(130_000)
      expect(readWindowsV3Discovery).toHaveBeenCalledTimes(2)
      expect(held.close).toHaveBeenCalledOnce()
    }
  })
  it('rejects a role change during held verification before transmitting credentials',async()=>{
    const held=identity();vi.spyOn(HeldWindowsV3Identity,'acquire').mockResolvedValue(held)
    vi.mocked(readWindowsV3Discovery).mockReturnValueOnce(candidate()).mockReturnValue({...candidate(),record:{...candidate().record,role:'desktop-serve'}})
    const rest=probes();await manager.start()
    expect(rest).not.toHaveBeenCalled();expect(held.close).toHaveBeenCalledOnce()
    expect(manager.getState().phase).toBe('restarting')
  })
  it.each(['owner','host','home','install','authentication'])('fails terminally on %s rejection without fallback',async fault=>{
    const held=identity(),acquire=vi.spyOn(HeldWindowsV3Identity,'acquire').mockResolvedValue(held),rest=probes()
    if(fault==='owner')acquire.mockRejectedValue(new Error('untrusted owner'))
    if(fault==='host')rest.mockResolvedValueOnce({ok:true,protocolVersion:1,pid:999,role:'serve'})
    if(fault==='home' || fault==='install')rest.mockResolvedValueOnce({ok:true,protocolVersion:1,pid:42,role:'serve'}).mockResolvedValueOnce({hermes_home:fault==='home'?'C:\\wrong':policy.home,install_id:fault==='install'?'wrong':policy.installId})
    if(fault==='authentication')rest.mockRejectedValue(new Error('SC1 backend HTTP 401'))
    await manager.start();expect(manager.getState().phase).toBe('failed');expect(manager.childPid()).toBeNull()
    await vi.advanceTimersByTimeAsync(130_000);expect(acquire).toHaveBeenCalledOnce()
    if(fault==='owner')expect(rest).not.toHaveBeenCalled();else expect(held.close).toHaveBeenCalledOnce()
  })
  it('releases a superseded publication before transmitting a token',async()=>{
    const held=identity();vi.spyOn(HeldWindowsV3Identity,'acquire').mockResolvedValue(held)
    vi.mocked(readWindowsV3Discovery).mockReturnValueOnce(candidate()).mockReturnValue(candidate(43))
    const rest=probes();await manager.start()
    expect(rest).not.toHaveBeenCalled();expect(held.close).toHaveBeenCalledOnce()
    expect(manager.getState().phase).toBe('restarting')
  })
  it('bounds unavailable discovery to two minutes and cancels the retry timer on stop',async()=>{
    vi.mocked(readWindowsV3Discovery).mockImplementation(()=>{throw new WindowsV3UnavailableError('not published')})
    const acquire=vi.spyOn(HeldWindowsV3Identity,'acquire'),rest=probes()
    await manager.start();await vi.advanceTimersByTimeAsync(120_000)
    expect(manager.getState().phase).toBe('waiting')
    const reads=vi.mocked(readWindowsV3Discovery).mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000);expect(readWindowsV3Discovery).toHaveBeenCalledTimes(reads)
    expect(acquire).not.toHaveBeenCalled();expect(rest).not.toHaveBeenCalled()
    await manager.restart();await manager.stop();const stopped=vi.mocked(readWindowsV3Discovery).mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000);expect(readWindowsV3Discovery).toHaveBeenCalledTimes(stopped)
  })
  it.each(['different-profile','wrong-type','missing'])('rejects a %s native default-profile binding before exposing sessions',async fault=>{
    const held=identity();vi.spyOn(HeldWindowsV3Identity,'acquire').mockResolvedValue(held)
    const rest=probes()
    rest.mockImplementation(async request=>request.path==='/api/host/identity'?{ok:true,protocolVersion:1,pid:42,role:'serve'}:request.path==='/api/profiles/active'?(fault==='missing'?{active:'default'}:{active:'default',current:fault==='different-profile'?'another-profile':{name:'default'}}):{hermes_home:policy.home,install_id:policy.installId})
    await manager.start()
    expect(manager.getState()).toMatchObject({phase:'failed',wsUrl:undefined})
    expect(held.close).toHaveBeenCalledOnce();expect(manager.childPid()).toBeNull()
    const calls=rest.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000);expect(rest).toHaveBeenCalledTimes(calls)
  })
  it('binds the unchanged launch HOME to the native default profile without creating or moving sessions',async()=>{
    vi.spyOn(HeldWindowsV3Identity,'acquire').mockResolvedValue(identity());const rest=probes()
    await manager.start()
    expect(manager.getState().phase).toBe('ready')
    expect(rest.mock.calls.map(([request])=>request)).toEqual([
      {method:'GET',path:'/api/host/identity'},
      {method:'GET',path:'/api/status'},
      {method:'GET',path:'/api/profiles/active'},
    ])
  })
  it.each([404,500])('fails closed when native profile lookup returns HTTP %i',async code=>{
    const held=identity();vi.spyOn(HeldWindowsV3Identity,'acquire').mockResolvedValue(held);const rest=probes()
    rest.mockImplementation(async request=>{
      if(request.path==='/api/profiles/active')throw new Error(`SC1 backend HTTP ${code}`)
      return request.path==='/api/host/identity'?{ok:true,protocolVersion:1,pid:42,role:'serve'}:{hermes_home:policy.home,install_id:policy.installId}
    })
    await manager.start();expect(manager.getState().phase).toBe('failed');expect(held.close).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120_000);expect(rest).toHaveBeenCalledTimes(3)
  })
  it('closes admission and retries when its deadline expires before native profile lookup',async()=>{
    const held=identity();vi.spyOn(HeldWindowsV3Identity,'acquire').mockResolvedValue(held)
    const now=vi.spyOn(performance,'now').mockReturnValue(0),rest=probes()
    rest.mockImplementation(async request=>{
      if(request.path==='/api/host/identity')return {ok:true,protocolVersion:1,pid:42,role:'serve'}
      now.mockReturnValue(5001);return {hermes_home:policy.home,install_id:policy.installId}
    })
    await manager.start();now.mockRestore()
    expect(manager.getState().phase).toBe('restarting');expect(held.close).toHaveBeenCalledOnce()
    expect(rest.mock.calls.map(([request])=>request.path)).toEqual(['/api/host/identity','/api/status'])
  })
  it('reacquires a legitimate new generation and does not replay an uncertain POST',async()=>{
    const old=identity(),next=identity(43);const acquire=vi.spyOn(HeldWindowsV3Identity,'acquire').mockResolvedValueOnce(old).mockResolvedValue(next)
    const rest=probes();await manager.start()
    rest.mockRejectedValueOnce(new WindowsV3UnavailableError('uncertain request'))
    await expect(manager.rest({method:'POST',path:'/api/chat',body:{message:'synthetic'}})).rejects.toThrow('uncertain')
    vi.mocked(old.assertAlive).mockImplementation(()=>{throw new WindowsV3UnavailableError('generation exited')})
    vi.mocked(readWindowsV3Discovery).mockReturnValue(candidate(43))
    rest.mockImplementation(async request=>request.path==='/api/host/identity'?{ok:true,protocolVersion:1,pid:43,role:'serve'}:request.path==='/api/profiles/active'?{current:'default'}:{hermes_home:policy.home,install_id:policy.installId})
    await vi.advanceTimersByTimeAsync(1250)
    expect(manager.getState().phase).toBe('ready');expect(acquire).toHaveBeenCalledTimes(2);expect(old.close).toHaveBeenCalledOnce()
    expect(rest.mock.calls.filter(([r])=>r.method==='POST')).toHaveLength(1)
    await manager.stop();expect(next.close).toHaveBeenCalledOnce()
  })
  it('does not reset the retry budget when successive generations immediately fail',async()=>{
    const acquire=vi.spyOn(HeldWindowsV3Identity,'acquire').mockImplementation(async()=>{
      const held=identity()
      vi.mocked(held.assertAlive).mockImplementation(()=>{throw new WindowsV3UnavailableError('short-lived generation')})
      return held
    })
    probes();await manager.start();await vi.advanceTimersByTimeAsync(125_000)
    expect(manager.getState().phase).toBe('waiting')
    const calls=acquire.mock.calls.length;expect(calls).toBeGreaterThan(2);expect(calls).toBeLessThan(25)
    await vi.advanceTimersByTimeAsync(120_000);expect(acquire).toHaveBeenCalledTimes(calls)
  })
  it('starts a fresh retry budget after thirty seconds of stable readiness',async()=>{
    const held=identity();vi.spyOn(HeldWindowsV3Identity,'acquire').mockResolvedValue(held);probes()
    await manager.start();await vi.advanceTimersByTimeAsync(130_000)
    vi.mocked(held.assertAlive).mockImplementation(()=>{throw new WindowsV3UnavailableError('later generation exit')})
    await vi.advanceTimersByTimeAsync(250)
    expect(manager.getState()).toMatchObject({phase:'restarting',attempt:1})
  })
  it('aborts in-flight admission and closes a late identity without publishing ready',async()=>{
    let resolve!:(held:HeldWindowsV3Identity)=>void
    const pending=new Promise<HeldWindowsV3Identity>(done=>resolve=done)
    const held=identity(),acquire=vi.spyOn(HeldWindowsV3Identity,'acquire').mockReturnValue(pending),rest=probes()
    const started=manager.start()
    await vi.waitFor(()=>expect(acquire).toHaveBeenCalledOnce())
    const stopped=manager.stop()
    expect(acquire.mock.calls[0]![2]!.aborted).toBe(true)
    resolve(held);await Promise.all([started,stopped])
    expect(held.close).toHaveBeenCalledOnce();expect(rest).not.toHaveBeenCalled();expect(manager.getState().phase).toBe('stopped')
  })
})

describe('Windows unconditional attach-only gate',()=>{
  beforeEach(()=>{
    Object.defineProperty(process,'platform',{value:'win32',configurable:true})
    vi.stubEnv('HERALD_OS_ATTACH_CONFIG',undefined)
    vi.stubEnv('HERALD_OS_REQUIRE_ATTACHED_BACKEND',undefined)
    found.runtime=installed()
  })
  it('Explorer launch fails without configuration and never discovers or spawns a Core',async()=>{
    await manager.start()
    expect(manager.getState().phase).toBe('failed')
    expect(manager.childPid()).toBeNull()
    vi.advanceTimersByTime(WAIT_POLL_MS*100)
    expect(manager.getState().phase).toBe('failed')
    expect(manager.getState().runtime).toBeUndefined()
  })
  it('legacy URL/token variables cannot bypass the protected V2 gate',async()=>{
    vi.stubEnv('HERALD_OS_BACKEND_URL','http://127.0.0.1:1')
    vi.stubEnv('HERALD_OS_BACKEND_TOKEN','synthetic-only')
    await manager.start();await manager.restart()
    expect(manager.getState().phase).toBe('failed');expect(manager.childPid()).toBeNull()
    expect(manager.getState().wsUrl).toBeUndefined()
  })
  it('the managed spawn sink remains forbidden even without the attach-only environment switch',async()=>{
    const internal=manager as unknown as {spawnServe(runtime:BackendRuntime,generation:number):Promise<number>}
    await expect(internal.spawnServe(installed(),0)).rejects.toThrow('forbidden')
    expect(manager.childPid()).toBeNull()
  })
})

describe('BackendManager without a Hermes to start', () => {
  it('waits, then starts the Hermes that gets installed', async () => {
    await manager.start()
    expect(manager.getState()).toMatchObject({ phase: 'waiting', error: waitingReason(null) })

    vi.advanceTimersByTime(WAIT_POLL_MS)
    expect(manager.getState().phase).toBe('waiting')

    found.runtime = installed()
    vi.advanceTimersByTime(WAIT_POLL_MS)
    expect(manager.getState()).toMatchObject({ phase: 'starting', runtime: { label: 'managed Hermes install' } })
    await vi.waitFor(() => expect(manager.getState().phase).toBe('restarting'))
  })

  it("waits for the image's first-boot install even once Hermes is there", async () => {
    found.runtime = installed()
    found.install = 'offline'
    await manager.start()
    expect(manager.getState()).toMatchObject({ phase: 'waiting', install: 'offline', error: waitingReason('offline') })

    found.install = 'installing'
    vi.advanceTimersByTime(WAIT_POLL_MS)
    expect(manager.getState()).toMatchObject({ phase: 'waiting', install: 'installing', error: waitingReason('installing') })

    found.install = null
    vi.advanceTimersByTime(WAIT_POLL_MS)
    expect(manager.getState()).toMatchObject({ phase: 'starting', install: undefined })
    await vi.waitFor(() => expect(manager.getState().phase).toBe('restarting'))
  })

  it('stops waiting when the shell stops it', async () => {
    await manager.start()
    await manager.stop()

    found.runtime = installed()
    vi.advanceTimersByTime(WAIT_POLL_MS * 2)
    expect(manager.getState().phase).toBe('stopped')
  })

  it('fails closed instead of spawning when an existing backend is required but its URL is missing', async () => {
    vi.stubEnv('HERALD_OS_REQUIRE_ATTACHED_BACKEND', '1')
    found.runtime = installed()

    await manager.start()

    expect(manager.getState()).toMatchObject({ phase: 'failed' })
    expect(manager.getState().error).toMatch(/existing Hermes backend/i)
  })

  it('forbids managed spawn at the sink for an attached-only launch', async () => {
    vi.stubEnv('HERALD_OS_REQUIRE_ATTACHED_BACKEND', '1')
    const internals = manager as unknown as {
      spawnServe(runtime: BackendRuntime, generation: number): Promise<number>
    }

    await expect(internals.spawnServe(installed(), 0)).rejects.toThrow(/managed Hermes spawn is forbidden/i)
    expect(manager.childPid()).toBeNull()
  })
})
