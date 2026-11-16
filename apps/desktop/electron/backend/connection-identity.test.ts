import { describe, expect, it } from 'vitest'
import { WindowsV3UnavailableError, windowsFileTrust, holdProtectedWindowsFile, inspectRegisteredWindowsPackage, parseProcessAnchor, parseTcpOwners, verifyWindowsPackageSignature, verifyWindowsPackageImage, HeldWindowsV3Identity, fileTimeToHostCreateTime, hostStartFingerprint } from './connection-identity.ts'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import { publishWindowsV3Policy } from './connection-identity.ts'

describe.skipIf(process.platform !== 'win32')('exclusive native V3 publication in disposable fixtures', () => {
  const bytes=Buffer.from('{"synthetic":"no credentials"}\n','utf8')
  function fixture() { return fs.mkdtempSync(path.join(os.tmpdir(),'herald-enrollment-')) }
  it('publishes bytes accepted by the unchanged private reader; refuses adoption without changing bytes',()=>{
    const profile=fixture(),file=path.join(profile,'DRAGON_OS','connection-policy.json')
    try {
      publishWindowsV3Policy(profile,bytes,()=>{})
      const held=holdProtectedWindowsFile(file,16384,true,true)
      try { expect(held.bytes.equals(bytes)).toBe(true) } finally { held.close() }
      expect(()=>publishWindowsV3Policy(profile,Buffer.from('replacement'),()=>{})).toThrow()
      expect(fs.readFileSync(file).equals(bytes)).toBe(true)
    } finally { fs.rmSync(profile,{recursive:true,force:true}) }
  })
  it.each(['directory','file','junction'])('preserves an existing %s and never adopts it',kind=>{
    const profile=fixture(),destination=path.join(profile,'DRAGON_OS'),other=fixture()
    try {
      if(kind==='directory')fs.mkdirSync(destination)
      else if(kind==='file')fs.writeFileSync(destination,'unrelated')
      else fs.symlinkSync(other,destination,'junction')
      expect(()=>publishWindowsV3Policy(profile,bytes,()=>{})).toThrow()
      expect(fs.existsSync(destination)).toBe(true)
      expect(fs.readdirSync(other)).toEqual([])
      if(kind==='file')expect(fs.readFileSync(destination,'utf8')).toBe('unrelated')
    } finally { fs.rmSync(profile,{recursive:true,force:true});fs.rmSync(other,{recursive:true,force:true}) }
  })
  it('leaves no final policy after the held owner dies before publication; never cleans or retries',()=>{
    const profile=fixture();let calls=0
    try {
      expect(()=>publishWindowsV3Policy(profile,bytes,()=>{if(++calls===2)throw new Error('owner exited')})).toThrow('owner exited')
      expect(calls).toBe(2)
      expect(fs.existsSync(path.join(profile,'DRAGON_OS','connection-policy.json'))).toBe(false)
      expect(()=>publishWindowsV3Policy(profile,bytes,()=>{})).toThrow()
    } finally {fs.rmSync(profile,{recursive:true,force:true})}
  })
  it('rejects a reparse ancestor before writing through it',()=>{
    const profile=fixture(),other=fixture(),link=path.join(profile,'linked')
    try {
      fs.symlinkSync(other,link,'junction')
      expect(()=>publishWindowsV3Policy(link,bytes,()=>{})).toThrow()
      expect(fs.readdirSync(other)).toEqual([])
    } finally {fs.rmSync(profile,{recursive:true,force:true});fs.rmSync(other,{recursive:true,force:true})}
  })
  it('blocks directory replacement and rejects a newly added hardlink before publishing',()=>{
    const profile=fixture();let calls=0
    try {
      expect(()=>publishWindowsV3Policy(profile,Buffer.from('{"message":"Grüße"}\n','utf8'),()=>{
        if(++calls!==2)return
        const directory=path.join(profile,'DRAGON_OS'),temporary=path.join(directory,fs.readdirSync(directory)[0]!)
        expect(()=>fs.renameSync(directory,directory+'-moved')).toThrow()
        fs.linkSync(temporary,path.join(directory,'alias'))
        expect(fs.existsSync(path.join(directory,'connection-policy.json'))).toBe(false)
      })).toThrow('substituted')
      expect(calls).toBe(2)
      expect(fs.existsSync(path.join(profile,'DRAGON_OS','connection-policy.json'))).toBe(false)
    } finally {fs.rmSync(profile,{recursive:true,force:true})}
  })
})

