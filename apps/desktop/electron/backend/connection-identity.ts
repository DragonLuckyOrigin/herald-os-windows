import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'

export interface ProcessAnchor { pid: number; creationTime: string; ownerSid: string; imagePath: string; imageSha256: string }
const INVALID = 0xffffffffffffffffn
const SYSTEM = 'S-1-5-18'
const ADMIN = 'S-1-5-32-544'
const INSTALLER = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
const require = createRequire(import.meta.url)

/** Availability only. Never use this class for failed identity, ACL or authentication checks. */
export class WindowsV3UnavailableError extends Error {}

// V3 native package primitives. These are not an admission decision: callers must bind the
// registration, signature bytes and image to one held process before sending credentials.
function windowsGuid(value: string): Buffer {
  const parts=value.split('-')
  const bytes=Buffer.from(parts.join(''),'hex')
  bytes.subarray(0,4).reverse(); bytes.subarray(4,6).reverse(); bytes.subarray(6,8).reverse()
  return bytes
}

function loadPackageNative() {
  if (process.platform!=='win32' || process.arch!=='x64') throw new Error('SC1 package trust requires Windows x64')
  const root=process.env.SystemRoot
  if (!root || !/^[A-Za-z]:[\\/]/.test(root)) throw new Error('SC1 Windows system directory unavailable')
  const ffi=require('koffi') as typeof import('koffi')
  const runtime=ffi.load(path.win32.join(root,'System32','combase.dll'))
  const trust=ffi.load(path.win32.join(root,'System32','wintrust.dll'))
  const crypt=ffi.load(path.win32.join(root,'System32','crypt32.dll'))
  const shell=ffi.load(path.win32.join(root,'System32','shlwapi.dll'))
  const initialize=runtime.func('int32_t __stdcall RoInitialize(uint32_t mode)')
  const uninitialize=runtime.func('void __stdcall RoUninitialize()')
  const createString=runtime.func('int32_t __stdcall WindowsCreateString(const char16_t *text, uint32_t size, void *result)')
  const deleteString=runtime.func('int32_t __stdcall WindowsDeleteString(void *text)')
  const stringBuffer=runtime.func('void * __stdcall WindowsGetStringRawBuffer(void *text, void *size)')
  const activate=runtime.func('int32_t __stdcall RoActivateInstance(void *name, void *result)')
  const getter=ffi.proto('int32_t',['void *','void *'])
  const query=ffi.proto('int32_t',['void *','void *','void *'])
  const unary=ffi.proto('int32_t',['void *'])
  const find=ffi.proto('int32_t',['void *','void *','void *','void *'])
  const validatedMap=ffi.proto('int32_t',['void *','void *','str16','void *'])
  const mapFile=ffi.proto('int32_t',['void *','str16','void *'])
  const blobType=ffi.struct({size:'uint32_t',subject:ffi.array('uint8_t',16),display:'void *',length:'uint32_t',bytes:'void *',signedLength:'uint32_t',signedBytes:'void *'})
  const trustType=ffi.struct({size:'uint32_t',policy:'void *',sip:'void *',ui:'uint32_t',revocation:'uint32_t',choice:'uint32_t',blob:'void *',action:'uint32_t',state:'void *',url:'void *',flags:'uint32_t',context:'uint32_t',settings:'void *'})
  const verify=trust.func('int32_t __stdcall WinVerifyTrust(void *window, void *action, void *data)')
  const providerData=trust.func('void * __stdcall WTHelperProvDataFromStateData(void *state)')
  const providerSigner=trust.func('void * __stdcall WTHelperGetProvSignerFromChain(void *data,uint32_t index,int countersigner,uint32_t counterIndex)')
  const providerCert=trust.func('void * __stdcall WTHelperGetProvCertFromChain(void *signer,uint32_t index)')
  const certName=crypt.func('uint32_t __stdcall CertGetNameStringW(void *cert,uint32_t type,uint32_t flags,void *parameters,void *text,uint32_t size)')
  const createCom=runtime.func('int32_t __stdcall CoCreateInstance(void *classId,void *outer,uint32_t context,void *interfaceId,void *result)')
  const memoryStream=shell.func('void * __stdcall SHCreateMemStream(void *bytes,uint32_t length)')
  const checked=(code:number) => { if(code<0) throw new Error(`SC1 package API failed (${(code>>>0).toString(16)})`) }
  const pointer=(bytes:Buffer):unknown=>ffi.decode(bytes,'void *')
  const call=(object:unknown,slot:number,type:import('koffi').TypeObject,...args:unknown[]):number=>{
    if(!object) throw new Error('SC1 missing native package object')
    const table=ffi.decode(object,'void *')
    const method=ffi.decode(table,slot*8,'void *')
    if(!method) throw new Error('SC1 missing native package method')
    return ffi.call(method,type,object,...args) as number
  }
  const get=(object:unknown,slot:number,size=8):Buffer=>{const out=Buffer.alloc(size);checked(call(object,slot,getter,out));return out}
  const release=(object:unknown)=>{if(object)call(object,2,unary)}
  const qi=(object:unknown,iid:string):unknown=>{const out=Buffer.alloc(8);checked(call(object,0,query,windowsGuid(iid),out));const result=pointer(out);if(!result)throw new Error('SC1 missing native package interface');return result}
  const hstring=(value:string):unknown=>{const out=Buffer.alloc(8);checked(createString(value,value.length,out));return pointer(out)}
  const text=(object:unknown,slot:number):string=>{
    const value=pointer(get(object,slot))
    try {const size=Buffer.alloc(4),buffer=stringBuffer(value,size),length=size.readUInt32LE();if(length>32768)throw new Error('SC1 native package string exceeds limit');return length?ffi.decode(buffer,'char16_t',length) as string:''}
    finally{deleteString(value)}
  }
  return {ffi,initialize,uninitialize,activate,find,checked,pointer,call,get,release,qi,hstring,deleteString,text,blobType,trustType,verify,unary,providerData,providerSigner,providerCert,certName,createCom,memoryStream,validatedMap,mapFile,query}
}
let packageNativeCache:ReturnType<typeof loadPackageNative>|undefined
const packageNative=()=>packageNativeCache??=loadPackageNative()

/** Microsoft MSIX P7X SIP, using held signature bytes rather than reopening an unchecked path.
 * This checks signature trust, not package content or publisher policy. No UI or network fetch.
 * ABI/reference: microsoft/msix-packaging SignatureValidator.cpp, ValidateCertWithWinVerifyTrust. */
