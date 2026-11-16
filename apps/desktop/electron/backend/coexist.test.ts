import { windowsAttachTarget, parseWindowsV3Policy, parseWindowsHostRecord, readWindowsV3Discovery, readWindowsV3Policy } from './coexist.ts'
import crypto from 'node:crypto'
import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { attachTarget, foreignGateway, parseGatewayPid, reverseControlDisabled } from './coexist.ts'
import { buildWindowsV3Policy, enrollWindowsV3 } from './coexist.ts'
import * as nativeIdentity from './connection-identity.ts'

describe('native V3 enrollment schema',()=>{
  it('uses only the supplied OS profile and protected installation identity with fixed Stable trust',()=>{
    const policy=buildWindowsV3Policy('C:\\Users\\fixture','0123456789abcdef0123456789abcdef\n')
    expect(policy).toEqual({version:3,discovery:'hermes-host-v1',home:'C:\\Users\\fixture\\AppData\\Local\\hermes',installId:'0123456789abcdef0123456789abcdef',rendezvousDir:'C:\\Users\\fixture\\.local\\state\\hermes\\gateway-locks',packageFamily:'NousResearch.HermesBundled_e60prshbsznhj',minimumPackageVersion:'2026.6864.2132.0',publisher:'CN=Nous Research Inc., O=Nous Research Inc., L=Austin, S=Texas, C=US'})
    expect(parseWindowsV3Policy(JSON.parse(JSON.stringify(policy)))).toEqual(policy)
  })
  it.each(['','not-an-id','A'.repeat(32),'0'.repeat(33),'0'.repeat(32)+'\nextra'])('rejects malformed native install_id %s',id=>{
    expect(()=>buildWindowsV3Policy('C:\\Users\\fixture',id)).toThrow()
  })
  it.each(['relative','\\\\server\\share','C:\\Users\\..\\escape','C:\\Users\\fixture:stream'])('rejects ambiguous profile %s',profile=>{
    expect(()=>buildWindowsV3Policy(profile,'0'.repeat(32))).toThrow()
  })
})

