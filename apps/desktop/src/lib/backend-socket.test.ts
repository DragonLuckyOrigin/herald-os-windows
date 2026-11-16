import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendSocket, backendSocket } from './backend-socket.ts'
let listener:(event:any)=>void
const api={open:vi.fn(),send:vi.fn(),close:vi.fn(),ack:vi.fn(),onEvent:vi.fn()}
beforeEach(()=>{
  vi.resetAllMocks()
  Object.assign(globalThis,{window:{heraldOS:{backendTransport:api}},CloseEvent:class extends Event{code:number;wasClean:boolean;constructor(type:string,options:any={}){super(type);this.code=options.code;this.wasClean=options.wasClean}}})
  api.onEvent.mockImplementation(fn=>{listener=fn;return vi.fn()});api.open.mockResolvedValue(undefined);api.send.mockResolvedValue(undefined);api.close.mockResolvedValue(undefined);api.ack.mockResolvedValue(undefined)
})
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))
describe('main-owned WebSocket adapter',()=>{
  it('flushes an accepted stop frame before normal close',async()=>{
    const socket=new BackendSocket('ws://herald-main.invalid/speak-stream'),id=api.open.mock.calls[0]![0]
    listener({id,type:'open'});socket.send('{"stop":true}');socket.close()
    await tick()
    expect(api.send).toHaveBeenCalledWith(id,'{"stop":true}')
    expect(api.send.mock.invocationCallOrder[0]).toBeLessThan(api.close.mock.invocationCallOrder[0]!)
    expect(socket.readyState).toBe(2)
    listener({id,type:'close',data:{code:1000}});expect(socket.readyState).toBe(3)
  })
  it('copies binary data and acknowledges only its own received frame',async()=>{
    const socket=new BackendSocket('ws://herald-main.invalid/gateway'),id=api.open.mock.calls[0]![0],message=vi.fn();socket.onmessage=message
    listener({id:'other',type:'message',data:{sequence:1,payload:'foreign'}});expect(message).not.toHaveBeenCalled()
    listener({id,type:'open'});const bytes=new Uint8Array([1,2]);listener({id,type:'message',data:{sequence:1,payload:bytes}});bytes[0]=9
    expect(new Uint8Array(message.mock.calls[0]![0].data)).toEqual(new Uint8Array([1,2]));expect(api.ack).toHaveBeenCalledWith(id,1)
    const out=new Uint8Array([3,4]);socket.send(out);out[0]=9;await tick();expect(new Uint8Array(api.send.mock.calls[0]![1])).toEqual(new Uint8Array([3,4]))
  })
  it('fails closed without the bridge and never creates a browser socket for a main marker',async()=>{
    const browser=vi.fn();vi.stubGlobal('WebSocket',browser);delete (window.heraldOS as any).backendTransport
    const socket=backendSocket('ws://herald-main.invalid/gateway');await tick();expect(socket.readyState).toBe(3);expect(browser).not.toHaveBeenCalled();vi.unstubAllGlobals()
  })
  it('accepts existing eleven MiB file uploads after base64 expansion',async()=>{
    const socket=new BackendSocket('ws://herald-main.invalid/gateway'),id=api.open.mock.calls[0]![0];listener({id,type:'open'})
    const frame='A'.repeat(Math.ceil(11*1024*1024/3)*4);socket.send(frame);await tick();expect(api.send).toHaveBeenCalledWith(id,frame)
  })
  it('acknowledges but does not deliver frames arriving during graceful close',async()=>{
    const socket=new BackendSocket('ws://herald-main.invalid/gateway'),id=api.open.mock.calls[0]![0],message=vi.fn();socket.onmessage=message
    listener({id,type:'open'});socket.close()
    listener({id,type:'message',data:{sequence:8,payload:'late'}})
    expect(api.ack).toHaveBeenCalledWith(id,8);expect(message).not.toHaveBeenCalled()
    await tick();listener({id,type:'close',data:{code:1000}});expect(socket.readyState).toBe(3)
  })
})