export function verifyWindowsPackageSignature(signature:Buffer):{code:number;publisher:string|null} {
  if(signature.length<8 || signature.length>1024*1024 || signature.subarray(0,4).toString('ascii')!=='PKCX') return {code:0x800b0003,publisher:null}
  const n=packageNative(),blob=Buffer.alloc(n.ffi.sizeof(n.blobType)),data=Buffer.alloc(n.ffi.sizeof(n.trustType))
  n.ffi.encode(blob,n.blobType,{size:blob.length,subject:[...windowsGuid('5598cff1-68db-4340-b57f-1cacf88c9a51')],display:null,length:signature.length,bytes:signature,signedLength:0,signedBytes:null})
  n.ffi.encode(data,n.trustType,{size:data.length,policy:null,sip:null,ui:2,revocation:0,choice:3,blob,action:1,state:null,url:null,flags:0x1000|0x10,context:0,settings:null})
  const action=windowsGuid('00aac56b-cd44-11d0-8cc2-00c04fc295ee')
  try {
    const code=n.verify(INVALID,action,data)>>>0
    if(code!==0)return {code,publisher:null}
    const state=n.ffi.decode(data,n.ffi.offsetof(n.trustType,'state'),'void *')
    const provider=state?n.providerData(state):null
    const signer=provider?n.providerSigner(provider,0,0,0):null
    const chain=signer?n.providerCert(signer,0):null
    if(!chain || (n.ffi.decode(chain,'uint32_t') as number)<16)throw new Error('SC1 verified signer unavailable')
    const cert=n.ffi.decode(chain,8,'void *')
    const format=Buffer.alloc(4);format.writeUInt32LE(3|0x02000000)
    const size=n.certName(cert,2,0,format,null,0)
    if(size<2 || size>32768)throw new Error('SC1 verified signer name unavailable')
    const text=Buffer.alloc(size*2)
    if(n.certName(cert,2,0,format,text,size)!==size)throw new Error('SC1 verified signer name changed')
    return {code,publisher:text.toString('utf16le',0,(size-1)*2)}
  }
  finally {
    // WTD_STATEACTION_CLOSE for success and failure; retain the exact returned provider state.
    data.writeUInt32LE(2,n.ffi.offsetof(n.trustType,'action'))
    n.verify(INVALID,action,data)
    // Keep the backing stores of the embedded native pointers live through VERIFY and CLOSE.
    void blob.byteLength;void signature.byteLength
  }
}

/** Native signed block-map -> held executable binding; no custom XML/hash verifier.
 * signaturePath must remain held against write/delete by the caller for this entire call. */
export function verifyWindowsPackageImage(blockMap:Buffer,signaturePath:string,imageName:string,imageBytes:Buffer):boolean {
  localWindowsPath(signaturePath)
  if(!blockMap.length || blockMap.length>64*1024*1024 || !imageBytes.length || imageBytes.length>256*1024*1024 || !imageName || imageName.split('\\').some(part=>!part || part==='.' || part==='..') || /[:/\x00-\x1f]/.test(imageName))throw new Error('SC1 invalid package content input')
  const n=packageNative(),initialized=n.initialize(1),objects:unknown[]=[]
  if(initialized<0 && (initialized>>>0)!==0x80010106)n.checked(initialized)
  const own=(object:unknown)=>{if(!object)throw new Error('SC1 missing package content object');objects.push(object);return object}
  try {
    const result=Buffer.alloc(8)
    n.checked(n.createCom(windowsGuid('5842a140-ff9f-4166-8f5c-62f5b7b0c781'),null,1,windowsGuid('beb94909-e451-438b-b5a7-d79e767b75d8'),result))
    const factory=own(n.pointer(result)),mapStream=own(n.memoryStream(blockMap,blockMap.length))
    const mapResult=Buffer.alloc(8);n.checked(n.call(factory,7,n.validatedMap,mapStream,signaturePath,mapResult))
    const map=own(n.pointer(mapResult)),fileResult=Buffer.alloc(8)
    n.checked(n.call(map,3,n.mapFile,imageName,fileResult))
    const file=own(n.pointer(fileResult)),imageStream=own(n.memoryStream(imageBytes,imageBytes.length)),valid=Buffer.alloc(4)
    n.checked(n.call(file,7,n.query,imageStream,valid))
    return valid.readInt32LE()!==0
  } finally {
    let failure:unknown
    for(const object of objects.reverse()){try{n.release(object)}catch(error){failure??=error}}
    if(initialized>=0)n.uninitialize()
    void blockMap.byteLength;void imageBytes.byteLength
    if(failure)throw failure
  }
}

export interface RegisteredPackageObservation {
  name:string; fullName:string; family:string; publisher:string; publisherId:string
  version:number[]; architecture:number; developmentMode:boolean; signatureKind:number
  statusOk:boolean; contentIntegrity:boolean
  framework:boolean;resourcePackage:boolean;bundle:boolean;optional:boolean;resourceId:string
}

/** Direct in-process WinRT. No PowerShell, helper executable, service or extra dependency.
 * One operation per admission; COM references and HSTRINGs are released on every exit.
 * This returns observations only; no token is read, socket opened, or trust policy inferred. */