const require=createRequire(import.meta.url)

describe('SC1 per-object OWNER RIGHTS principal policy',()=>{
  const current='S-1-5-21-1-2-3-1001',foreign='S-1-5-21-1-2-3-1002'
  it.each([[true,false],[true,true],[false,false],[false,true]])('rejects foreign owner before granting any ACE (directory=%s, secret=%s)',(directory,secret)=>{
    expect(()=>windowsFileTrust(foreign,current,directory,secret)).toThrow('untrusted file owner')
    expect(()=>windowsFileTrust('S-1-3-4',current,directory,secret)).toThrow('untrusted file owner')
  })
  it('binds inherited OWNER RIGHTS to each child owner, never a previously accepted parent',()=>{
    expect(windowsFileTrust(current,current,true,false)('S-1-3-4')).toBe(true)
    expect(()=>windowsFileTrust(foreign,current,false,false)).toThrow('untrusted file owner')
  })
  it('retains the private-token owner and grantee restriction, including group owners',()=>{
    const token=windowsFileTrust(current,current,false,true)
    expect(token('S-1-3-4')).toBe(true)
    expect(token('S-1-5-18')).toBe(true)
    for(const sid of ['S-1-5-32-544','S-1-1-0',foreign,'S-1-3-0','S-1-3-1'])expect(token(sid)).toBe(false)
    expect(()=>windowsFileTrust('S-1-5-32-544',current,false,true)).toThrow('untrusted file owner')
    expect(windowsFileTrust('S-1-5-32-544',current,true,false)('S-1-3-4')).toBe(true)
  })
  it('leaves package ownership and callback-principal policy unchanged',()=>{
    expect(()=>windowsFileTrust(current,current,false,false,true)).toThrow('untrusted file owner')
    const packageFile=windowsFileTrust('S-1-5-18',current,false,false,true)
    expect(packageFile('S-1-3-4')).toBe(false)
    expect(packageFile(current)).toBe(false)
    expect(packageFile('S-1-5-18')).toBe(true)
  })
})

it('matches the qualified native host timestamp conversion without reconstructing FILETIME',()=>{
  expect(fileTimeToHostCreateTime(134369745470117705n)).toBe(1792500947.0117705)
  expect(fileTimeToHostCreateTime(134369757310417542n)).toBe(1792502131.0417542)
  expect(fileTimeToHostCreateTime(134369941916095633n)).toBe(1792520591.609563)
  expect(hostStartFingerprint(1792520591.609563)).toBe(179252059161)
  expect(hostStartFingerprint(1.125)).toBe(112)
  expect(hostStartFingerprint(1.375)).toBe(138)
})

