import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const state=vi.hoisted(()=>({handlers:new Map<string,(...args:any[])=>any>()}))
vi.mock('electron',()=>({ipcMain:{handle:(name:string,fn:any)=>state.handlers.set(name,fn)}}))
vi.mock('../paths.ts',()=>({isShellPage:(url:string)=>url==='file:///shell.html'}))
import { IPC } from '../../shared/ipc.ts'
import { assertBackendSender, registerBackendTransport } from './backend-transport.ts'

const id='11111111-1111-4111-8111-111111111111'
const other='22222222-2222-4222-8222-222222222222'
function owner(){return Object.assign(new EventEmitter(),{mainFrame:{url:'file:///shell.html'},isDestroyed:()=>false,getURL:()=> 'file:///shell.html',send:vi.fn()})}
function socket(){return Object.assign(new EventEmitter(),{readyState:1,bufferedAmount:0,pause:vi.fn(),resume:vi.fn(),terminate:vi.fn(),close:vi.fn(),send:vi.fn((_data:any,callback:any)=>callback())})}
const event=(sender:ReturnType<typeof owner>)=>({sender,senderFrame:sender.mainFrame})
const invoke=(channel:string,...args:any[])=>state.handlers.get(channel)!(...args)
beforeEach(()=>state.handlers.clear())
describe('SC1 IPC ownership and bounded flow',()=>{
  it('keeps main-document sockets when only a subframe navigates',async()=>{
    const shell=owner(),ws=socket(),backend={openAttachedSocket:vi.fn().mockResolvedValue(ws),onState:vi.fn()}
    registerBackendTransport(backend as any,(w:any)=>w===shell)
    await invoke(IPC.backendSocketOpen,event(shell),id,'gateway')
    shell.emit('did-start-navigation',{url:'file:///shell.html',isMainFrame:false,isSameDocument:false})
    await invoke(IPC.backendSocketSend,event(shell),id,'still-current')
    expect(ws.send).toHaveBeenCalledWith('still-current',expect.any(Function))
    expect(ws.terminate).not.toHaveBeenCalled()
    shell.emit('did-start-navigation',{url:'file:///shell.html#same-document',isMainFrame:true,isSameDocument:true})
    expect(ws.terminate).toHaveBeenCalledTimes(1)
    expect(()=>invoke(IPC.backendSocketSend,event(shell),id,'stale')).toThrow('stale')
  })

  it('rejects foreign WebContents, subframes and navigated pages even with a familiar URL',()=>{
    const shell=owner(),foreign=owner(),known=(w:any)=>w===shell
    expect(()=>assertBackendSender(event(foreign) as any,known)).toThrow('unauthorized')
    expect(()=>assertBackendSender({...event(shell),senderFrame:{url:'file:///shell.html'}} as any,known)).toThrow('unauthorized')
    shell.mainFrame.url='https://example.invalid'
    expect(()=>assertBackendSender(event(shell) as any,known)).toThrow('unauthorized')
  })
  it('binds opaque IDs and closes pending connections from old document generations',async()=>{
    const shell=owner(),ws=socket();let resolve!:(value:any)=>void
    const backend={openAttachedSocket:vi.fn(()=>new Promise(r=>{resolve=r})),onState:vi.fn()}
    registerBackendTransport(backend as any,(w:any)=>w===shell)
    const opening=invoke(IPC.backendSocketOpen,event(shell),id,'gateway')
    shell.emit('did-start-navigation',{url:'file:///shell.html',isMainFrame:true,isSameDocument:false})
    resolve(ws);await opening
    expect(ws.terminate).toHaveBeenCalledTimes(1)
    expect(()=>invoke(IPC.backendSocketSend,event(shell),id,'secret-free')).toThrow('stale')
    expect(shell.send).not.toHaveBeenCalled()
  })
  it('pauses inbound traffic until same-document acknowledgement and caps pending frames',async()=>{
    const shell=owner(),ws=socket(),backend={openAttachedSocket:vi.fn().mockResolvedValue(ws),onState:vi.fn()}
    registerBackendTransport(backend as any,(w:any)=>w===shell)
    await invoke(IPC.backendSocketOpen,event(shell),id,'gateway')
    ws.emit('message',Buffer.from('frame'),false)
    expect(ws.pause).toHaveBeenCalledTimes(1)
    expect(()=>invoke(IPC.backendSocketAck,event(shell),other,1)).toThrow()
    invoke(IPC.backendSocketAck,event(shell),id,1);expect(ws.resume).toHaveBeenCalledTimes(1)
    for(let i=0;i<129;i++)ws.emit('message',Buffer.from('x'),false)
    expect(ws.terminate).toHaveBeenCalled()
  })
  it('waits for actual send completion and uses graceful close for normal shutdown',async()=>{
    const shell=owner(),ws=socket(),backend={openAttachedSocket:vi.fn().mockResolvedValue(ws),onState:vi.fn()}
    registerBackendTransport(backend as any,(w:any)=>w===shell);await invoke(IPC.backendSocketOpen,event(shell),id,'speak-stream')
    let complete!:()=>void;ws.send.mockImplementation((_data,callback)=>{complete=callback})
    let sent=false;const pending=invoke(IPC.backendSocketSend,event(shell),id,'{"stop":true}').then(()=>{sent=true})
    await Promise.resolve();expect(sent).toBe(false);complete();await pending
    invoke(IPC.backendSocketClose,event(shell),id);expect(ws.close).toHaveBeenCalledWith(1000);expect(ws.terminate).not.toHaveBeenCalled()
    ws.emit('close',1000);expect(ws.terminate).toHaveBeenCalled()
  })
  it('invalidates every connection on terminal backend failure',async()=>{
    const shell=owner(),ws=socket();let changed!:(state:any)=>void
    registerBackendTransport({openAttachedSocket:vi.fn().mockResolvedValue(ws),onState:(fn:any)=>{changed=fn}} as any,(w:any)=>w===shell)
    await invoke(IPC.backendSocketOpen,event(shell),id,'gateway');changed({phase:'failed'})
    expect(ws.terminate).toHaveBeenCalled();expect(()=>invoke(IPC.backendSocketSend,event(shell),id,'x')).toThrow('stale')
  })
})
