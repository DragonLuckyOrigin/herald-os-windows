import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { AttachedTransport, cancelAttachedSocket } from './attached-transport.ts'
import { HeldProcessIdentity, WindowsV3UnavailableError, type VerifiedWindowsIdentity, type ProcessAnchor } from './connection-identity.ts'
import http from 'node:http'
import net from 'node:net'
import { WebSocketServer } from 'ws'
import { BackendManager } from './manager.ts'

const require=createRequire(import.meta.url)
const TEST_TOKEN='synthetic-sc1-test-token-no-production'
const ps='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

describe('V3 transport with real sockets and an admitted identity double',()=>{
  let server:http.Server,wss:WebSocketServer,transport:AttachedTransport,identity:VerifiedWindowsIdentity
  let failed:ReturnType<typeof vi.fn<(error:Error)=>void>>,received:number,requests:string[],wsCode:number|undefined,rejectWs:number|undefined,hangUpgrade:boolean
  const peers=new Set<net.Socket>()
  beforeEach(async()=>{
    received=0;requests=[];wsCode=undefined;rejectWs=undefined;hangUpgrade=false;failed=vi.fn()
    server=http.createServer((req,res)=>{
      requests.push(req.method+' '+req.url)
      if(req.url==='/api/drop'){req.socket.destroy();return}
      if(req.url==='/api/hang')return
      const code=req.url==='/api/401'?401:req.url==='/api/403'?403:req.url==='/api/500'?500:200
      res.writeHead(code,{'Content-Type':'application/json'})
      res.end(req.url==='/api/overflow'?'x'.repeat(8*1024*1024+1):JSON.stringify({authenticated:req.headers['x-hermes-session-token']===TEST_TOKEN}))
    })
    server.on('connection',peer=>{peers.add(peer);peer.on('close',()=>peers.delete(peer));peer.on('data',bytes=>received+=bytes.length)})
    wss=new WebSocketServer({noServer:true})
    server.on('upgrade',(req,socket,head)=>{
      if(hangUpgrade)return
      if(rejectWs){socket.end(`HTTP/1.1 ${rejectWs} Rejected\r\nContent-Length: 0\r\n\r\n`);return}
      wss.handleUpgrade(req,socket,head,ws=>{ws.on('error',()=>undefined);ws.on('message',data=>ws.send(data));if(wsCode!==undefined)ws.close(wsCode);else ws.send('synthetic-connected')})
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    identity={anchor:{pid:42,creationTime:'133801234567890123',ownerSid:'S-1-5-21-1-2-3-1001',imagePath:'C:\\fixture\\python.exe',imageSha256:'a'.repeat(64)},assertAlive:vi.fn(),verifySocket:vi.fn(),close:vi.fn()}
    transport=new AttachedTransport({baseUrl:`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,token:TEST_TOKEN,process:identity.anchor},failed,identity)
  })
  afterEach(async()=>{
    transport.close();for(const peer of peers)peer.destroy();peers.clear()
    await new Promise<void>(resolve=>wss.close(()=>resolve()))
    await new Promise<void>(resolve=>server.close(()=>resolve()))
    vi.restoreAllMocks()
  })
  it('checks both socket admission points before sending the synthetic token',async()=>{
    expect(await transport.rest({method:'GET',path:'/api/status'})).toEqual({authenticated:true})
    expect(identity.verifySocket).toHaveBeenCalledTimes(2);expect(received).toBeGreaterThan(0)
    const ws=await transport.webSocket('gateway');expect((await once(ws,'message'))[0].toString()).toBe('synthetic-connected')
    expect(identity.verifySocket).toHaveBeenCalledTimes(4)
    ws.close(1000);await once(ws,'close');expect(failed).not.toHaveBeenCalled()
  })
  it('rejects a failed socket owner before any request or token byte',async()=>{
    vi.mocked(identity.verifySocket).mockImplementation(()=>{throw new Error('wrong socket owner')})
    await expect(transport.rest({method:'POST',path:'/api/chat',body:{text:'synthetic'}})).rejects.toThrow('wrong socket owner')
    expect(requests).toHaveLength(0);expect(received).toBe(0);expect(failed).toHaveBeenCalledOnce()
  })
  it.each([401,403])('makes HTTP %s terminal without retries',async code=>{
    await expect(transport.rest({method:'GET',path:`/api/${code}`})).rejects.toThrow(String(code))
    expect(failed).toHaveBeenCalledOnce();expect(failed.mock.calls[0]![0]).not.toBeInstanceOf(WindowsV3UnavailableError)
    await expect(transport.rest({method:'GET',path:'/api/status'})).rejects.toThrow('closed')
    expect(requests).toHaveLength(1)
  })
  it.each(['500','overflow'])('keeps a request-specific %s failure isolated',async endpoint=>{
    await expect(transport.rest({method:'GET',path:`/api/${endpoint}`})).rejects.toThrow(endpoint==='500'?'500':'exceeds limit')
    expect(failed).not.toHaveBeenCalled()
    expect(await transport.rest({method:'GET',path:'/api/status'})).toEqual({authenticated:true})
  })
  it('reports an uncertain POST timeout without replaying it',async()=>{
    await expect(transport.rest({method:'POST',path:'/api/hang',body:{text:'synthetic'}},100)).rejects.toBeInstanceOf(WindowsV3UnavailableError)
    expect(requests).toEqual(['POST /api/hang']);expect(failed).toHaveBeenCalledOnce()
    await expect(transport.rest({method:'GET',path:'/api/status'})).rejects.toThrow('closed')
  })
  it('classifies real connection reset as unavailable without replay',async()=>{
    await expect(transport.rest({method:'POST',path:'/api/drop'})).rejects.toBeInstanceOf(WindowsV3UnavailableError)
    expect(requests).toEqual(['POST /api/drop']);expect(failed).toHaveBeenCalledOnce()
  })
  it.each([4401,4403,1008,1001,1000])('classifies WebSocket close %s truthfully',async code=>{
    wsCode=code
    const ws=await transport.webSocket('gateway');await once(ws,'close')
    if(code===1000 || code===1001)expect(failed).not.toHaveBeenCalled()
    else {expect(failed).toHaveBeenCalledOnce();expect(failed.mock.calls[0]![0]).not.toBeInstanceOf(WindowsV3UnavailableError)}
  })
  it('makes an HTTP WebSocket authentication rejection terminal',async()=>{
    rejectWs=401
    const ws=await transport.webSocket('gateway')
    await new Promise<void>(resolve=>ws.once('close',()=>resolve()))
    expect(failed).toHaveBeenCalledOnce();expect(failed.mock.calls[0]![0]).not.toBeInstanceOf(WindowsV3UnavailableError)
  })
  it.each([404,429,503])('keeps WebSocket HTTP %s local while the Core remains alive',async code=>{
    rejectWs=code
    const ws=await transport.webSocket('speak-stream')
    await new Promise<void>(resolve=>ws.once('close',()=>resolve()))
    expect(failed).not.toHaveBeenCalled();expect(await transport.rest({method:'GET',path:'/api/status'})).toEqual({authenticated:true})
  })
  it('keeps a real handshake timeout local while the Core remains alive',async()=>{
    hangUpgrade=true
    const ws=await transport.webSocket('speak-stream')
    const error=await new Promise<Error>(resolve=>ws.once('error',resolve))
    expect(error.message).toContain('timed out')
    expect(failed).not.toHaveBeenCalled();expect(await transport.rest({method:'GET',path:'/api/status'})).toEqual({authenticated:true})
  },10_000)
  it.each([1005,1006,1011])('keeps audio close %s isolated from the authenticated gateway',async code=>{
    const gateway=await transport.webSocket('gateway');await once(gateway,'message')
    const audio=await transport.webSocket('speak-stream');await once(audio,'message')
    // Select the most recently accepted server socket, corresponding to the awaited audio open.
    const audioPeer=[...wss.clients].at(-1)!
    const closed=new Promise<void>(resolve=>audio.once('close',()=>resolve()))
    if(code===1006)audioPeer.terminate();else if(code===1005)audioPeer.close();else audioPeer.close(code)
    await closed
    expect(failed).not.toHaveBeenCalled()
    const echo=once(gateway,'message');gateway.send('gateway-still-alive');expect((await echo)[0].toString()).toBe('gateway-still-alive')
    gateway.close(1000);await once(gateway,'close')
  })
  it('does not turn a local handshake cancellation into generation loss',async()=>{
    const ws=await transport.webSocket('speak-stream'),closed=new Promise<void>(resolve=>ws.once('close',()=>resolve()))
    cancelAttachedSocket(ws);await closed
    expect(failed).not.toHaveBeenCalled();expect(await transport.rest({method:'GET',path:'/api/status'})).toEqual({authenticated:true})
  })
  it('settles a cancelled pending connect immediately and closes the identity once',async()=>{
    vi.spyOn(net,'createConnection').mockReturnValue(new net.Socket())
    const pending=transport.rest({method:'GET',path:'/api/status'})
    transport.close();transport.close()
    await expect(pending).rejects.toThrow()
    expect(identity.close).toHaveBeenCalledOnce();expect(failed).not.toHaveBeenCalled()
  })
})

const serverCode=String.raw`
const http=require('http'),{WebSocketServer}=require(process.env.SC1_WS);
const server=http.createServer((req,res)=>{const authenticated=req.headers['x-hermes-session-token']===process.env.SC1_TOKEN;res.writeHead(!authenticated?401:req.url==='/api/redirect'?302:200,req.url==='/api/redirect'?{Location:'http://127.0.0.1:1/leak'}:{'Content-Type':'application/json'});res.end(JSON.stringify({authenticated}));});
let bytes=0,secretBytes=0;const connections=new Set();
server.on('connection',s=>{connections.add(s);s.on('close',()=>connections.delete(s));s.on('data',b=>{bytes+=b.length;if(b.includes(process.env.SC1_TOKEN))secretBytes+=Buffer.byteLength(process.env.SC1_TOKEN)})});
const wss=new WebSocketServer({server});wss.on('connection',(ws,req)=>{ws.send(JSON.stringify({authenticated:new URL(req.url,'http://localhost').searchParams.get('token')===process.env.SC1_TOKEN}));ws.on('message',(b,binary)=>ws.send(b,{binary}))});
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
server.listen(Number(process.env.SC1_PORT)||0,'127.0.0.1',()=>send({ready:server.address().port}));
require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.command==='stats')send({id:m.id,bytes,secretBytes});if(m.command==='release'){for(const s of connections)s.destroy();wss.close();server.close(()=>send({id:m.id,released:true}))}});
setInterval(()=>{},1000);
`
describe.skipIf(process.platform!=='win32')('SC1 native identity and real transport',()=>{
  let dir:string,exe:string,hash:string
  const children: ChildProcessWithoutNullStreams[]=[]
  const transports: AttachedTransport[]=[]
  beforeAll(()=>{
    dir=fs.mkdtempSync(path.join(os.tmpdir(),'sc1-transport-'));exe=path.join(dir,'fixture-node.exe');fs.copyFileSync(process.execPath,exe)
    execFileSync(ps,['-NoProfile','-NonInteractive','-Command',String.raw`
      $ErrorActionPreference='Stop';$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
      foreach($file in @($env:SC1_DIR,$env:SC1_EXE)){
        $a=Get-Acl -LiteralPath $file;$a.SetAccessRuleProtection($true,$false);foreach($r in @($a.Access)){[void]$a.RemoveAccessRuleSpecific($r)};$a.SetOwner($sid)
        foreach($s in @($sid.Value,'S-1-5-18')){$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($s),'FullControl','Allow'))};Set-Acl -LiteralPath $file -AclObject $a
      }
    `],{env:{...process.env,SC1_DIR:dir,SC1_EXE:exe},windowsHide:true,stdio:'pipe'})
    hash=crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex')
  },20000)
  afterAll(async()=>{
    transports.forEach(t=>t.close())
    for(const child of children){if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill();await exited}}
    if(exe && fs.existsSync(exe))fs.unlinkSync(exe)
    if(dir && fs.existsSync(dir))fs.rmdirSync(dir)
  })
  async function server(port=0){
    const child=spawn(exe,['-e',serverCode],{windowsHide:true,env:{...process.env,SC1_WS:require.resolve('ws'),SC1_TOKEN:TEST_TOKEN,SC1_PORT:String(port)},stdio:'pipe'});children.push(child)
    let buffer='',next=0;const replies=new Map<number,(v:any)=>void>()
    let ready!: (port:number)=>void
    const started=new Promise<number>((resolve,reject)=>{ready=resolve;child.once('error',reject);child.once('exit',()=>reject(new Error('fixture exited before ready')))})
    child.stdout.setEncoding('utf8');child.stdout.on('data',(s:string)=>{buffer+=s;let end;while((end=buffer.indexOf('\n'))>=0){const v=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(v.ready)ready(v.ready);else{replies.get(v.id)?.(v);replies.delete(v.id)}}})
    const bound=await started
    const identity=JSON.parse(execFileSync(ps,['-NoProfile','-NonInteractive','-Command',String.raw`$ErrorActionPreference='Stop';$p=Get-Process -Id ([int]$env:SC1_PID);@{creationTime=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();ownerSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value}|ConvertTo-Json -Compress`],{env:{...process.env,SC1_PID:String(child.pid)},windowsHide:true,encoding:'utf8'}))
    const anchor: ProcessAnchor={pid:child.pid!,imagePath:exe,imageSha256:hash,...identity}
    return {child,port:bound,anchor,command:(command:string)=>new Promise<any>(resolve=>{const id=++next;replies.set(id,resolve);child.stdin.write(JSON.stringify({id,command})+'\n')})}
  }
  function transport(anchor:ProcessAnchor,port:number,failed=vi.fn()) {const t=new AttachedTransport({process:anchor,baseUrl:`http://127.0.0.1:${port}`,token:TEST_TOKEN},failed);transports.push(t);return t}
  it('authenticates HTTP and gateway/audio WebSockets only to the authorized process',async()=>{
    const s=await server(),t=transport(s.anchor,s.port)
    expect(await t.rest({method:'GET',path:'/api/status'})).toEqual({authenticated:true})
    for(const kind of ['gateway','speak-stream'] as const){const ws=await t.webSocket(kind);const [data]=await once(ws,'message');expect(JSON.parse(data.toString())).toEqual({authenticated:true});const echo=once(ws,'message');ws.send(Buffer.from([1,2,3]));expect(Buffer.from((await echo)[0])).toEqual(Buffer.from([1,2,3]));const closed=once(ws,'close');ws.close();await closed}
    expect((await s.command('stats')).secretBytes).toBeGreaterThan(0)
  },20000)
  it('rejects wrong PID endpoints before any synthetic secret byte and becomes terminal',async()=>{
    const trusted=await server(),attacker=await server(),failed=vi.fn(),t=transport(trusted.anchor,attacker.port,failed)
    await expect(t.rest({method:'GET',path:'/api/status'})).rejects.toThrow()
    await expect(t.webSocket('gateway')).rejects.toThrow()
    expect(failed).toHaveBeenCalledTimes(1)
    expect(failed.mock.calls[0]![0].message).toBe('SC1: Die Verbindung zum autorisierten Core wurde verloren. Manuelle Prüfung erforderlich.')
    expect((await attacker.command('stats')).secretBytes).toBe(0)
    expect((await attacker.command('stats')).bytes).toBe(0)
  },20000)
  it('preserves V2 connection failure text and the original request error',async()=>{
    const s=await server(),failed=vi.fn(),t=transport(s.anchor,s.port,failed)
    await s.command('release')
    await expect(t.rest({method:'GET',path:'/api/status'})).rejects.toMatchObject({code:'ECONNREFUSED'})
    expect(failed.mock.calls[0]![0].message).toBe('SC1: Die Verbindung zum autorisierten Core wurde verloren. Manuelle Prüfung erforderlich.')
  },20000)
  it('preserves V2 factory verification failure text and the original error',async()=>{
    const s=await server(),failed=vi.fn(),t=transport(s.anchor,s.port,failed),original=new Error('synthetic-second-owner-check')
    const verify=vi.spyOn(HeldProcessIdentity.prototype,'verifySocket').mockImplementationOnce(()=>undefined).mockImplementation(()=>{throw original})
    try {
      await expect(t.rest({method:'GET',path:'/api/status'})).rejects.toBe(original)
      expect(failed.mock.calls[0]![0].message).toBe('SC1: Die Prozessidentität der Verbindung ist nicht mehr gültig.')
      expect((await s.command('stats')).secretBytes).toBe(0)
    }finally{verify.mockRestore();t.close()}
  },20000)
  it('preserves the V2 WebSocket error message',async()=>{
    const s=await server(),failed=vi.fn(),t=transport(s.anchor,s.port,failed)
    const ws=await t.webSocket('gateway');await once(ws,'message')
    ws.emit('error',new Error('synthetic-websocket-error'))
    expect(failed.mock.calls[0]![0].message).toBe('SC1: Der authentifizierte Socket ist fehlgeschlagen. Manuelle Prüfung erforderlich.')
  },20000)
  it('rejects port reuse while the authorized process remains alive, without sending token bytes',async()=>{
    const trusted=await server(),failed=vi.fn(),t=transport(trusted.anchor,trusted.port,failed)
    expect(await t.rest({method:'GET',path:'/api/status'})).toEqual({authenticated:true})
    await trusted.command('release');const replacement=await server(trusted.port)
    await expect(t.webSocket('speak-stream')).rejects.toThrow()
    expect(failed).toHaveBeenCalledTimes(1);expect((await replacement.command('stats')).bytes).toBe(0)
  },20000)
  it('rejects stale creation time, wrong owner, wrong executable path and hash',async()=>{
    const s=await server()
    for(const patch of [{creationTime:(BigInt(s.anchor.creationTime)+1n).toString()},{ownerSid:'S-1-5-18'},{imageSha256:'0'.repeat(64)}])expect(()=>new HeldProcessIdentity({...s.anchor,...patch})).toThrow()
    expect(()=>new HeldProcessIdentity({...s.anchor,imagePath:path.join(dir,'wrong-image.exe')})).toThrow('authorized process identity mismatch')
    expect((await s.command('stats')).bytes).toBe(0)
  },20000)
  it('detects process exit and never redials after loss',async()=>{
    const s=await server(),failed=vi.fn(),t=transport(s.anchor,s.port,failed)
    const exited=once(s.child,'exit');s.child.kill();await exited
    await vi.waitFor(()=>expect(failed).toHaveBeenCalledTimes(1),{timeout:2000})
    await expect(t.rest({method:'GET',path:'/api/status'})).rejects.toThrow('closed')
  },20000)
  it('does not follow credential-bearing HTTP redirects',async()=>{
    const s=await server(),t=transport(s.anchor,s.port)
    await expect(t.rest({method:'GET',path:'/api/redirect'})).rejects.toThrow('302')
  },20000)
  it('does not fail the backend when a document cancels a real ws handshake',async()=>{
    const s=await server(),failed=vi.fn(),t=transport(s.anchor,s.port,failed)
    const ws=await t.webSocket('speak-stream')
    expect(ws.readyState).toBe(0)
    const closed=new Promise<void>(resolve=>ws.once('close',()=>resolve()))
    cancelAttachedSocket(ws);await closed
    expect(failed).not.toHaveBeenCalled()
    expect(await t.rest({method:'GET',path:'/api/status'})).toEqual({authenticated:true})
  },20000)
  it.each(['valid', 'invalid', 'loss'] as const)('runs a protected V2 file through BackendManager: %s',async(mode)=>{
    const validToken=mode!=='invalid'
    const s=await server(),manager=new BackendManager(),tokenFile=path.join(dir,'test-token'),configFile=path.join(dir,'attach-v2.json')
    fs.writeFileSync(tokenFile,validToken?TEST_TOKEN:'synthetic-wrong-token-no-production')
    fs.writeFileSync(configFile,JSON.stringify({version:2,baseUrl:`http://127.0.0.1:${s.port}`,tokenFile,process:s.anchor}))
    execFileSync(ps,['-NoProfile','-NonInteractive','-Command',String.raw`
      $ErrorActionPreference='Stop';$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
      foreach($file in @($env:SC1_TOKEN_FILE,$env:SC1_CONFIG_FILE)){
        $a=[System.Security.AccessControl.FileSecurity]::new();$a.SetAccessRuleProtection($true,$false);$a.SetOwner($sid)
        foreach($s in @($sid.Value,'S-1-5-18')){$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($s),'FullControl','Allow'))}
        [System.IO.File]::SetAccessControl($file,$a)
      }
    `],{env:{...process.env,SC1_TOKEN_FILE:tokenFile,SC1_CONFIG_FILE:configFile},windowsHide:true,stdio:'pipe'})
    vi.stubEnv('HERALD_OS_ATTACH_CONFIG',configFile)
    try {
      await manager.start()
      expect(manager.childPid()).toBeNull()
      expect(manager.getState().phase).toBe(validToken?'ready':'failed')
      expect(manager.getState().baseUrl).toBeUndefined();expect(manager.getState().port).toBeUndefined()
      expect(JSON.stringify(manager.getState())).not.toContain(TEST_TOKEN)
      if(validToken){
        expect(manager.getState().wsUrl).toBe('ws://herald-main.invalid/gateway')
        expect(manager.audioWsUrl('speak-stream')).toBe('ws://herald-main.invalid/speak-stream')
        expect(await manager.rest({method:'GET',path:'/api/status'})).toEqual({authenticated:true})
      }else{
        expect(manager.getState().wsUrl).toBeUndefined()
        expect(()=>manager.openAttachedSocket('gateway')).toThrow()
      }
      if(mode==='loss'){
        const exited=once(s.child,'exit');s.child.kill();await exited
        await vi.waitFor(()=>expect(manager.getState().phase).toBe('failed'),{timeout:2000})
        expect(manager.getState().wsUrl).toBeUndefined();expect(manager.getState().baseUrl).toBeUndefined();expect(manager.getState().port).toBeUndefined()
        expect(manager.childPid()).toBeNull()
        await expect(manager.rest({method:'GET',path:'/api/status'})).rejects.toThrow()
        expect(()=>manager.openAttachedSocket('gateway')).toThrow()
        expect(()=>manager.audioWsUrl('speak-stream')).toThrow()
      }else{
        await manager.stop()
        expect(s.child.exitCode).toBeNull();expect(s.child.signalCode).toBeNull()
        expect(await s.command('stats')).toHaveProperty('bytes')
      }
    } finally {await manager.stop();vi.unstubAllEnvs();fs.unlinkSync(configFile);fs.unlinkSync(tokenFile)}
  },20000)
})