export async function inspectRegisteredWindowsPackage(fullName:string,userSid:string,signal?:AbortSignal):Promise<RegisteredPackageObservation> {
  if(!/^[A-Za-z0-9._-]{1,255}$/.test(fullName) || !/^S-1-5-(?:\d+-)*\d+$/.test(userSid)) throw new Error('SC1 invalid package lookup')
  const n=packageNative(),initialized=n.initialize(1),objects:unknown[]=[],strings:unknown[]=[]
  // Electron may already own an STA. Poll the async object without blocking its message loop.
  if(initialized<0 && (initialized>>>0)!==0x80010106) n.checked(initialized)
  const own=(object:unknown)=>{if(!object)throw new Error('SC1 package registration unavailable');objects.push(object);return object}
  const str=(value:string)=>{const s=n.hstring(value);strings.push(s);return s}
  let asyncInfo:unknown,operation:unknown,finished=false
  try {
    signal?.throwIfAborted()
    const activated=Buffer.alloc(8);n.checked(n.activate(str('Windows.Management.Deployment.PackageManager'),activated))
    const instance=own(n.pointer(activated)),manager=own(n.qi(instance,'9a7d4b65-5e8f-4fc7-a2e5-7f6925cb8b53'))
    const result=Buffer.alloc(8);n.checked(n.call(manager,21,n.find,str(userSid),str(fullName),result))
    const pack=own(n.pointer(result)),id=own(n.pointer(n.get(pack,6)))
    const p2=own(n.qi(pack,'a6612fb6-7688-4ace-95fb-359538e7aa01'))
    const p3=own(n.qi(pack,'5f738b61-f86a-4917-93d1-f1ee9d3b35d9'))
    const p4=own(n.qi(pack,'65aed1ae-b95b-450c-882b-6255187f397e'))
    const status=own(n.pointer(n.get(p3,6))),version=n.get(id,7)
    const facts={name:n.text(id,6),fullName:n.text(id,12),family:n.text(id,13),publisher:n.text(id,10),publisherId:n.text(id,11),version:[0,2,4,6].map(offset=>version.readUInt16LE(offset)),architecture:n.get(id,8).readInt32LE(),developmentMode:n.get(p2,12)[0]!==0,signatureKind:n.get(p4,6).readInt32LE(),statusOk:n.get(status,6)[0]!==0,framework:n.get(pack,8)[0]!==0,resourcePackage:n.get(p2,10)[0]!==0,bundle:n.get(p2,11)[0]!==0,optional:n.get(p4,7)[0]!==0,resourceId:n.text(id,9)}
    if(facts.fullName!==fullName) throw new Error('SC1 package registration changed')
    operation=own(n.pointer(n.get(p4,8)))
    asyncInfo=own(n.qi(operation,'00000036-0000-0000-c000-000000000046'))
    const deadline=performance.now()+30_000
    for(;;) {
      signal?.throwIfAborted()
      const state=n.get(asyncInfo,7).readInt32LE()
      if(state===1) {finished=true;const contentIntegrity=n.get(operation,8)[0]!==0;return {...facts,statusOk:facts.statusOk && n.get(status,6)[0]!==0,contentIntegrity}}
      if(state!==0) throw new Error('SC1 native content verification failed or cancelled')
      if(performance.now()>=deadline) throw new Error('SC1 native content verification timed out')
      await new Promise(resolve=>setTimeout(resolve,25))
    }
  } finally {
    let failure:unknown
    if(asyncInfo){try{
      if(!finished)n.checked(n.call(asyncInfo,9,n.unary))
      // IAsyncInfo.Close is only valid after completion. Cancellation is a request,
      // not proof of completion; release our references without masking the original error.
      if(finished || n.get(asyncInfo,7).readInt32LE()!==0)n.checked(n.call(asyncInfo,10,n.unary))
    }catch(error){if(finished)failure??=error}}
    for(const object of objects.reverse()){try{n.release(object)}catch(error){failure??=error}}
    for(const value of strings.reverse()){try{n.deleteString(value)}catch(error){failure??=error}}
    if(initialized>=0)n.uninitialize()
    if(failure)throw failure
  }
}

export function localWindowsPath(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z]:\\/.test(value) || value.slice(2).includes(':') || /[\x00-\x1f/]/.test(value) || value.split('\\').slice(1).some(p => !p || p === '.' || p === '..' || /[ .]$/.test(p))) throw new Error('SC1 requires a canonical local Windows path')
  return value
}

export function parseProcessAnchor(value: unknown): ProcessAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SC1 process identity is missing')
  const p = value as Record<string, unknown>
  if (Object.keys(p).sort().join(',') !== 'creationTime,imagePath,imageSha256,ownerSid,pid' || !Number.isSafeInteger(p.pid) || Number(p.pid) < 1 || Number(p.pid) > 0xffffffff || typeof p.creationTime !== 'string' || !/^[1-9][0-9]{0,19}$/.test(p.creationTime) || BigInt(p.creationTime) > 0xffffffffffffffffn || typeof p.ownerSid !== 'string' || !/^S-1-5-(?:\d+-)*\d+$/.test(p.ownerSid) || typeof p.imageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.imageSha256)) throw new Error('SC1 process identity is invalid')
  localWindowsPath(p.imagePath)
  return { pid: Number(p.pid), creationTime: p.creationTime, ownerSid: p.ownerSid, imagePath: p.imagePath as string, imageSha256: p.imageSha256 }
}

/** MIB_TCPTABLE_OWNER_PID, AF_INET: ports are network-order DWORD fields. */
export function parseTcpOwners(table: Buffer, serverPort: number, clientPort: number): number[] {
  if (table.length < 4) throw new Error('SC1 invalid TCP table')
  const count = table.readUInt32LE(0)
  if (count > 100_000 || 4 + count * 24 > table.length) throw new Error('SC1 truncated TCP table')
  const owners: number[] = []
  for (let i = 0; i < count; i++) {
    const o = 4 + i * 24
    if (table.readUInt32LE(o) === 5 && table.subarray(o+4,o+8).equals(Buffer.from([127,0,0,1])) && table.subarray(o+12,o+16).equals(Buffer.from([127,0,0,1])) && table.readUInt16BE(o+8) === serverPort && table.readUInt16BE(o+16) === clientPort) owners.push(table.readUInt32LE(o+20))
  }
  return owners
}

/** Existing owner/grantee policy, evaluated separately for each held object's descriptor.
 * OWNER RIGHTS denotes that object's owner, including when inherited. It is not a trusted
 * principal by itself. Package-tree ACE interpretation remains unchanged. Denies and masks
 * are still handled conservatively by acl(); this is not an effective-access calculator. */
export function windowsFileTrust(ownerSid:string,current:string,directory:boolean,secret:boolean,packageTree=false):(aceSid:string)=>boolean {
  const trusted=new Set(packageTree?[SYSTEM,ADMIN,INSTALLER]:[current,SYSTEM,ADMIN,INSTALLER])
  if (!(packageTree?new Set([SYSTEM,INSTALLER]):secret && !directory ? new Set([current,SYSTEM]) : trusted).has(ownerSid)) throw new Error('SC1 untrusted file owner')
  const allowed=secret && !directory ? new Set([current,SYSTEM]) : trusted
  return aceSid=>allowed.has(!packageTree && aceSid==='S-1-3-4' ? ownerSid : aceSid)
}