describe.skipIf(process.platform!=='win32')('enrollment reuses held native admission without accessing credentials',()=>{
  function fixture() {
    const closeInstall=vi.fn(),closeOwner=vi.fn(),assertAlive=vi.fn()
    const record={protocolVersion:1,role:'serve',host:'127.0.0.1',port:57945,pid:42,createTime:1792520591.609563,startTime:179252059160,home:'',tokenFingerprint:'0123456789abcdef'}
    vi.spyOn(os,'userInfo').mockReturnValue({...os.userInfo(),homedir:'C:\\Users\\fixture'})
    const hold=vi.spyOn(nativeIdentity,'holdProtectedWindowsFile').mockReturnValue({bytes:Buffer.from('0'.repeat(32)),fileIdentity:'fixture',close:closeInstall})
    const read=vi.spyOn(nativeIdentity,'readWindowsV3ProtectedFile').mockReturnValue(JSON.stringify(record))
    const acquire=vi.spyOn(nativeIdentity.HeldWindowsV3Identity,'acquire').mockResolvedValue({anchor:{},assertAlive,close:closeOwner} as unknown as nativeIdentity.HeldWindowsV3Identity)
    const publish=vi.spyOn(nativeIdentity,'publishWindowsV3Policy').mockImplementation((_profile,_bytes,assertOwner)=>assertOwner())
    return {closeInstall,closeOwner,assertAlive,record,hold,read,acquire,publish}
  }
  it('ignores environment path redirection and sends only validated trust metadata to publication',async()=>{
    const f=fixture()
    try {
      vi.stubEnv('USERPROFILE','C:\\attacker');vi.stubEnv('LOCALAPPDATA','C:\\attacker');vi.stubEnv('HERMES_HOME','C:\\attacker');vi.stubEnv('HOME','C:\\attacker')
      await enrollWindowsV3()
      expect(f.hold).toHaveBeenCalledWith('C:\\Users\\fixture\\AppData\\Local\\hermes\\install_id',128,false,true)
      expect(f.acquire).toHaveBeenCalledOnce();expect(f.assertAlive).toHaveBeenCalledOnce()
      expect(f.publish).toHaveBeenCalledOnce()
      const [profile,bytes]=f.publish.mock.calls[0]!
      expect(profile).toBe('C:\\Users\\fixture');expect(bytes[0]).toBe(123)
      expect(parseWindowsV3Policy(JSON.parse(bytes.toString('utf8'))).installId).toBe('0'.repeat(32))
      expect(f.read.mock.calls.every(([file,secret])=>file==='C:\\Users\\fixture\\.local\\state\\hermes\\gateway-locks\\host-serve.json' && !secret)).toBe(true)
      expect(f.closeInstall).toHaveBeenCalledOnce();expect(f.closeOwner).toHaveBeenCalledOnce()
    } finally {vi.restoreAllMocks();vi.unstubAllEnvs()}
  })
  it('does not publish after native package admission fails',async()=>{
    const f=fixture()
    try {
      f.acquire.mockRejectedValue(new Error('package rejected'))
      await expect(enrollWindowsV3()).rejects.toThrow('package rejected')
      expect(f.publish).not.toHaveBeenCalled();expect(f.closeInstall).toHaveBeenCalledOnce()
    } finally {vi.restoreAllMocks()}
  })
  it('rejects native owner substitution while retaining the existing process owner',async()=>{
    const f=fixture()
    try {
      f.read.mockReturnValueOnce(JSON.stringify(f.record)).mockReturnValue(JSON.stringify({...f.record,pid:43}))
      await expect(enrollWindowsV3()).rejects.toThrow('owner changed')
      expect(f.closeOwner).toHaveBeenCalledOnce();expect(f.closeInstall).toHaveBeenCalledOnce()
    } finally {vi.restoreAllMocks()}
  })
  it('refuses explicit V2 selection before reading or creating anything',async()=>{
    const f=fixture()
    try {
      vi.stubEnv('HERALD_OS_ATTACH_CONFIG','C:\\unrelated')
      await expect(enrollWindowsV3()).rejects.toThrow('V3 selection')
      expect(f.hold).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalled()
    } finally {vi.restoreAllMocks();vi.unstubAllEnvs()}
  })
})

