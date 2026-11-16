import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type WebSocket from 'ws'
import { BACKEND_SOCKET_FRAME_BYTES, IPC } from '../../shared/ipc.ts'
import type { BackendManager } from '../backend/manager.ts'
import { isShellPage } from '../paths.ts'
import { cancelAttachedSocket } from '../backend/attached-transport.ts'

type Entry = { owner: WebContents; epoch: number; socket?: WebSocket; cancelled: boolean; pending: Map<number,number>; sequence: number }
const MAX_BYTES=BACKEND_SOCKET_FRAME_BYTES
export function assertBackendSender(event: Pick<IpcMainInvokeEvent,'sender'|'senderFrame'>, known: (sender: WebContents)=>boolean): void {
  if (event.sender.isDestroyed() || !known(event.sender) || !event.senderFrame || event.senderFrame!==event.sender.mainFrame || !isShellPage(event.senderFrame.url)) throw new Error('SC1 unauthorized backend IPC sender')
}

/** Fixed socket kinds only. Each opaque ID belongs to one known shell document generation. */
export function registerBackendTransport(backend: BackendManager, known: (sender: WebContents)=>boolean): void {
  const entries=new Map<string,Entry>(), epochs=new Map<WebContents,number>()
  const cancel=(id: string,entry: Entry)=>{entry.cancelled=true;if(entry.socket)cancelAttachedSocket(entry.socket);entries.delete(id)}
  const epoch=(owner: WebContents): number=>{
    if (!epochs.has(owner)) {
      epochs.set(owner,0)
      const clear=()=>{epochs.set(owner,(epochs.get(owner)??0)+1);for(const [id,e] of entries)if(e.owner===owner)cancel(id,e)}
      owner.on('did-start-navigation',details=>{if(details.isMainFrame)clear()})
      owner.on('render-process-gone',clear)
      owner.once('destroyed',()=>{clear();epochs.delete(owner)})
    }
    return epochs.get(owner)!
  }
  const live=(id: string,e: Entry)=>!e.cancelled && entries.get(id)===e && !e.owner.isDestroyed() && known(e.owner) && epochs.get(e.owner)===e.epoch && isShellPage(e.owner.getURL())
  const send=(id: string,e: Entry,type: string,data?: unknown)=>{if(live(id,e))e.owner.send(IPC.backendSocketEvent,{id,type,data})}
  const get=(event: IpcMainInvokeEvent,id: unknown)=>{
    assertBackendSender(event,known)
    const e=typeof id==='string'?entries.get(id):undefined
    if (!e || e.owner!==event.sender || !live(id as string,e)) throw new Error('SC1 stale or foreign socket')
    return e
  }
  ipcMain.handle(IPC.backendSocketOpen,async(event,id: unknown,kind: unknown)=>{
    assertBackendSender(event,known)
    if (typeof id!=='string' || !/^[a-f0-9-]{36}$/.test(id) || entries.has(id) || (kind!=='gateway' && kind!=='speak-stream')) throw new Error('SC1 invalid socket request')
    if ([...entries.values()].filter(e=>e.owner===event.sender).length>=8) throw new Error('SC1 socket limit reached')
    const e: Entry={owner:event.sender,epoch:epoch(event.sender),cancelled:false,pending:new Map(),sequence:0};entries.set(id,e)
    try {
      const socket=await backend.openAttachedSocket(kind)
      // Install an error sink even if navigation cancelled the open while native connect awaited.
      socket.on('error',()=>{send(id,e,'error');cancel(id,e)})
      if (!live(id,e)) {cancelAttachedSocket(socket);return}
      e.socket=socket
      socket.on('open',()=>send(id,e,'open'))
      socket.on('message',(bytes,isBinary)=>{
        if(!live(id,e))return
        const buffer=Buffer.concat(Array.isArray(bytes)?bytes:[Buffer.from(bytes as ArrayBuffer)])
        const total=[...entries.values()].reduce((sum,entry)=>sum+[...entry.pending.values()].reduce((a,b)=>a+b,0),0)
        if(e.pending.size>=128 || total+buffer.length>MAX_BYTES*2){send(id,e,'error');cancel(id,e);return}
        const sequence=++e.sequence;e.pending.set(sequence,buffer.length)
        socket.pause()
        send(id,e,'message',{sequence,payload:isBinary?new Uint8Array(buffer):buffer.toString()})
      })
      socket.on('close',(code)=>{send(id,e,'close',{code});cancel(id,e)})
    } catch {send(id,e,'error');cancel(id,e);throw new Error('SC1 authenticated socket could not open')}
  })
  ipcMain.handle(IPC.backendSocketSend,(event,id: unknown,data: unknown)=>{
    const e=get(event,id)
    if (!e.socket || e.socket.readyState!==1 || !(typeof data==='string' || data instanceof ArrayBuffer) || (typeof data==='string'?Buffer.byteLength(data):data.byteLength)>MAX_BYTES || e.socket.bufferedAmount>MAX_BYTES) throw new Error('SC1 invalid socket frame or backpressure limit')
    return new Promise<void>((resolve,reject)=>e.socket!.send(data,error=>error?reject(new Error('SC1 frame send failed')):resolve()))
  })
  ipcMain.handle(IPC.backendSocketAck,(event,id: unknown,sequence: unknown)=>{
    const e=get(event,id)
    if(typeof sequence!=='number' || !e.pending.delete(sequence))throw new Error('SC1 invalid message acknowledgement')
    if(e.pending.size===0)e.socket?.resume()
  })
  ipcMain.handle(IPC.backendSocketClose,(event,id: unknown)=>{
    const e=get(event,id)
    if(e.socket?.readyState===1){
      e.socket.close(1000)
      const timer=setTimeout(()=>{if(live(id as string,e)){send(id as string,e,'close',{code:1006});cancel(id as string,e)}},5000)
      timer.unref();e.socket.once('close',()=>clearTimeout(timer))
    } else {send(id as string,e,'close',{code:1000});cancel(id as string,e)}
  })
  backend.onState(state=>{if(state.phase!=='ready')for(const[id,e]of entries){send(id,e,'close',{code:1001});cancel(id,e)}})
}