function loadNative() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('SC1 identity requires native Windows x64')
  const root = process.env.SystemRoot
  if (!root || !/^[A-Za-z]:[\\/]/.test(root)) throw new Error('SC1 Windows system directory unavailable')
  const ffi = require('koffi') as typeof import('koffi')
  const kernel = ffi.load(path.win32.join(root,'System32','kernel32.dll'))
  const security = ffi.load(path.win32.join(root,'System32','advapi32.dll'))
  const ip = ffi.load(path.win32.join(root,'System32','iphlpapi.dll'))
  const close = kernel.func('int __stdcall CloseHandle(void *handle)')
  const last = kernel.func('uint32_t __stdcall GetLastError()')
  const free = kernel.func('void * __stdcall LocalFree(void *memory)')
  const openProcess = kernel.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)')
  const times = kernel.func('int __stdcall GetProcessTimes(void *process, void *created, void *exited, void *kernel, void *user)')
  const image = kernel.func('int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *name, _Inout_ uint32_t *size)')
  const wait = kernel.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)')
  const tokenOpen = security.func('int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)')
  const tokenInfo = security.func('int __stdcall GetTokenInformation(void *token, int kind, void *data, uint32_t size, _Out_ uint32_t *needed)')
  const sidString = security.func('int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)')
  const getSecurity = security.func('uint32_t __stdcall GetSecurityInfo(void *handle, int kind, uint32_t requested, _Out_ void **owner, void *group, void *dacl, void *sacl, _Out_ void **descriptor)')
  const getDacl = security.func('int __stdcall GetSecurityDescriptorDacl(void *descriptor, _Out_ int *present, _Out_ void **acl, _Out_ int *defaulted)')
  const getControl = security.func('int __stdcall GetSecurityDescriptorControl(void *descriptor, _Out_ uint16_t *control, _Out_ uint32_t *revision)')
  const openFile = kernel.func('void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)')
  const info = kernel.func('int __stdcall GetFileInformationByHandle(void *handle, void *info)')
  const read = kernel.func('int __stdcall ReadFile(void *handle, void *buffer, uint32_t length, _Out_ uint32_t *count, void *overlapped)')
  const drive = kernel.func('uint32_t __stdcall GetDriveTypeW(const char16_t *root)')
  const volume = kernel.func('int __stdcall GetVolumeInformationW(const char16_t *root, void *name, uint32_t nameSize, void *serial, void *componentLength, void *flags, void *filesystem, uint32_t filesystemSize)')
  const finalPath=kernel.func('uint32_t __stdcall GetFinalPathNameByHandleW(void *file,void *text,uint32_t size,uint32_t flags)')
  const packageFullName=kernel.func('int32_t __stdcall GetPackageFullName(void *process,_Inout_ uint32_t *size,void *text)')
  const packageFamilyName=kernel.func('int32_t __stdcall GetPackageFamilyName(void *process,_Inout_ uint32_t *size,void *text)')
  const packagePath=kernel.func('int32_t __stdcall GetPackagePathByFullName(const char16_t *name,_Inout_ uint32_t *size,void *text)')
  const tcp = ip.func('uint32_t __stdcall GetExtendedTcpTable(void *table, _Inout_ uint32_t *size, int order, uint32_t family, int kind, uint32_t reserved)')
  const checked = (ok: unknown) => { if (!ok) throw new Error(`SC1 native operation failed (${last()})`) }
  function sidText(sid: unknown): string {
    const text = [null]; checked(sidString(sid,text))
    try { return ffi.decode(text[0], 'char16_t', -1) as string } finally { free(text[0]) }
  }
  function owner(processHandle: unknown): string {
    const token = [null]; checked(tokenOpen(processHandle,8,token))
    try {
      const needed=[0]; tokenInfo(token[0],1,null,0,needed)
      if (needed[0]! < 16 || needed[0]! > 65536) throw new Error('SC1 invalid owner information')
      const memory=ffi.alloc('uint8_t',needed[0]!)
      try { checked(tokenInfo(token[0],1,memory,needed[0]!,needed)); return sidText(ffi.decode(memory,'void *')) } finally { ffi.free(memory) }
    } finally { close(token[0]) }
  }
  function acl(handle: unknown, current: string, directory: boolean, leaf: boolean, secret: boolean, packageTree=false) {
    const descriptor=[null], actualOwner=[null]
    const code=getSecurity(handle,1,1|4,actualOwner,null,null,null,descriptor)
    if (code) throw new Error(`SC1 cannot inspect file security (${code})`)
    try {
      const trusts=windowsFileTrust(sidText(actualOwner[0]),current,directory,secret,packageTree)
      const present=[0], defaulted=[0], dacl=[null], control=[0], revision=[0]
      checked(getDacl(descriptor[0],present,dacl,defaulted)); checked(getControl(descriptor[0],control,revision))
      if (!present[0] || !dacl[0] || defaulted[0] || (secret && !directory && !(control[0]! & 0x1000))) throw new Error('SC1 explicit protected file DACL required')
      const length=ffi.decode(dacl[0],2,'uint16_t') as number
      if (length < 8 || length > 65535) throw new Error('SC1 invalid DACL size')
      const bytes=Buffer.from(ffi.decode(dacl[0],'uint8_t',length))
      const count=bytes.readUInt16LE(4); let offset=8
      for (let i=0;i<count;i++) {
        if (offset+8>length) throw new Error('SC1 invalid ACE')
        const type=bytes[offset]!, flags=bytes[offset+1]!, size=bytes.readUInt16LE(offset+2)
        const conditional=packageTree && (type===9 || type===10)
        if ((type !== 0 && type !== 1 && !conditional) || size < 16 || size%4 || offset+size>length) throw new Error('SC1 unsupported ACE')
        const sidLength=8+bytes[offset+9]!*4
        if (bytes[offset+8]!==1 || bytes[offset+9]!>15 || (conditional?8+sidLength>size:8+sidLength!==size)) throw new Error('SC1 invalid ACE SID')
        const aceSid=sidText(ffi.as(bytes.subarray(offset+8,offset+8+sidLength),'void *'))
        const rights=bytes.readUInt32LE(offset+4)
        if ((type===0 || type===9) && !(flags&8)) {
          // On ancestors, prevent deletion/replacement/security takeover. On the containing
          // directory and image also prevent writes. A secret permits no untrusted read grant.
          const forbidden=secret && !directory ? 0xf00f01ff : (0x500d0040 | (!directory || leaf ? 0x116 : 0))
          if (!trusts(aceSid) && (rights & forbidden)) throw new Error('SC1 file or ancestry is accessible to an untrusted account')
        }
        offset+=size
      }
      if (offset>length) throw new Error('SC1 invalid ACL bounds')
    } finally { free(descriptor[0]) }
  }
  return { ffi, kernel, security, free, close, openProcess, times, image, wait, owner, checked, acl, openFile, info, read, drive, volume, tcp, last,finalPath,packageFullName,packageFamilyName,packagePath }
}
let cached: ReturnType<typeof loadNative> | undefined
const native = () => cached ??= loadNative()