describe('explicit Windows V3 policy and untrusted discovery',()=>{
  const policy={version:3,discovery:'hermes-host-v1',home:'C:\\private\\Hermes-Stable',installId:'1234567890abcdef1234567890abcdef',rendezvousDir:'C:\\private\\gateway-locks',packageFamily:'NousResearch.HermesBundled_e60prshbsznhj',minimumPackageVersion:'2026.6864.2132.0',publisher:'CN=Nous Research Inc., O=Nous Research Inc., L=Austin, S=Texas, C=US'}
  const token='synthetic-only-current-generation-token'
  const record={protocolVersion:1,role:'serve',host:'127.0.0.1',port:57945,pid:42,createTime:1792520591.609563,startTime:179252059160,home:'',tokenFingerprint:crypto.createHash('sha256').update(token).digest('hex').slice(0,16),profiles:[],updatedAt:'2026-10-20T19:00:00Z'}
  it('accepts only the exact protected policy schema without persistent process/token/hash',()=>{
    expect(parseWindowsV3Policy(policy)).toEqual(policy)
    for(const bad of [{...policy,version:2},{...policy,process:{pid:42}},{...policy,packageFamily:'NousResearch.HermesCanary_e60prshbsznhj'},{...policy,publisher:'CN=Somebody'},{...policy,minimumPackageVersion:'0.1.0.0'},{...policy,minimumPackageVersion:'2026.70000.0.0'},{...policy,rendezvousDir:'\\\\server\\share'},{...policy,discovery:'desktop-serve'}])expect(()=>parseWindowsV3Policy(bad)).toThrow()
  })
  it('selects only the explicit Desktop publication and requires its matching role',()=>{
    const desktop=parseWindowsV3Policy({...policy,discovery:'hermes-desktop-host-v1'})
    const desktopRecord={...record,role:'desktop-serve'}
    expect(parseWindowsHostRecord(desktopRecord,desktop)).toMatchObject({role:'desktop-serve',pid:42})
    for(const role of ['serve','gateway','DESKTOP-SERVE','',null])expect(()=>parseWindowsHostRecord({...record,role},desktop)).toThrow()
    const read=vi.fn((file:string)=>file.endsWith('.token')?token:JSON.stringify(desktopRecord))
    expect(readWindowsV3Discovery(desktop,read)).toMatchObject({record:{role:'desktop-serve'},token})
    expect(read.mock.calls.map(([file])=>file.split('\\').at(-1))).toEqual(['host-desktop-serve.json','host-desktop-serve.token','host-desktop-serve.json'])
  })
  it('identifies the expected and observed host role without accepting another publication',()=>{
    const desktop=parseWindowsV3Policy({...policy,discovery:'hermes-desktop-host-v1'})
    expect(()=>parseWindowsHostRecord(record,desktop)).toThrow(/Host-Rolle.*desktop-serve.*serve/)
    expect(()=>parseWindowsHostRecord({...record,role:'desktop-serve'},parseWindowsV3Policy(policy))).toThrow(/Host-Rolle.*serve.*desktop-serve/)
    expect(()=>parseWindowsHostRecord({...record,role:'untrusted-secret-marker'},desktop)).toThrow('invalid native host record')
  })
  it.each(['missing','invalid','private-token','changed'])('does not fall back to serve after Desktop %s failure',fault=>{
    const desktop=parseWindowsV3Policy({...policy,discovery:'hermes-desktop-host-v1'})
    let count=0
    const read=vi.fn((file:string)=>{
      if(fault==='missing')throw new Error('missing')
      if(file.endsWith('.token')) { if(fault==='private-token')throw new Error('private token rejected');return token }
      return JSON.stringify({...record,role:fault==='invalid'?'serve':'desktop-serve',port:record.port+(fault==='changed'?count++:0)})
    })
    expect(()=>readWindowsV3Discovery(desktop,read)).toThrow()
    expect(read.mock.calls.length).toBeGreaterThan(0)
    expect(read.mock.calls.every(([file])=>file.includes('host-desktop-serve.'))).toBe(true)
  })
  it('requires private protected-file admission when reading the native policy path',()=>{
    const read=vi.fn(()=>JSON.stringify(policy))
    const info=os.userInfo()
    const userInfo=vi.spyOn(os,'userInfo').mockReturnValue({...info,homedir:'C:\\Users\\PolicyFixture'})
    try {
      expect(readWindowsV3Policy({},read)).toEqual(policy)
      expect(read).toHaveBeenCalledExactlyOnceWith('C:\\Users\\PolicyFixture\\DRAGON_OS\\connection-policy.json',true)
    } finally { userInfo.mockRestore() }
  })
  it.each(['','C:\\fixture\\v2.json'])('refuses V3 before any read for explicit V2 selection %s',config=>{
    const read=vi.fn(()=>JSON.stringify(policy))
    expect(()=>readWindowsV3Policy({HERALD_OS_ATTACH_CONFIG:config},read)).toThrow('cannot fall back')
    expect(read).not.toHaveBeenCalled()
  })
  it('treats a record as a hint and rejects other roles, endpoints, generations and fingerprints',()=>{
    expect(parseWindowsHostRecord(record,parseWindowsV3Policy(policy))).toMatchObject({pid:42,port:57945})
    for(const bad of [{...record,role:'desktop-serve'},{...record,host:'localhost'},{...record,port:65536},{...record,pid:0},{...record,createTime:NaN},{...record,protocolVersion:2},{...record,home:'C:\\different'},{...record,tokenFingerprint:'not-a-fingerprint'}])expect(()=>parseWindowsHostRecord(bad,parseWindowsV3Policy(policy))).toThrow()
  })
  it('requires a stable record/token/record snapshot before exposing a candidate',()=>{
    const reads:{file:string;secret:boolean}[]=[]
    const read=(file:string,secret:boolean)=>{reads.push({file,secret});return file.endsWith('.token')?token:JSON.stringify(record)}
    expect(readWindowsV3Discovery(parseWindowsV3Policy(policy),read)).toMatchObject({record:{pid:42},token,baseUrl:'http://127.0.0.1:57945'})
    expect(reads.map(x=>x.secret)).toEqual([false,true,false])
    let count=0
    expect(()=>readWindowsV3Discovery(parseWindowsV3Policy(policy),file=>file.endsWith('.token')?token:JSON.stringify({...record,port:57945+count++}))).toThrow('publication')
    expect(()=>readWindowsV3Discovery(parseWindowsV3Policy(policy),file=>file.endsWith('.token')?token+'-new':JSON.stringify(record))).toThrow('publication')
  })
})

