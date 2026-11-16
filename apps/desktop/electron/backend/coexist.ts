import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { localWindowsPath, parseProcessAnchor, readWindowsV3ProtectedFile, WindowsV3UnavailableError, type ProcessAnchor, holdProtectedWindowsFile, HeldWindowsV3Identity, publishWindowsV3Policy } from './connection-identity.ts'
import { readProtectedAttachFile } from './control-file.ts'
import { windowsConnectionPolicyPath } from '../paths.ts'

export const STABLE_PACKAGE_FAMILY='NousResearch.HermesBundled_e60prshbsznhj'
export const STABLE_PUBLISHER='CN=Nous Research Inc., O=Nous Research Inc., L=Austin, S=Texas, C=US'
export const QUALIFIED_MINIMUM_PACKAGE_VERSION='2026.6864.2132.0'
export interface WindowsV3Policy {
  version:3; discovery:'hermes-host-v1'|'hermes-desktop-host-v1'; home:string; installId:string; rendezvousDir:string
  packageFamily:string; minimumPackageVersion:string; publisher:string
}
export function windowsPackageVersion(value:unknown):bigint {
  if(typeof value!=='string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))throw new Error('SC1 invalid package version')
  const parts=value.split('.').map(Number)
  if(parts.some(part=>!Number.isInteger(part) || part>65535))throw new Error('SC1 invalid package version')
  return parts.reduce((total,part)=>(total<<16n)|BigInt(part),0n)
}
export function parseWindowsV3Policy(value:unknown):WindowsV3Policy {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('SC1 invalid V3 policy')
  const p=value as Record<string,unknown>
  if(Object.keys(p).sort().join(',')!=='discovery,home,installId,minimumPackageVersion,packageFamily,publisher,rendezvousDir,version' || p.version!==3 || (p.discovery!=='hermes-host-v1' && p.discovery!=='hermes-desktop-host-v1') || p.packageFamily!==STABLE_PACKAGE_FAMILY || p.publisher!==STABLE_PUBLISHER || typeof p.installId!=='string' || !/^[a-f0-9]{32}$/.test(p.installId))throw new Error('SC1 invalid V3 policy')
  localWindowsPath(p.home);localWindowsPath(p.rendezvousDir)
  if(windowsPackageVersion(p.minimumPackageVersion)<windowsPackageVersion(QUALIFIED_MINIMUM_PACKAGE_VERSION))throw new Error('SC1 package minimum below qualified version')
  return Object.freeze({...p}) as unknown as WindowsV3Policy
}
export function readWindowsV3Policy(env:NodeJS.ProcessEnv=process.env,read:(file:string,secret:boolean)=>string=readWindowsV3ProtectedFile):WindowsV3Policy {
  if(env.HERALD_OS_ATTACH_CONFIG!==undefined)throw new Error('SC1 explicit V2 selection cannot fall back to V3')
  // Policy absence is a terminal configuration error, not transient owner discovery.
  try{return parseWindowsV3Policy(JSON.parse(read(windowsConnectionPolicyPath(env),true)))}
  catch{throw new Error('SC1 protected V3 policy unavailable or invalid')}
}

export function buildWindowsV3Policy(profile:string,installId:string):WindowsV3Policy {
  localWindowsPath(profile)
  return parseWindowsV3Policy({version:3,discovery:'hermes-host-v1',home:path.win32.join(profile,'AppData','Local','hermes'),installId:installId.trim(),rendezvousDir:path.win32.join(profile,'.local','state','hermes','gateway-locks'),packageFamily:STABLE_PACKAGE_FAMILY,publisher:STABLE_PUBLISHER,minimumPackageVersion:QUALIFIED_MINIMUM_PACKAGE_VERSION})
}

/** Explicit setup only. This provisions trust metadata, never a Core, token or authenticated session. */
export async function enrollWindowsV3():Promise<void> {
  if(process.platform!=='win32' || process.env.HERALD_OS_ATTACH_CONFIG!==undefined)throw new Error('SC1 enrollment requires native Windows V3 selection')
  const profile=localWindowsPath(os.userInfo().homedir)
  const install=holdProtectedWindowsFile(path.win32.join(profile,'AppData','Local','hermes','install_id'),128,false,true)
  try {
    const policy=buildWindowsV3Policy(profile,install.bytes.toString('utf8'))
    const recordFile=path.win32.join(policy.rendezvousDir,'host-serve.json')
    const readRecord=()=>parseWindowsHostRecord(JSON.parse(readWindowsV3ProtectedFile(recordFile,false)),policy)
    const record=readRecord(),identity=await HeldWindowsV3Identity.acquire(record,policy)
    try {
      publishWindowsV3Policy(profile,Buffer.from(JSON.stringify(policy)+'\n','utf8'),()=>{
        identity.assertAlive()
        if(JSON.stringify(readRecord())!==JSON.stringify(record))throw new Error('SC1 enrollment native owner changed')
      })
    }finally{identity.close()}
  }finally{install.bytes.fill(0);install.close()}
}
export interface WindowsHostRecord { protocolVersion:1;role:'serve'|'desktop-serve';host:'127.0.0.1';port:number;pid:number;createTime:number;startTime:number;home:string;tokenFingerprint:string }
export class WindowsV3RoleError extends Error {
  constructor(expected:WindowsHostRecord['role'],observed:unknown) {
    super(`SC1: Falsche Host-Rolle. Erwartet: ${expected}; gemeldet: ${observed==='serve' || observed==='desktop-serve'?observed:'unbekannt'}. Die geschützte Verbindungspolicy bleibt unverändert. Keine automatische Wiederholung.`)
  }
}
export function parseWindowsHostRecord(value:unknown,policy:WindowsV3Policy):WindowsHostRecord {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('SC1 invalid native host record')
  const r=value as Record<string,unknown>
  if(r.protocolVersion!==1 || (r.role!=='serve' && r.role!=='desktop-serve') || r.host!=='127.0.0.1' || !Number.isInteger(r.port) || Number(r.port)<1 || Number(r.port)>65535 || !Number.isSafeInteger(r.pid) || Number(r.pid)<1 || Number(r.pid)>0xffffffff || typeof r.createTime!=='number' || !Number.isFinite(r.createTime) || r.createTime<=0 || !Number.isSafeInteger(r.startTime) || Number(r.startTime)<=0 || typeof r.tokenFingerprint!=='string' || !/^[a-f0-9]{16}$/.test(r.tokenFingerprint) || typeof r.home!=='string')throw new Error('SC1 invalid native host record')
  if(r.home!=='' && localWindowsPath(r.home).toLowerCase()!==policy.home.toLowerCase())throw new Error('SC1 native host HOME mismatch')
  const expected=policy.discovery==='hermes-desktop-host-v1'?'desktop-serve':'serve'
  if(r.role!==expected)throw new WindowsV3RoleError(expected,r.role)
  return {protocolVersion:1,role:r.role as WindowsHostRecord['role'],host:'127.0.0.1',port:r.port as number,pid:r.pid as number,createTime:r.createTime,startTime:r.startTime as number,home:r.home,tokenFingerprint:r.tokenFingerprint}
}
export function readWindowsV3Discovery(policy:WindowsV3Policy,read:(file:string,secret:boolean)=>string=readWindowsV3ProtectedFile):{record:WindowsHostRecord;token:string;baseUrl:string} {
  const role=policy.discovery==='hermes-desktop-host-v1'?'desktop-serve':'serve'
  const recordFile=path.win32.join(policy.rendezvousDir,`host-${role}.json`),tokenFile=path.win32.join(policy.rendezvousDir,`host-${role}.token`)
  const before=read(recordFile,false)
  const record=parseWindowsHostRecord(JSON.parse(before),policy)
  const token=read(tokenFile,true).trim()
  const after=read(recordFile,false)
  if(before!==after)throw new WindowsV3UnavailableError('SC1 discovery publication changed')
  if(!/^[A-Za-z0-9_\-+.\/=]{16,4096}$/.test(token))throw new Error('SC1 invalid private native token')
  if(crypto.createHash('sha256').update(token).digest('hex').slice(0,16)!==record.tokenFingerprint)throw new WindowsV3UnavailableError('SC1 discovery publication inconsistent')
  return {record,token,baseUrl:`http://127.0.0.1:${record.port}`}
}

export interface WindowsAttachTarget { baseUrl: string; token: string; process: ProcessAnchor }

/** Protected V2 contract is the sole Windows trust source. No URL/token environment fallback. */
export function windowsAttachTarget(env: NodeJS.ProcessEnv = process.env, read: (file: string) => string = readProtectedAttachFile): WindowsAttachTarget {
  const file = env.HERALD_OS_ATTACH_CONFIG
  if (!file) throw new Error('SC1: Geschützte Anbindung fehlt. Windows startet keinen Hermes Core. HERALD_OS_ATTACH_CONFIG muss auf einen autorisierten V2-Vertrag zeigen.')
  localWindowsPath(file)
  const c: unknown = JSON.parse(read(file))
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('SC1 invalid attach contract')
  const data = c as Record<string, unknown>
  if (Object.keys(data).sort().join(',') !== 'baseUrl,process,tokenFile,version' || data.version !== 2 || typeof data.baseUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(data.baseUrl)) throw new Error('SC1 requires an exact V2 IPv4 loopback contract')
  const url = new URL(data.baseUrl)
  if (!url.port || Number(url.port)>65535) throw new Error('SC1 invalid port')
  const process = parseProcessAnchor(data.process)
  const token = read(localWindowsPath(data.tokenFile)).trim()
  if (!/^[A-Za-z0-9_\-+.\/=]{16,4096}$/.test(token)) throw new Error('SC1 protected token is invalid')
  return { baseUrl: data.baseUrl, token, process }
}

/*
 * Legacy non-Windows contract: sharing a Hermes home with another app (Hermes Desktop on Omarchy,
 * a gateway the person runs). Windows exclusively uses the protected V2 contract above.
 * Hermes itself keeps scheduled jobs to one run (each tick takes cron/.tick.lock) and messaging to one
 * gateway (gateway.pid), so a second backend is safe. To not run one at all, point Herald at the
 * backend already running: HERALD_OS_BACKEND_URL plus its token.
 */

export interface AttachTarget {
  baseUrl: string
  token: string
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Windows is always attach-only and never exposes a reverse-control endpoint. */
export function reverseControlDisabled(env: NodeJS.ProcessEnv = process.env, platform:NodeJS.Platform=process.platform): boolean {
  return platform==='win32' || (env.HERALD_OS_REQUIRE_ATTACHED_BACKEND === '1' && env.HERALD_OS_DISABLE_REVERSE_CONTROL === '1')
}

/** The running backend to use instead of starting one, or null. Loopback only: the token travels in the clear. */
export function attachTarget(env: NodeJS.ProcessEnv = process.env, readFile: (file: string) => string = file => fs.readFileSync(file, 'utf8')): AttachTarget | null {
  const raw = env.HERALD_OS_BACKEND_URL?.trim()

  if (!raw) {
    return null
  }

  let url: URL

  try {
    url = new URL(raw)
  } catch {
    throw new Error(`HERALD_OS_BACKEND_URL is not a URL: ${raw}`)
  }

  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) {
    throw new Error('HERALD_OS_BACKEND_URL must be an http:// address on this machine (127.0.0.1)')
  }

  let token = env.HERALD_OS_BACKEND_TOKEN?.trim() ?? ''

  if (!token) {
    const file = env.HERALD_OS_BACKEND_TOKEN_FILE?.trim() || path.join(os.homedir(), '.config', 'herald-os', 'backend-token')

    try {
      token = readFile(file).trim()
    } catch {
      throw new Error(`HERALD_OS_BACKEND_URL needs the backend's token: set HERALD_OS_BACKEND_TOKEN or write it to ${file}`)
    }
  }

  return { baseUrl: url.origin, token }
}

/** `gateway.pid`: JSON (`{"pid": …, "hermes_home": …}`) in current Hermes, a bare number in older ones. */
export function parseGatewayPid(text: string): { pid: number; home?: string } | null {
  const raw = text.trim()

  if (!raw) {
    return null
  }

  if (/^\d+$/.test(raw)) {
    return { pid: Number(raw) }
  }

  try {
    const data = JSON.parse(raw) as { pid?: unknown; hermes_home?: unknown }

    return typeof data.pid === 'number' && data.pid > 0 ? { pid: data.pid, ...(typeof data.hermes_home === 'string' ? { home: data.hermes_home } : {}) } : null
  } catch {
    return null
  }
}

/**
 * A messaging gateway on this Hermes home that is not ours (its parent is neither this app nor the
 * backend it started), or null.
 */
export function foreignGateway(
  hermesHome: string,
  own: { appPid: number; backendPid: number | null },
  probe: { alive: (pid: number) => boolean; parentOf: (pid: number) => number | null; read?: (file: string) => string }
): { pid: number } | null {
  let record: { pid: number; home?: string } | null

  try {
    record = parseGatewayPid((probe.read ?? (file => fs.readFileSync(file, 'utf8')))(path.join(hermesHome, 'gateway.pid')))
  } catch {
    return null
  }

  if (!record || !probe.alive(record.pid)) {
    return null
  }

  if (record.home && path.resolve(record.home) !== path.resolve(hermesHome)) {
    return null
  }

  const parent = probe.parentOf(record.pid)

  return parent !== null && (parent === own.appPid || parent === own.backendPid) ? null : { pid: record.pid }
}