/** Same handles establish ancestry, DACL, identity and bytes; no path-based read after validation.
 * No delete sharing on ancestors and no write/delete sharing on the leaf until release. */
export function holdProtectedWindowsFile(file: string, maxBytes=16384, secret=true, v3=false): { bytes: Buffer; fileIdentity:string; close(): void } {
  localWindowsPath(file)
  const n=native(), handles: unknown[]=[], current=n.owner(INVALID)
  const root=file.slice(0,3), filesystem=Buffer.alloc(64)
  if (n.drive(root)!==3) throw new Error('SC1 requires a fixed local drive')
  n.checked(n.volume(root,null,0,null,null,null,filesystem,32))
  if (filesystem.toString('utf16le').split('\0')[0] !== 'NTFS') throw new Error('SC1 requires NTFS')
  let released=false
  const close=() => { if (!released) { released=true; for(const h of handles.reverse()) n.close(h) } }
  try {
    const parts=file.slice(3).split('\\')
    const directories=[root,...parts.slice(0,-1).map((_,i)=>root+parts.slice(0,i+1).join('\\'))]
    for (const [i,directory] of directories.entries()) {
      const h=n.openFile(directory,v3?0x20081:0x20080,3,null,3,0x02200000,null)
      if (!h || h===INVALID) {
        if(v3 && [2,3,32].includes(n.last())) throw new WindowsV3UnavailableError('SC1 discovery publication unavailable')
        throw new Error('SC1 cannot hold protected ancestry')
      }
      handles.push(h); const information=Buffer.alloc(52); n.checked(n.info(h,information))
      if (!(information.readUInt32LE(0)&0x10) || information.readUInt32LE(0)&0x400) throw new Error('SC1 reparse ancestry rejected')
      n.acl(h,current,true,i===directories.length-1,secret)
    }
    const h=n.openFile(file,0x80020000,1,null,3,0x00200000,null)
    if (!h || h===INVALID) {
      if(v3 && [2,3,32].includes(n.last())) throw new WindowsV3UnavailableError('SC1 discovery publication unavailable')
      throw new Error('SC1 cannot hold protected file')
    }
    handles.push(h); const information=Buffer.alloc(52); n.checked(n.info(h,information))
    if (information.readUInt32LE(0)&(0x10|0x400) || information.readUInt32LE(40)!==1) throw new Error('SC1 reparse, directory or hard-linked file rejected')
    const size=information.readUInt32LE(32)*0x100000000+information.readUInt32LE(36)
    if (size<1 || size>maxBytes) throw new Error('SC1 protected file size rejected')
    n.acl(h,current,false,true,secret)
    const bytes=Buffer.alloc(size), read=[0]; n.checked(n.read(h,bytes,size,read,null))
    if (read[0]!==size) throw new Error('SC1 protected file changed during read')
    return { bytes, fileIdentity:information.subarray(28,32).toString('hex')+information.subarray(44,52).toString('hex'), close }
  } catch(error) { close(); throw error }
}

/** Short-lived private policy/token or public-but-write-protected discovery read. */
export function readWindowsV3ProtectedFile(file:string,secret:boolean):string {
  const held=holdProtectedWindowsFile(file,16384,secret,true)
  try{return held.bytes.toString('utf8')}finally{held.bytes.fill(0);held.close()}
}

/** Exclusive enrollment only. A failure leaves its new directory for manual assessment;
 * neither existing objects nor incomplete publications are adopted, repaired or removed. */