describe('attachTarget', () => {
  it('is off unless asked for', () => {
    expect(attachTarget({})).toBeNull()
  })

  it('takes a loopback URL and a token from the environment or a file', () => {
    expect(attachTarget({ HERALD_OS_BACKEND_URL: 'http://127.0.0.1:9119/', HERALD_OS_BACKEND_TOKEN: 'secret' })).toEqual({ baseUrl: 'http://127.0.0.1:9119', token: 'secret' })
    expect(attachTarget({ HERALD_OS_BACKEND_URL: 'http://localhost:9119', HERALD_OS_BACKEND_TOKEN_FILE: '/x/token' }, file => (file === '/x/token' ? 'from-file\n' : ''))).toEqual({ baseUrl: 'http://localhost:9119', token: 'from-file' })
  })

  it('refuses anything that would send the token off the machine', () => {
    expect(() => attachTarget({ HERALD_OS_BACKEND_URL: 'http://10.0.0.5:9119', HERALD_OS_BACKEND_TOKEN: 't' })).toThrow(/this machine/)
    expect(() => attachTarget({ HERALD_OS_BACKEND_URL: 'https://127.0.0.1:9119', HERALD_OS_BACKEND_TOKEN: 't' })).toThrow(/http/)
    expect(() => attachTarget({ HERALD_OS_BACKEND_URL: 'http://127.0.0.1:9119' }, () => { throw new Error('missing') })).toThrow(/token/)
  })
})

describe('reverseControlDisabled', () => {
  it('requires both attach-only and explicit reverse-control opt-out', () => {
    expect(reverseControlDisabled({ HERALD_OS_REQUIRE_ATTACHED_BACKEND: '1', HERALD_OS_DISABLE_REVERSE_CONTROL: '1' },'linux')).toBe(true)
    expect(reverseControlDisabled({ HERALD_OS_DISABLE_REVERSE_CONTROL: '1' },'linux')).toBe(false)
    expect(reverseControlDisabled({ HERALD_OS_REQUIRE_ATTACHED_BACKEND: '1' },'linux')).toBe(false)
    expect(reverseControlDisabled({},'win32')).toBe(true)
  })
})

describe('parseGatewayPid', () => {
  it('reads both formats', () => {
    expect(parseGatewayPid('{"pid": 50714, "kind": "hermes-gateway", "hermes_home": "/home/a/.hermes"}')).toEqual({ pid: 50714, home: '/home/a/.hermes' })
    expect(parseGatewayPid('1234\n')).toEqual({ pid: 1234 })
    expect(parseGatewayPid('')).toBeNull()
    expect(parseGatewayPid('{"kind": "x"}')).toBeNull()
  })
})

describe('foreignGateway', () => {
  const home = '/home/a/.hermes'
  const record = JSON.stringify({ pid: 50, hermes_home: home })
  const probe = (parent: number | null, alive = true) => ({ alive: () => alive, parentOf: () => parent, read: () => record })

  it('ignores our own gateway', () => {
    expect(foreignGateway(home, { appPid: 10, backendPid: 20 }, probe(20))).toBeNull()
    expect(foreignGateway(home, { appPid: 10, backendPid: 20 }, probe(10))).toBeNull()
  })

  it('reports one another app started', () => {
    expect(foreignGateway(home, { appPid: 10, backendPid: 20 }, probe(1))).toEqual({ pid: 50 })
  })

  it('ignores dead or other-home records', () => {
    expect(foreignGateway(home, { appPid: 10, backendPid: 20 }, probe(1, false))).toBeNull()
    expect(foreignGateway('/home/b/.hermes', { appPid: 10, backendPid: 20 }, probe(1))).toBeNull()
  })
})

