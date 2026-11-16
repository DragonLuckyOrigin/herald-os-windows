import { BACKEND_SOCKET_FRAME_BYTES } from '../../shared/ipc.ts'
const PREFIX = 'ws://herald-main.invalid/'
export const isMainTransportUrl = (url: string): boolean => url === PREFIX+'gateway' || url === PREFIX+'speak-stream'

/** DOM WebSocket interface backed by main-owned authenticated transport; never falls back to TCP. */
export class BackendSocket extends EventTarget implements WebSocket {
  readonly CONNECTING=0; readonly OPEN=1; readonly CLOSING=2; readonly CLOSED=3
  readonly extensions=''; readonly protocol=''
  readonly url: string
  binaryType: BinaryType='arraybuffer'
  bufferedAmount=0
  readyState: 0 | 1 | 2 | 3=0
  onopen: WebSocket['onopen']=null
  onmessage: WebSocket['onmessage']=null
  onerror: WebSocket['onerror']=null
  onclose: WebSocket['onclose']=null
  private readonly id=crypto.randomUUID()
  private unsubscribe: (()=>void) | undefined
  private queue: Promise<void>=Promise.resolve()
  constructor(url: string) {
    super();this.url=url
    if (!isMainTransportUrl(url)) throw new Error('Invalid main transport destination')
    const api=window.heraldOS.backendTransport
    if (!api) {queueMicrotask(()=>this.fail());return}
    this.unsubscribe=api.onEvent(event=>{
      if(event.id!==this.id || this.readyState===3)return
      if(event.type==='open' && this.readyState===0){this.readyState=1;const e=new Event('open');this.dispatchEvent(e);this.onopen?.call(this,e)}
      else if(event.type==='message' && (this.readyState===1 || this.readyState===2)){
        const frame=event.data as {sequence:number;payload:unknown}
        const payload=frame?.payload
        const bytes=payload instanceof Uint8Array?payload.slice():payload instanceof ArrayBuffer?new Uint8Array(payload):null
        if(!Number.isSafeInteger(frame?.sequence) || (typeof payload!=='string' && !bytes)){this.fail();return}
        if(this.readyState===2){void api.ack(this.id,frame.sequence).catch(()=>this.fail());return}
        const data=bytes?(this.binaryType==='blob'?new Blob([bytes.buffer]):bytes.buffer):payload
        try {const e=new MessageEvent('message',{data});this.dispatchEvent(e);this.onmessage?.call(this,e)}
        finally {void api.ack(this.id,frame.sequence).catch(()=>this.fail())}
      } else if(event.type==='close'){const d=event.data as {code?:number}|undefined;this.finish(d?.code??1006)}
      else if(event.type==='error')this.fail()
    })
    void api.open(this.id,url===PREFIX+'gateway'?'gateway':'speak-stream').catch(()=>this.fail())
  }
  private finish(code: number): void {
    if(this.readyState===3)return
    this.readyState=3;this.unsubscribe?.();this.unsubscribe=undefined
    const event=new CloseEvent('close',{code,wasClean:code===1000});this.dispatchEvent(event);this.onclose?.call(this,event)
  }
  private fail(): void {
    if(this.readyState===3)return
    const event=new Event('error');this.dispatchEvent(event);this.onerror?.call(this,event)
    void window.heraldOS.backendTransport?.close(this.id).catch(()=>undefined)
    this.finish(1006)
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if(this.readyState!==1)throw new DOMException('Socket is not open','InvalidStateError')
    const size=typeof data==='string'?new TextEncoder().encode(data).length:data instanceof Blob?data.size:data.byteLength
    if(size>BACKEND_SOCKET_FRAME_BYTES || this.bufferedAmount+size>BACKEND_SOCKET_FRAME_BYTES){this.fail();throw new Error('Socket queue limit exceeded')}
    // Snapshot mutable views at send time, as native WebSocket does.
    const snapshot=typeof data==='string' || data instanceof Blob?data:ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength).slice().buffer:new Uint8Array(data).slice().buffer
    this.bufferedAmount+=size
    this.queue=this.queue.then(async()=>{
      try {if(this.readyState!==3)await window.heraldOS.backendTransport.send(this.id,snapshot instanceof Blob?await snapshot.arrayBuffer():snapshot)}
      finally {this.bufferedAmount-=size}
    }).catch(()=>this.fail())
  }
  close(code=1000,reason=''): void {
    if(code!==1000 && (code<3000 || code>4999))throw new DOMException('Invalid close code','InvalidAccessError')
    if(new TextEncoder().encode(reason).length>123)throw new DOMException('Close reason is too long','SyntaxError')
    if(this.readyState>=2)return
    this.readyState=2
    void this.queue.then(()=>window.heraldOS.backendTransport?.close(this.id)).catch(()=>this.finish(1006))
    if(!window.heraldOS.backendTransport)this.finish(1006)
  }
}

export function backendSocket(url: string): WebSocket {
  return isMainTransportUrl(url)?new BackendSocket(url):new WebSocket(url)
}
