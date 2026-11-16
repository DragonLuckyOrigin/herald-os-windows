import http from 'node:http'
import net from 'node:net'
import WebSocket from 'ws'
import { BACKEND_SOCKET_FRAME_BYTES, type RestRequest } from '../../shared/ipc.ts'
import type { WindowsAttachTarget } from './coexist.ts'
import { HeldProcessIdentity, WindowsV3UnavailableError, type VerifiedWindowsIdentity } from './connection-identity.ts'

export const ATTACHED_GATEWAY_URL = 'ws://herald-main.invalid/gateway'
export const ATTACHED_AUDIO_URL = 'ws://herald-main.invalid/speak-stream'
const MAX_BYTES = 8 * 1024 * 1024
const locallyCancelled = new WeakSet<WebSocket>()
/** A document/audio cancellation is distinct from failure of the authenticated peer. */
export function cancelAttachedSocket(socket: WebSocket): void {
  locallyCancelled.add(socket)
  socket.terminate()
}

/** Every connection is established and bound to the held process before HTTP/WS receives it.
 * Redirects, proxy agents, pooling and a second connection from an individual request are denied. */
export class AttachedTransport {
  private readonly identity: VerifiedWindowsIdentity
  private readonly sockets = new Set<net.Socket>()
  private readonly watcher: ReturnType<typeof setInterval>
  private closed = false
  constructor(private readonly target: WindowsAttachTarget, private readonly failed: (error: Error) => void, verifiedV3?: VerifiedWindowsIdentity) {
    this.identity = verifiedV3 ?? new HeldProcessIdentity(target.process)
    this.v3 = verifiedV3 !== undefined
    this.watcher = setInterval(() => {
      try { this.identity.assertAlive() } catch (error) { this.fail(this.v3 && error instanceof WindowsV3UnavailableError ? error : new Error('SC1: Der autorisierte Hermes-Prozess wurde beendet. Es wird kein Core gestartet.')) }
    }, 250)
    this.watcher.unref()
  }
  private readonly v3: boolean
  private networkFailure(error: unknown): Error {
    // Recheck the held generation: a WS error may precede the process watcher. Never use
    // this classifier for a failed socket-owner check or an authentication rejection.
    if (this.v3) {
      try { this.identity.assertAlive() } catch (gone) { if (gone instanceof WindowsV3UnavailableError) return gone }
      if (['ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT'].includes((error as NodeJS.ErrnoException)?.code ?? '')) return new WindowsV3UnavailableError('SC1 native transport unavailable')
      if (error instanceof WindowsV3UnavailableError) return error
    }
    return new Error('SC1 authenticated transport failed')
  }
  private fail(error: Error): void { if (!this.closed) { this.close(); this.failed(error) } }
  private async connect(timeoutMs=5000): Promise<net.Socket> {
    if (this.closed) throw new Error('SC1 transport is closed')
    this.identity.assertAlive()
    const port=Number(new URL(this.target.baseUrl).port)
    const socket = net.createConnection({ host:'127.0.0.1',port,localAddress:'127.0.0.1' })
    this.sockets.add(socket)
    socket.once('close',()=>this.sockets.delete(socket))
    // The socket contains no HTTP request or token until ownership has been verified.
    try {
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{socket.destroy();reject(this.v3 ? new WindowsV3UnavailableError('SC1 connection timed out') : new Error('SC1 connection timed out'))},timeoutMs)
        const finish=(error?: Error)=>{clearTimeout(timer);socket.off('error',errorHandler);socket.off('connect',connected);socket.off('close',closed);error?reject(error):resolve()}
        const errorHandler=(error: Error)=>finish(error), connected=()=>finish()
        const closed=()=>finish(new Error('SC1 connection cancelled'))
        socket.once('error',errorHandler);socket.once('connect',connected);socket.once('close',closed)
      })
      socket.on('error',()=>undefined)
    } catch(error) { socket.destroy(); const classified=this.networkFailure(error);this.fail(this.v3?classified:new Error('SC1: Die Verbindung zum autorisierten Core wurde verloren. Manuelle Prüfung erforderlich.'));throw this.v3?classified:error }
    try {
      if (this.closed) throw new Error('SC1 transport was superseded')
      this.identity.verifySocket(socket,port)
      return socket
    } catch(error) {socket.destroy();const classified=error instanceof Error?error:new Error('SC1 socket verification failed');this.fail(this.v3?classified:new Error('SC1: Die Verbindung zum autorisierten Core wurde verloren. Manuelle Prüfung erforderlich.'));throw error}
  }
  private connectionFactory(socket: net.Socket): () => net.Socket {
    let used=false
    return () => {
      if (used || this.closed || socket.destroyed) throw new Error('SC1 connection reuse rejected')
      try { this.identity.verifySocket(socket,Number(new URL(this.target.baseUrl).port)) }
      catch(error) { this.fail(this.v3?(error instanceof Error?error:new Error('SC1 socket verification failed')):new Error('SC1: Die Prozessidentität der Verbindung ist nicht mehr gültig.')); throw error }
      used=true;return socket
    }
  }
  async rest<T>(request: RestRequest, timeoutMs=60_000): Promise<T> {
    const deadline=performance.now()+timeoutMs
    if (!request || !['GET','POST','PUT','PATCH','DELETE'].includes(request.method) || typeof request.path!=='string' || !request.path.startsWith('/api/') || /[\x00-\x20\\#]/.test(request.path)) throw new Error('SC1 invalid REST request')
    const url=new URL(request.path,this.target.baseUrl)
    if (url.origin!==this.target.baseUrl || !url.pathname.startsWith('/api/')) throw new Error('SC1 invalid REST destination')
    for (const [key,value] of Object.entries(request.query??{})) if (value!==undefined && value!==null) url.searchParams.set(key,String(value))
    const body=request.body===undefined?undefined:JSON.stringify(request.body)
    if (body && Buffer.byteLength(body)>MAX_BYTES) throw new Error('SC1 request exceeds limit')
    const socket=await this.connect(Math.min(5000,timeoutMs))
    const agent=new http.Agent({keepAlive:false,maxSockets:1})
    agent.createConnection=this.connectionFactory(socket)
    try {
      return await new Promise<T>((resolve,reject)=>{
        let settled=false,timer:ReturnType<typeof setTimeout>|undefined
        const finish=(error:unknown,value?:T)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value as T)}
        const network=(error:unknown)=>{if(settled)return;const classified=this.v3?this.networkFailure(error):error;if(this.v3)this.fail(classified as Error);finish(classified)}
        const req=http.request(url,{method:request.method,agent,headers:{'X-Hermes-Session-Token':this.target.token,...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},res=>{
          const chunks: Buffer[]=[];let bytes=0
          res.on('data',(chunk: Buffer)=>{bytes+=chunk.length;if(bytes>MAX_BYTES){finish(new Error('SC1 response exceeds limit'));req.destroy();return}chunks.push(chunk)})
          res.once('error',network)
          res.once('end',()=>{
            const text=Buffer.concat(chunks).toString('utf8')
            if (!res.statusCode || res.statusCode<200 || res.statusCode>=300) {const error=new Error(`SC1 backend HTTP ${res.statusCode??0}`);if(this.v3 && [401,403].includes(res.statusCode??0))this.fail(error);finish(error);return}
            try {finish(null,(text?JSON.parse(text):null) as T)}catch{finish(new Error('SC1 invalid JSON response'))}
          })
        })
        if(this.v3)timer=setTimeout(()=>{const error=new WindowsV3UnavailableError('SC1 request timed out');network(error);req.destroy()},Math.max(1,deadline-performance.now()))
        else req.setTimeout(60_000,()=>req.destroy(new Error('SC1 request timed out')))
        req.once('error',network);req.end(body)
      })
    } finally {agent.destroy();socket.destroy()}
  }
  async webSocket(kind:'gateway'|'speak-stream'): Promise<WebSocket> {
    if (kind!=='gateway' && kind!=='speak-stream') throw new Error('SC1 invalid socket kind')
    const socket=await this.connect()
    const endpoint=kind==='gateway'?'/api/ws':'/api/audio/speak-stream'
    const url=this.target.baseUrl.replace('http:','ws:')+endpoint+'?token='+encodeURIComponent(this.target.token)
    try {
      const ws = new WebSocket(url,{createConnection:this.connectionFactory(socket),followRedirects:false,perMessageDeflate:false,maxPayload:BACKEND_SOCKET_FRAME_BYTES,handshakeTimeout:5000})
      if(this.v3){
        // ws delegates its timeout to ClientRequest, whose connect event already happened
        // on our pre-admitted socket. Bound the upgrade explicitly for this socket only.
        const timer=setTimeout(()=>socket.destroy(new Error('SC1 WebSocket handshake timed out')),5000)
        const clear=()=>clearTimeout(timer)
        ws.once('open',clear);ws.once('error',clear);ws.once('close',clear)
      }
      let rejected=false
      // An audio/application socket can fail while the authenticated Core and gateway remain
      // healthy. Only authentication rejection or loss of the held generation tears both down.
      const checkGeneration=()=>{try{this.identity.assertAlive()}catch(error){this.fail(error instanceof Error?error:new Error('SC1 native identity unavailable'))}}
      if(this.v3)ws.on('unexpected-response',(_request,response)=>{rejected=true;response.destroy();if([401,403].includes(response.statusCode??0))this.fail(new Error(`SC1 WebSocket HTTP ${response.statusCode}`));else checkGeneration();ws.terminate()})
      ws.on('error',()=>{if(!locallyCancelled.has(ws) && !rejected){if(this.v3)checkGeneration();else this.fail(new Error('SC1: Der authentifizierte Socket ist fehlgeschlagen. Manuelle Prüfung erforderlich.'))}})
      ws.on('close',code=>{if(this.v3 && !locallyCancelled.has(ws) && !rejected){if([4401,4403,1008].includes(code))this.fail(new Error('SC1 WebSocket authentication or policy rejected'));else checkGeneration()}})
      return ws
    } catch(error) {socket.destroy();throw error}
  }
  close(): void {
    if (this.closed) return
    this.closed=true;clearInterval(this.watcher)
    for(const socket of this.sockets)socket.destroy()
    this.sockets.clear();this.identity.close()
  }
}