describe('protected Windows V2 attach contract', () => {
  const file = 'C:\\isolated-fixture\\attach.json'
  const tokenFile = 'C:\\isolated-fixture\\token'
  const anchor = { pid: 1234, creationTime: '123456789', ownerSid: 'S-1-5-21-1-2-3-1001', imagePath: 'C:\\isolated-fixture\\core.exe', imageSha256: 'a'.repeat(64) }
  const contract = { version: 2, baseUrl: 'http://127.0.0.1:43210', tokenFile, process: anchor }
  const syntheticToken = 'synthetic-contract-test-token'
  const cases: [string, unknown][] = [
    ['null', null], ['array', []], ['empty object', {}],
    ['legacy version', { ...contract, version: 1 }],
    ['extra field', { ...contract, extra: true }],
    ['missing process', { version: 2, baseUrl: contract.baseUrl, tokenFile }],
    ['remote host', { ...contract, baseUrl: 'http://example.invalid:43210' }],
    ['localhost alias', { ...contract, baseUrl: 'http://localhost:43210' }],
    ['https', { ...contract, baseUrl: 'https://127.0.0.1:43210' }],
    ['trailing path', { ...contract, baseUrl: contract.baseUrl + '/' }],
    ['URL credentials', { ...contract, baseUrl: 'http://user:pass@127.0.0.1:43210' }],
    ['zero port', { ...contract, baseUrl: 'http://127.0.0.1:0' }],
    ['port overflow', { ...contract, baseUrl: 'http://127.0.0.1:65536' }],
    ['missing identity', { ...contract, process: null }],
    ['wrong PID', { ...contract, process: { ...anchor, pid: 0 } }],
    ['unknown identity field', { ...contract, process: { ...anchor, extra: true } }],
    ['relative token path', { ...contract, tokenFile: 'token' }],
    ['ADS token path', { ...contract, tokenFile: tokenFile + ':secret' }]
  ]
  it.each(cases)('rejects %s before opening the token', (_name, value) => {
    const reads: string[] = []
    const read = (path: string) => { reads.push(path); return JSON.stringify(value) }
    expect(() => windowsAttachTarget({ HERALD_OS_ATTACH_CONFIG: file }, read)).toThrow()
    expect(reads).toEqual([file])
  })
  it('rejects malformed JSON before opening the token', () => {
    const reads: string[] = []
    expect(() => windowsAttachTarget({ HERALD_OS_ATTACH_CONFIG: file }, path => { reads.push(path); return '{' })).toThrow()
    expect(reads).toEqual([file])
  })
  it('never reads a file or falls back to legacy env credentials without a protected config', () => {
    let reads = 0
    expect(() => windowsAttachTarget({ HERALD_OS_BACKEND_URL: contract.baseUrl, HERALD_OS_BACKEND_TOKEN: syntheticToken }, () => { reads++; return syntheticToken })).toThrow('Anbindung fehlt')
    expect(reads).toBe(0)
  })
  it('returns the exact protected endpoint, token and identity', () => {
    const reads: string[] = []
    const target = windowsAttachTarget({ HERALD_OS_ATTACH_CONFIG: file }, path => {
      reads.push(path)
      return path === file ? JSON.stringify(contract) : syntheticToken + '\n'
    })
    expect(target).toEqual({ baseUrl: contract.baseUrl, token: syntheticToken, process: anchor })
    expect(reads).toEqual([file, tokenFile])
  })
  it.each(['short', 'invalid token with spaces', 'a'.repeat(4097)])('rejects a malformed synthetic token', token => {
    expect(() => windowsAttachTarget({ HERALD_OS_ATTACH_CONFIG: file }, path => path === file ? JSON.stringify(contract) : token)).toThrow('protected token is invalid')
  })
})