describe.skipIf(process.platform!=='win32' || !process.env.SC1_NATIVE_PACKAGE_FULL_NAME)('V3 native package primitives (not connection admission)',()=>{
  const policy={packageFamily:'NousResearch.HermesBundled_e60prshbsznhj',publisher:'CN=Nous Research Inc., O=Nous Research Inc., L=Austin, S=Texas, C=US',minimumPackageVersion:'2026.6864.2132.0'}
  const record={pid:Number(process.env.SC1_NATIVE_CORE_PID),createTime:Number(process.env.SC1_NATIVE_CREATE_TIME),startTime:Number(process.env.SC1_NATIVE_START_TIME)}
  it('accepts the held Stable generation and rejects an unknown socket before sending bytes',async()=>{
    const identity=await HeldWindowsV3Identity.acquire(record,policy)
    const server=net.createServer();let received=0;const peers:net.Socket[]=[]
    server.on('connection',peer=>{peers.push(peer);peer.on('data',bytes=>received+=bytes.length)})
    let socket:net.Socket|undefined
    try {
      expect(identity.anchor).toMatchObject({pid:record.pid,ownerSid:process.env.SC1_NATIVE_USER_SID,imagePath:process.env.SC1_NATIVE_IMAGE_PATH})
      expect(identity.anchor.imageSha256).toMatch(/^[a-f0-9]{64}$/)
      identity.assertAlive()
      await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
      const port=(server.address() as net.AddressInfo).port
      socket=net.createConnection({host:'127.0.0.1',localAddress:'127.0.0.1',port})
      await new Promise<void>((resolve,reject)=>{socket!.once('connect',resolve);socket!.once('error',reject)})
      expect(()=>identity.verifySocket(socket!,port)).toThrow('another process')
      expect(received).toBe(0)
    }finally{socket?.destroy();for(const peer of peers)peer.destroy();server.close();identity.close()}
    expect(()=>identity.assertAlive()).toThrow('exited')
  },40_000)
  it('rejects stale generation, wrong package policy and wrong publisher without authenticating',async()=>{
    await expect(HeldWindowsV3Identity.acquire({...record,createTime:record.createTime-1},policy)).rejects.toThrow('generation')
    await expect(HeldWindowsV3Identity.acquire(record,{...policy,packageFamily:'NousResearch.HermesCanary_e60prshbsznhj'})).rejects.toThrow('family')
    await expect(HeldWindowsV3Identity.acquire(record,{...policy,publisher:'CN=Untrusted'})).rejects.toThrow('publisher')
  },40_000)
  it('reads current-user package registration and performs actual WinRT content verification',async()=>{
    const facts=await inspectRegisteredWindowsPackage(process.env.SC1_NATIVE_PACKAGE_FULL_NAME!,process.env.SC1_NATIVE_USER_SID!)
    expect(facts).toMatchObject({name:'NousResearch.HermesBundled',fullName:process.env.SC1_NATIVE_PACKAGE_FULL_NAME,family:'NousResearch.HermesBundled_e60prshbsznhj',publisher:'CN=Nous Research Inc., O=Nous Research Inc., L=Austin, S=Texas, C=US',publisherId:'e60prshbsznhj',architecture:9,developmentMode:false,statusOk:true,contentIntegrity:true})
    expect(facts.version).toHaveLength(4)
    expect([1,2,3]).toContain(facts.signatureKind)
  },40_000)
  it('uses the native P7X trust provider and rejects altered signature bytes',()=>{
    const signature=fs.readFileSync(path.join(process.env.SC1_NATIVE_PACKAGE_ROOT!,'AppxSignature.p7x'))
    expect(verifyWindowsPackageSignature(signature)).toEqual({code:0,publisher:'CN=Nous Research Inc., O=Nous Research Inc., L=Austin, S=Texas, C=US'})
    const damaged=Buffer.from(signature);damaged[128]=damaged[128]!^1
    const invalid=verifyWindowsPackageSignature(damaged),truncated=verifyWindowsPackageSignature(signature.subarray(0,64))
    expect(invalid).toEqual({code:0x800b0100,publisher:null})
    expect(truncated).toEqual({code:0x8009200d,publisher:null})
  })
  it('binds the actual image bytes to the signed native block map and rejects modified input',()=>{
    const root=process.env.SC1_NATIVE_PACKAGE_ROOT!,imagePath=process.env.SC1_NATIVE_IMAGE_PATH!
    const map=fs.readFileSync(path.join(root,'AppxBlockMap.xml')),signature=path.join(root,'AppxSignature.p7x'),image=fs.readFileSync(imagePath),name=path.win32.relative(root,imagePath)
    expect(verifyWindowsPackageImage(map,signature,name,image)).toBe(true)
    const damagedImage=Buffer.from(image);damagedImage[0]=damagedImage[0]!^1
    expect(verifyWindowsPackageImage(map,signature,name,damagedImage)).toBe(false)
    const modifiedMap=Buffer.from(map.toString('utf8').replace(/Hash="([A-Za-z0-9+/])/,(_match,char)=>`Hash="${char==='A'?'B':'A'}`))
    expect(modifiedMap.equals(map)).toBe(false)
    expect(()=>verifyWindowsPackageImage(modifiedMap,signature,name,image)).toThrow()
  })
  it('rejects missing registration and cancelled verification',async()=>{
    await expect(inspectRegisteredWindowsPackage('NoSuchPackage_1.0.0.0_x64__e60prshbsznhj',process.env.SC1_NATIVE_USER_SID!)).rejects.toThrow()
    await expect(inspectRegisteredWindowsPackage(process.env.SC1_NATIVE_PACKAGE_FULL_NAME!,process.env.SC1_NATIVE_USER_SID!,AbortSignal.abort())).rejects.toThrow()
  })
  it('cancels an in-flight native content verification without masking the abort',async()=>{
    const controller=new AbortController()
    const pending=inspectRegisteredWindowsPackage(process.env.SC1_NATIVE_PACKAGE_FULL_NAME!,process.env.SC1_NATIVE_USER_SID!,controller.signal)
    controller.abort(new Error('test-native-verification-cancelled'))
    await expect(pending).rejects.toThrow('test-native-verification-cancelled')
  },40_000)
  it('retains only the process-generation handle after admission',async()=>{
    const ffi=require('koffi') as typeof import('koffi')
    const kernel=ffi.load('C:\\Windows\\System32\\kernel32.dll')
    const count=kernel.func('int __stdcall GetProcessHandleCount(void *process, _Out_ uint32_t *count)')
    const baseline=[0],before=[0],after=[0]
    expect(count(0xffffffffffffffffn,baseline)).toBe(1)
    const identity=await HeldWindowsV3Identity.acquire(record,policy)
    try {expect(count(0xffffffffffffffffn,before)).toBe(1);expect(before[0]!-baseline[0]!).toBe(1)}finally{identity.close()}
    expect(count(0xffffffffffffffffn,after)).toBe(1)
    expect(before[0]!-after[0]!).toBe(1)
    expect(after[0]).toBe(baseline[0])
  },40_000)
})

describe('SC1 trusted process contract', () => {
  const valid = { pid: 42, creationTime: '133801234567890123', ownerSid: 'S-1-5-21-1-2-3-1001', imagePath: 'C:\\private\\python.exe', imageSha256: 'a'.repeat(64) }
  it('retains lossless Windows creation identity', () => expect(parseProcessAnchor(valid)).toEqual(valid))
  it.each([{ ...valid, creationTime: Number(valid.creationTime) }, { ...valid, pid: 0 }, { ...valid, imagePath: '\\\\server\\python.exe' }, { ...valid, imageSha256: 'no' }])('rejects incomplete or ambiguous identity', value => expect(() => parseProcessAnchor(value)).toThrow())
  it('binds the accepted server side of the exact TCP four-tuple', () => {
    const b = Buffer.alloc(28); b.writeUInt32LE(1); b.writeUInt32LE(5,4); b.set([127,0,0,1],8); b.writeUInt16BE(1234,12); b.set([127,0,0,1],16); b.writeUInt16BE(5678,20); b.writeUInt32LE(42,24)
    expect(parseTcpOwners(b, 1234, 5678)).toEqual([42])
    expect(parseTcpOwners(b, 1234, 5679)).toEqual([])
    expect(() => parseTcpOwners(b.subarray(0,27),1234,5678)).toThrow()
  })
})

describe.skipIf(process.platform !== 'win32')('SC1 native protected reader', () => {
  function powershell(script:string,dir:string,file:string) {
    return execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';"+script],{env:{...process.env,SC1_TEST_DIR:dir,SC1_TEST_FILE:file},windowsHide:true,stdio:'pipe'})
  }
  function fixture() {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sc1-negative-')),file=path.join(dir,'synthetic')
    fs.writeFileSync(file,'synthetic-no-production')
    powershell(String.raw`
      $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
      foreach($item in @($env:SC1_TEST_DIR,$env:SC1_TEST_FILE)){
        $a=Get-Acl -LiteralPath $item;$a.SetAccessRuleProtection($true,$false);foreach($r in @($a.Access)){[void]$a.RemoveAccessRuleSpecific($r)};$a.SetOwner($sid)
        foreach($s in @($sid.Value,'S-1-5-18')){$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($s),'FullControl','Allow'))};Set-Acl -LiteralPath $item -AclObject $a
      }
    `,dir,file)
    return {dir,file,cleanup:()=>{for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir)}}
  }
  function ownerRights(f:ReturnType<typeof fixture>,extra='') {
    powershell(String.raw`
      $a=[IO.Directory]::GetAccessControl($env:SC1_TEST_DIR,[System.Security.AccessControl.AccessControlSections]::Access)
      $a.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'+`+JSON.stringify(extra)+String.raw`,[System.Security.AccessControl.AccessControlSections]::Access)
      [IO.Directory]::SetAccessControl($env:SC1_TEST_DIR,$a)
      $check=[IO.Directory]::GetAccessControl($env:SC1_TEST_DIR,[System.Security.AccessControl.AccessControlSections]::Access)
      if(-not $check.AreAccessRulesProtected -or @($check.Access | Where-Object IsInherited).Count){throw 'Fixture DACL protection mismatch'}
      $rules=$check.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier])
      if(-not @($rules | Where-Object {$_.IdentityReference.Value -eq 'S-1-3-4' -and $_.AccessControlType -eq 'Allow' -and $_.FileSystemRights -eq 'FullControl'}).Count){throw 'Fixture OWNER RIGHTS missing'}
    `,f.dir,f.file)
  }
  it('classifies missing native publication and sharing violations as unavailable',()=>{
    const f=fixture()
    const ffi=require('koffi') as typeof import('koffi'),kernel=ffi.load('C:\\Windows\\System32\\kernel32.dll')
    const open=kernel.func('void * __stdcall CreateFileW(const char16_t *name,uint32_t access,uint32_t share,void *security,uint32_t disposition,uint32_t flags,void *templateFile)')
    const close=kernel.func('int __stdcall CloseHandle(void *handle)')
    let locked:unknown
    try {
      for(let i=0;i<10;i++) {
        expect(()=>holdProtectedWindowsFile(path.join(f.dir,'missing'),16384,true,true)).toThrow(WindowsV3UnavailableError)
        expect(()=>holdProtectedWindowsFile(path.join(f.dir,'missing-dir','missing'),16384,true,true)).toThrow(WindowsV3UnavailableError)
      }
      locked=open(f.file,0x80000000,0,null,3,0,null)
      expect(locked).toBeTruthy();expect(locked).not.toBe(0xffffffffffffffffn)
      expect(()=>holdProtectedWindowsFile(f.file,16384,true,true)).toThrow(WindowsV3UnavailableError)
    }finally{if(locked && locked!==0xffffffffffffffffn)close(locked);f.cleanup()}
  })
  it('accepts the exact Hermes OWNER RIGHTS directory, inherited public record and private token',()=>{
    const f=fixture()
    try {
      ownerRights(f)
      const record=path.join(f.dir,'record');fs.writeFileSync(record,'synthetic-public-record')
      for(const [file,secret,expected] of [[record,false,'synthetic-public-record'],[f.file,true,'synthetic-no-production']] as const) {
        const held=holdProtectedWindowsFile(file,16384,secret,true)
        try {expect(held.bytes.toString()).toBe(expected)}finally{held.bytes.fill(0);held.close()}
      }
      expect(()=>holdProtectedWindowsFile(record,16384,true,true)).toThrow('protected')
    } finally {f.cleanup()}
  })
  it.each(['WriteData','AppendData','Delete','DeleteSubdirectoriesAndFiles','ChangePermissions','TakeOwnership'])('rejects OWNER RIGHTS alongside untrusted directory %s',right=>{
    const f=fixture()
    try {
      ownerRights(f)
      powershell(`$a=[IO.Directory]::GetAccessControl($env:SC1_TEST_DIR,[System.Security.AccessControl.AccessControlSections]::Access);$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'${right}','Allow'));[IO.Directory]::SetAccessControl($env:SC1_TEST_DIR,$a)`,f.dir,f.file)
      expect(()=>holdProtectedWindowsFile(f.file)).toThrow('untrusted')
    }finally{f.cleanup()}
  })
  it.each(['S-1-1-0','S-1-5-32-544'])('rejects a protected OWNER RIGHTS token also readable by %s',sid=>{
    const f=fixture()
    try {
      powershell(`$a=[IO.File]::GetAccessControl($env:SC1_TEST_FILE,[System.Security.AccessControl.AccessControlSections]::Access);$a.SetSecurityDescriptorSddlForm('D:P(A;;FA;;;OW)(A;;FA;;;SY)(A;;FR;;;${sid})',[System.Security.AccessControl.AccessControlSections]::Access);[IO.File]::SetAccessControl($env:SC1_TEST_FILE,$a)`,f.dir,f.file)
      expect(()=>holdProtectedWindowsFile(f.file)).toThrow('untrusted')
    }finally{f.cleanup()}
  })
  it('accepts a protected private OWNER RIGHTS token and releases publication handles',()=>{
    const f=fixture()
    try {
      powershell(String.raw`$a=[IO.File]::GetAccessControl($env:SC1_TEST_FILE,[System.Security.AccessControl.AccessControlSections]::Access);$a.SetSecurityDescriptorSddlForm('D:P(A;;FA;;;OW)(A;;FA;;;SY)',[System.Security.AccessControl.AccessControlSections]::Access);[IO.File]::SetAccessControl($env:SC1_TEST_FILE,$a)`,f.dir,f.file)
      const held=holdProtectedWindowsFile(f.file)
      try {expect(held.bytes.toString()).toBe('synthetic-no-production');expect(()=>fs.renameSync(f.file,f.file+'.new')).toThrow()}
      finally{held.bytes.fill(0);held.close()}
      fs.renameSync(f.file,f.file+'.new');fs.renameSync(f.file+'.new',f.file)
    }finally{f.cleanup()}
  })
  it('retains conservative deny and inherit-only handling with OWNER RIGHTS',()=>{
    const f=fixture()
    try {
      // Denying WRITE_DAC to the owner does not grant anything to an untrusted principal.
      ownerRights(f,'(D;;WD;;;OW)(A;OICIIO;FA;;;WD)')
      const held=holdProtectedWindowsFile(f.file)
      try {expect(held.bytes.toString()).toBe('synthetic-no-production')}finally{held.bytes.fill(0);held.close()}
    }finally{f.cleanup()}
  })
  it('rejects a readable-by-Everyone token without returning bytes',()=>{
    const f=fixture()
    try {powershell(String.raw`$a=[System.IO.File]::GetAccessControl($env:SC1_TEST_FILE,[System.Security.AccessControl.AccessControlSections]::Access);$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'));[System.IO.File]::SetAccessControl($env:SC1_TEST_FILE,$a)`,f.dir,f.file);expect(()=>holdProtectedWindowsFile(f.file)).toThrow('untrusted')}
    finally{f.cleanup()}
  })
  it('rejects an unprotected inherited token DACL',()=>{
    const f=fixture()
    try {powershell(String.raw`$a=[System.IO.File]::GetAccessControl($env:SC1_TEST_FILE,[System.Security.AccessControl.AccessControlSections]::Access);$a.SetAccessRuleProtection($false,$true);[System.IO.File]::SetAccessControl($env:SC1_TEST_FILE,$a)`,f.dir,f.file);expect(()=>holdProtectedWindowsFile(f.file)).toThrow('protected')}
    finally{f.cleanup()}
  })
  it('rejects an ancestor with untrusted delete-child permission',()=>{
    const f=fixture()
    try {powershell(String.raw`$a=[System.IO.Directory]::GetAccessControl($env:SC1_TEST_DIR,[System.Security.AccessControl.AccessControlSections]::Access);$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'DeleteSubdirectoriesAndFiles','Allow'));[System.IO.Directory]::SetAccessControl($env:SC1_TEST_DIR,$a)`,f.dir,f.file);expect(()=>holdProtectedWindowsFile(f.file)).toThrow('untrusted')}
    finally{f.cleanup()}
  })
  it('rejects hard links, alternate data streams and excessive file size',()=>{
    const f=fixture()
    try {
      fs.linkSync(f.file,path.join(f.dir,'hardlink'));expect(()=>holdProtectedWindowsFile(f.file)).toThrow('hard-linked')
      fs.unlinkSync(path.join(f.dir,'hardlink'));expect(()=>holdProtectedWindowsFile(f.file,2)).toThrow('size')
      expect(()=>holdProtectedWindowsFile(f.file+':secret')).toThrow('canonical')
    }finally{f.cleanup()}
  })
  it('rejects a junction ancestor instead of following it',()=>{
    const f=fixture(),alias=path.join(f.dir,'junction')
    try {fs.symlinkSync(f.dir,alias,'junction');expect(()=>holdProtectedWindowsFile(path.join(alias,'synthetic'))).toThrow('reparse')}
    finally{f.cleanup()}
  })
  it('reads only a private held file; denies file and directory replacement while held', () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sc1-reader-'))
    const file=path.join(dir,'synthetic-token')
    fs.writeFileSync(file,'fixture-only-token-never-productive')
    execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-Command', String.raw`
      $ErrorActionPreference='Stop'
      $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
      foreach($item in @($env:SC1_TEST_DIR,$env:SC1_TEST_FILE)) {
        $acl=Get-Acl -LiteralPath $item
        $acl.SetAccessRuleProtection($true,$false)
        foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($rule)}
        $acl.SetOwner($sid)
        foreach($identity in @($sid.Value,'S-1-5-18')) {
          $s=[System.Security.Principal.SecurityIdentifier]::new($identity)
          $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','Allow'))
        }
        Set-Acl -LiteralPath $item -AclObject $acl
      }
    `],{env:{...process.env,SC1_TEST_DIR:dir,SC1_TEST_FILE:file},windowsHide:true,stdio:'pipe'})
    const held=holdProtectedWindowsFile(file)
    try {
      expect(held.bytes.toString()).toBe('fixture-only-token-never-productive')
      expect(()=>fs.renameSync(file,file+'.moved')).toThrow()
      expect(()=>fs.renameSync(dir,dir+'.moved')).toThrow()
      expect(()=>fs.writeFileSync(file,'tamper')).toThrow()
    } finally {held.bytes.fill(0);held.close()}
    fs.unlinkSync(file); fs.rmdirSync(dir)
  })
})