export function publishWindowsV3Policy(profile:string,bytes:Buffer,assertOwner:()=>void):void {
  localWindowsPath(profile)
  if(bytes.length<1 || bytes.length>16384)throw new Error('SC1 enrollment size rejected')
  const n=native(),current=n.owner(INVALID),handles:unknown[]=[],root=profile.slice(0,3)
  const nt=n.ffi.load(path.win32.join(process.env.SystemRoot!,'System32','ntdll.dll'))
  const create=nt.func('int32_t __stdcall NtCreateFile(_Out_ void **handle,uint32_t access,void *attributes,void *status,void *allocation,uint32_t fileAttributes,uint32_t share,uint32_t disposition,uint32_t options,void *ea,uint32_t eaLength)')
  const rename=nt.func('int32_t __stdcall NtSetInformationFile(void *handle,void *status,void *information,uint32_t size,uint32_t kind)')
  const convert=n.security.func('int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *text,uint32_t revision,_Out_ void **descriptor,void *size)')
  const getSecurity=n.security.func('uint32_t __stdcall GetSecurityInfo(void *handle,int kind,uint32_t requested,_Out_ void **owner,void *group,void *dacl,void *sacl,_Out_ void **descriptor)')
  const getDacl=n.security.func('int __stdcall GetSecurityDescriptorDacl(void *descriptor,_Out_ int *present,_Out_ void **acl,_Out_ int *defaulted)')
  const getControl=n.security.func('int __stdcall GetSecurityDescriptorControl(void *descriptor,_Out_ uint16_t *control,_Out_ uint32_t *revision)')
  const write=n.kernel.func('int __stdcall WriteFile(void *handle,void *buffer,uint32_t size,_Out_ uint32_t *written,void *overlapped)')
  const flush=n.kernel.func('int __stdcall FlushFileBuffers(void *handle)')
  const seek=n.kernel.func('int __stdcall SetFilePointerEx(void *handle,int64_t distance,void *newPosition,uint32_t method)')
  const unicode=n.ffi.struct({length:'uint16_t',maximum:'uint16_t',buffer:'void *'})
  const attributes=n.ffi.struct({length:'uint32_t',root:'void *',name:'void *',flags:'uint32_t',descriptor:'void *',qos:'void *'})
  const descriptor=[null]
  function aclBytes(sd:unknown):Buffer {
    const present=[0],defaulted=[0],dacl=[null],control=[0],revision=[0]
    n.checked(getDacl(sd,present,dacl,defaulted));n.checked(getControl(sd,control,revision))
    if(!present[0] || !dacl[0] || defaulted[0] || !(control[0]!&0x1000))throw new Error('SC1 creation DACL not protected')
    const length=n.ffi.decode(dacl[0],2,'uint16_t') as number
    if(length<8 || length>65535)throw new Error('SC1 creation DACL invalid')
    return Buffer.from(n.ffi.decode(dacl[0],'uint8_t',length))
  }
  function inspect(handle:unknown,directory:boolean):Buffer {
    const information=Buffer.alloc(52);n.checked(n.info(handle,information))
    if(Boolean(information.readUInt32LE(0)&0x10)!==directory || information.readUInt32LE(0)&0x400 || (!directory && information.readUInt32LE(40)!==1))throw new Error('SC1 created object substituted')
    n.acl(handle,current,directory,true,true)
    const actual=[null],owner=[null]
    const code=getSecurity(handle,1,1|4,owner,null,null,null,actual)
    if(code)throw new Error('SC1 creation security unavailable')
    try {if(!aclBytes(actual[0]).equals(aclBytes(descriptor[0])))throw new Error('SC1 creation security changed')}
    finally{n.free(actual[0])}
    return information
  }
  function exclusive(parent:unknown,name:string,directory:boolean):unknown {
    const text=Buffer.from(name+'\0','utf16le'),string=Buffer.alloc(n.ffi.sizeof(unicode)),object=Buffer.alloc(n.ffi.sizeof(attributes)),status=Buffer.alloc(16),handle=[null]
    n.ffi.encode(string,unicode,{length:text.length-2,maximum:text.length,buffer:text})
    n.ffi.encode(object,attributes,{length:object.length,root:parent,name:string,flags:0x40,descriptor:descriptor[0],qos:null})
    // FILE_CREATE relative to the held parent; the final DACL and returned handle are atomic.
    const code=create(handle,directory?0x1200a0:0x0013019f,object,status,null,0,directory?3:0,2,0x00200020|(directory?1:0x42),null,0)
    if(code<0)throw new Error(`SC1 exclusive enrollment refused (${code})`)
    if(handle[0])handles.push(handle[0])
    if(!handle[0] || status.readBigUInt64LE(8)!==2n)throw new Error('SC1 enrollment did not create a new object')
    inspect(handle[0],directory)
    return handle[0]
  }
  try {
    const filesystem=Buffer.alloc(64)
    if(n.drive(root)!==3)throw new Error('SC1 enrollment requires fixed local NTFS')
    n.checked(n.volume(root,null,0,null,null,null,filesystem,32))
    if(filesystem.toString('utf16le').split('\0')[0]!=='NTFS')throw new Error('SC1 enrollment requires NTFS')
    const parts=profile.slice(3).split('\\'),directories=[root,...parts.map((_,i)=>root+parts.slice(0,i+1).join('\\'))]
    for(const directory of directories) {
      const h=n.openFile(directory,0x20081,3,null,3,0x02200000,null)
      if(!h || h===INVALID)throw new Error('SC1 cannot hold enrollment ancestry')
      handles.push(h);const info=Buffer.alloc(52);n.checked(n.info(h,info))
      if(!(info.readUInt32LE(0)&0x10) || info.readUInt32LE(0)&0x400 || finalWindowsPath(h).toLowerCase()!==directory.toLowerCase())throw new Error('SC1 enrollment ancestry substituted')
      n.acl(h,current,true,directory===profile,true)
    }
    assertOwner()
    n.checked(convert(`O:${current}D:P(A;;FA;;;${current})(A;;FA;;;SY)`,1,descriptor,null))
    const directory=exclusive(handles[handles.length-1],'DRAGON_OS',true)
    const file=exclusive(directory,`.connection-policy.${crypto.randomBytes(16).toString('hex')}.tmp`,false)
    const before=inspect(file,false),written=[0]
    n.checked(write(file,bytes,bytes.length,written,null))
    if(written[0]!==bytes.length)throw new Error('SC1 incomplete enrollment write')
    n.checked(flush(file));n.checked(seek(file,0,null,0))
    const readback=Buffer.alloc(bytes.length),count=[0];n.checked(n.read(file,readback,readback.length,count,null))
    if(count[0]!==bytes.length || !readback.equals(bytes))throw new Error('SC1 enrollment readback mismatch')
    const after=inspect(file,false)
    if(before.readUInt32LE(28)!==after.readUInt32LE(28) || !before.subarray(44,52).equals(after.subarray(44,52)))throw new Error('SC1 enrollment file identity changed')
    assertOwner()
    inspect(file,false)
    const name=Buffer.from('connection-policy.json','utf16le'),renamed=Buffer.alloc(20+name.length),status=Buffer.alloc(16)
    n.ffi.encode(renamed,8,'void *',directory);renamed.writeUInt32LE(name.length,16);name.copy(renamed,20)
    // FileRenameInformation, ReplaceIfExists=false. No path reopening, replacement or cleanup.
    if(rename(file,status,renamed,renamed.length,10)<0)throw new Error('SC1 exclusive enrollment publication failed')
    inspect(file,false)
    handles.pop();n.close(file)
    const final=holdProtectedWindowsFile(path.win32.join(profile,'DRAGON_OS','connection-policy.json'),16384,true,true)
    try {
      if(final.fileIdentity!==before.subarray(28,32).toString('hex')+before.subarray(44,52).toString('hex') || !final.bytes.equals(bytes))throw new Error('SC1 published policy readback mismatch')
      assertOwner()
    }
    finally{final.bytes.fill(0);final.close()}
  } finally {for(const handle of handles.reverse())n.close(handle);if(descriptor[0])n.free(descriptor[0])}
}

function nativePackageString(query:(size:number[],text:Buffer|null)=>number,maximum:number):string {
  const size=[0]
  if(query(size,null)!==122 || size[0]!<2 || size[0]!>maximum)throw new Error('SC1 process package identity unavailable')
  const bytes=Buffer.alloc(size[0]!*2),capacity=size[0]!
  if(query(size,bytes)!==0 || size[0]!<2 || size[0]!>capacity || bytes.readUInt16LE((size[0]!-1)*2)!==0)throw new Error('SC1 process package identity changed')
  const value=bytes.toString('utf16le',0,(size[0]!-1)*2)
  if(value.includes('\0'))throw new Error('SC1 invalid process package identity')
  return value
}

function finalWindowsPath(handle:unknown):string {
  const bytes=Buffer.alloc(65536),length=native().finalPath(handle,bytes,32768,0)
  if(length<1 || length>=32768)throw new Error('SC1 cannot resolve held package file')
  const value=bytes.toString('utf16le',0,length*2)
  if(!value.startsWith('\\\\?\\'))throw new Error('SC1 nonlocal package path')
  const local=value.slice(4)
  // The ancestry walk also resolves the volume root, which is not a file-policy path.
  return /^[A-Za-z]:\\$/.test(local) ? local : localWindowsPath(local)
}

/** The only WindowsApps substitution. It is usable solely after native process/registration
 * binding. Every package descendant remains SYSTEM/TI-owned and protected against user writes. */
function holdWindowsPackageFile(file:string,packageRoot:string,maxBytes:number):{bytes:Buffer;close():void} {
  localWindowsPath(file);localWindowsPath(packageRoot)
  const parent=path.win32.dirname(packageRoot)
  if(path.win32.basename(parent).toLowerCase()!=='windowsapps' || !file.toLowerCase().startsWith(packageRoot.toLowerCase()+'\\'))throw new Error('SC1 image outside registered package')
  const n=native(),handles:unknown[]=[],current=n.owner(INVALID),driveRoot=file.slice(0,3),filesystem=Buffer.alloc(64)
  if(n.drive(driveRoot)!==3)throw new Error('SC1 package requires fixed local NTFS')
  n.checked(n.volume(driveRoot,null,0,null,null,null,filesystem,32))
  if(filesystem.toString('utf16le').split('\0')[0]!=='NTFS')throw new Error('SC1 package requires NTFS')
  let serial:number|undefined,released=false
  const close=()=>{if(!released){released=true;for(const h of handles.reverse())n.close(h)}}
  const parts=file.slice(3).split('\\'),directories=[driveRoot,...parts.slice(0,-1).map((_,i)=>driveRoot+parts.slice(0,i+1).join('\\'))]
  try {
    for(const directory of directories) {
      if(directory.toLowerCase()===parent.toLowerCase())continue
      const h=n.openFile(directory,0x20081,3,null,3,0x02200000,null)
      if(!h || h===INVALID)throw new Error('SC1 cannot hold registered package ancestry')
      handles.push(h);const info=Buffer.alloc(52);n.checked(n.info(h,info))
      serial??=info.readUInt32LE(28)
      if(!(info.readUInt32LE(0)&0x10) || info.readUInt32LE(0)&0x400 || info.readUInt32LE(28)!==serial || finalWindowsPath(h).toLowerCase()!==directory.toLowerCase())throw new Error('SC1 ambiguous package ancestry')
      const packaged=directory.toLowerCase()===packageRoot.toLowerCase() || directory.toLowerCase().startsWith(packageRoot.toLowerCase()+'\\')
      n.acl(h,current,true,packaged,false,packaged)
    }
    const h=n.openFile(file,0x80020000,1,null,3,0x00200000,null)
    if(!h || h===INVALID)throw new Error('SC1 cannot hold package file')
    handles.push(h);const info=Buffer.alloc(52);n.checked(n.info(h,info))
    if(info.readUInt32LE(0)&(0x10|0x400) || info.readUInt32LE(40)!==1 || info.readUInt32LE(28)!==serial || finalWindowsPath(h).toLowerCase()!==file.toLowerCase())throw new Error('SC1 ambiguous package file')
    n.acl(h,current,false,true,false,true)
    const size=info.readUInt32LE(32)*0x100000000+info.readUInt32LE(36)
    if(size<1 || size>maxBytes)throw new Error('SC1 package file size rejected')
    const bytes=Buffer.alloc(size),count=[0];n.checked(n.read(h,bytes,size,count,null))
    if(count[0]!==size)throw new Error('SC1 package file changed during read')
    return {bytes,close}
  }catch(error){close();throw error}
}

export interface VerifiedWindowsIdentity { readonly anchor:ProcessAnchor;assertAlive():void;verifySocket(socket:net.Socket,port:number):void;close():void }
export interface WindowsPackagePolicy { packageFamily:string;publisher:string;minimumPackageVersion:string }
export function fileTimeToHostCreateTime(time:bigint):number {
  // Qualified against the packaged psutil 7.2.2 and native records. The exact anchor remains
  // the FILETIME from the held handle; never reconstruct it from the rounded JSON double.
  return Number(time-116444736000000000n)/10_000_000
}
export function hostStartFingerprint(createTime:number):number {
  // gateway.status uses Python round(create_time * 100), including ties to even.
  const scaled=createTime*100,lower=Math.floor(scaled)
  return scaled-lower===0.5 ? lower+(lower%2) : Math.round(scaled)
}

export class HeldWindowsV3Identity implements VerifiedWindowsIdentity {
  private closed=false
  private constructor(private readonly handle:unknown,readonly anchor:ProcessAnchor,readonly packageFullName:string,readonly packageRoot:string) {}
  static async acquire(record:{pid:number;createTime:number;startTime:number},policy:WindowsPackagePolicy,signal?:AbortSignal):Promise<HeldWindowsV3Identity> {
    if(!Number.isSafeInteger(record.pid) || record.pid<1 || record.pid>0xffffffff || !Number.isFinite(record.createTime))throw new Error('SC1 invalid discovery process')
    const n=native(),handle=n.openProcess(0x101000,0,record.pid)
    if(!handle){if(n.last()===87)throw new WindowsV3UnavailableError('SC1 native owner unavailable');throw new Error('SC1 cannot inspect discovered process')}
    let identity:HeldWindowsV3Identity|undefined
    const temporary:ReturnType<typeof holdWindowsPackageFile>[]=[]
    try {
      signal?.throwIfAborted()
      if(n.wait(handle,0)!==258)throw new WindowsV3UnavailableError('SC1 native owner exited')
      const created=Buffer.alloc(8);n.checked(n.times(handle,created,Buffer.alloc(8),Buffer.alloc(8),Buffer.alloc(8)))
      const time=created.readBigUInt64LE(),hostTime=fileTimeToHostCreateTime(time)
      if(hostTime!==record.createTime || hostStartFingerprint(hostTime)!==record.startTime)throw new WindowsV3UnavailableError('SC1 stale discovery generation')
      const owner=n.owner(handle)
      if(owner!==n.owner(INVALID))throw new Error('SC1 discovered process belongs to another user')
      const image=Buffer.alloc(65536),length=[32768];n.checked(n.image(handle,0,image,length))
      const imagePath=localWindowsPath(image.toString('utf16le',0,length[0]!*2))
      const full=nativePackageString((size,text)=>n.packageFullName(handle,size,text),256)
      const family=nativePackageString((size,text)=>n.packageFamilyName(handle,size,text),128)
      if(family!==policy.packageFamily || family!=='NousResearch.HermesBundled_e60prshbsznhj')throw new Error('SC1 wrong native package family')
      const root=localWindowsPath(nativePackageString((size,text)=>n.packagePath(full,size,text),32768))
      if(!imagePath.toLowerCase().startsWith(root.toLowerCase()+'\\') || path.win32.basename(root)!==full)throw new Error('SC1 executable outside native package')
      identity=new HeldWindowsV3Identity(handle,{pid:record.pid,creationTime:time.toString(),ownerSid:owner,imagePath,imageSha256:''},full,root)
      const imageFile=holdWindowsPackageFile(imagePath,root,256*1024*1024);temporary.push(imageFile)
      const signaturePath=path.win32.join(root,'AppxSignature.p7x')
      const signature=holdWindowsPackageFile(signaturePath,root,1024*1024);temporary.push(signature)
      const blockMap=holdWindowsPackageFile(path.win32.join(root,'AppxBlockMap.xml'),root,64*1024*1024);temporary.push(blockMap)
      const signatureResult=verifyWindowsPackageSignature(signature.bytes)
      if(signatureResult.code!==0 || signatureResult.publisher!==policy.publisher || policy.publisher!=='CN=Nous Research Inc., O=Nous Research Inc., L=Austin, S=Texas, C=US')throw new Error('SC1 package signature or publisher rejected')
      const facts=await inspectRegisteredWindowsPackage(full,owner,signal)
      signal?.throwIfAborted();identity.assertAlive()
      if(facts.name!=='NousResearch.HermesBundled' || facts.fullName!==full || facts.family!==family || facts.publisher!==signatureResult.publisher || facts.publisherId!=='e60prshbsznhj' || facts.architecture!==9 || facts.developmentMode || facts.framework || facts.resourcePackage || facts.bundle || facts.optional || facts.resourceId!=='' || ![1,2,3].includes(facts.signatureKind) || !facts.statusOk || !facts.contentIntegrity)throw new Error('SC1 registered package trust rejected')
      const minimum=policy.minimumPackageVersion.split('.').map(Number)
      if(minimum.length!==4 || minimum.some(value=>!Number.isInteger(value) || value<0 || value>65535))throw new Error('SC1 invalid minimum package version')
      const packed=(parts:number[])=>parts.reduce((v,p)=>(v<<16n)|BigInt(p),0n)
      if(packed(facts.version)<packed(minimum))throw new Error('SC1 registered package version below minimum')
      if(!verifyWindowsPackageImage(blockMap.bytes,signaturePath,path.win32.relative(root,imagePath),imageFile.bytes))throw new Error('SC1 image does not match signed package')
      identity.anchor.imageSha256=crypto.createHash('sha256').update(imageFile.bytes).digest('hex')
      identity.assertAlive()
      if(n.owner(handle)!==owner || nativePackageString((size,text)=>n.packageFullName(handle,size,text),256)!==full || nativePackageString((size,text)=>n.packagePath(full,size,text),32768)!==root)throw new Error('SC1 native package generation changed')
      // Admission is complete. The live process handle pins the exact generation, and
      // verified package ACLs exclude untrusted writes. Release file/ancestry leases in
      // finally so an idle DRAGON connection does not obstruct native package servicing.
      return identity
    }catch(error){if(identity)identity.close();else n.close(handle);throw error}
    finally{for(const file of temporary.reverse()){file.bytes.fill(0);file.close()}}
  }
  assertAlive():void {if(this.closed || native().wait(this.handle,0)!==258)throw new WindowsV3UnavailableError('SC1 native owner exited')}
  verifySocket(socket:net.Socket,port:number):void {verifyHeldWindowsSocket(this,socket,port)}
  close():void {if(!this.closed){this.closed=true;native().close(this.handle)}}
}

function verifyHeldWindowsSocket(identity:VerifiedWindowsIdentity,socket:net.Socket,port:number):void {
  identity.assertAlive()
  if(socket.destroyed || socket.remoteAddress!=='127.0.0.1' || socket.localAddress!=='127.0.0.1' || socket.remotePort!==port || !socket.localPort)throw new Error('SC1 socket endpoint mismatch')
  const n=native(),size=[0];let code=n.tcp(null,size,0,2,5,0)
  if(code!==122 || size[0]!<4 || size[0]!>4*1024*1024)throw new Error('SC1 TCP ownership unavailable')
  let table:Buffer|undefined
  for(let attempt=0;attempt<3;attempt++){
    const memory=Buffer.alloc(size[0]!);code=n.tcp(memory,size,0,2,5,0)
    if(code===0){table=memory.subarray(0,size[0]!);break}
    if(code!==122 || size[0]!>4*1024*1024 || size[0]!<4)break
  }
  if(!table)throw new Error('SC1 TCP ownership could not be verified')
  const owners=parseTcpOwners(table,port,socket.localPort)
  if(owners.length!==1 || owners[0]!==identity.anchor.pid){identity.assertAlive();throw new Error('SC1 connected endpoint belongs to another process')}
  identity.assertAlive()
}

/** A trusted anchor is supplied by a protected external contract, never learned from a listener. */
export class HeldProcessIdentity {
  private readonly handle: unknown
  private readonly imageFile: ReturnType<typeof holdProtectedWindowsFile> | undefined
  private closed=false
  constructor(readonly anchor: ProcessAnchor) {
    const n=native(); this.handle=n.openProcess(0x100000|0x1000,0,anchor.pid)
    if (!this.handle) throw new Error('SC1 authorized process is unavailable')
    try {
      this.assertAlive()
      const created=Buffer.alloc(8); n.checked(n.times(this.handle,created,Buffer.alloc(8),Buffer.alloc(8),Buffer.alloc(8)))
      const image=Buffer.alloc(65536), length=[32768]; n.checked(n.image(this.handle,0,image,length))
      if (created.readBigUInt64LE().toString()!==anchor.creationTime || n.owner(this.handle)!==anchor.ownerSid || image.toString('utf16le',0,length[0]!*2).toLowerCase()!==anchor.imagePath.toLowerCase()) throw new Error('SC1 authorized process identity mismatch')
      this.imageFile=holdProtectedWindowsFile(anchor.imagePath,256*1024*1024,false)
      if (crypto.createHash('sha256').update(this.imageFile.bytes).digest('hex')!==anchor.imageSha256) { this.imageFile.close(); throw new Error('SC1 executable hash mismatch') }
      this.imageFile.bytes.fill(0)
      this.assertAlive()
    } catch(error) { this.imageFile?.close(); n.close(this.handle); throw error }
  }
  assertAlive(): void { if (this.closed || native().wait(this.handle,0)!==258) throw new Error('SC1 authorized process has exited') }
  verifySocket(socket: net.Socket, port: number): void {
    verifyHeldWindowsSocket(this,socket,port)
  }
  close(): void { if (!this.closed) { this.closed=true; this.imageFile?.close(); native().close(this.handle) } }
}
