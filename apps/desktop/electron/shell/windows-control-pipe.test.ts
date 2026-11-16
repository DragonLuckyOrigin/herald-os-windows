import net from 'node:net'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))
import { WindowsControlPipe } from './windows-control-pipe.ts'
import { OsControlServer, osControlToken } from './os-control.ts'

const servers: WindowsControlPipe[] = []
const clients: net.Socket[] = []
const children: ChildProcessWithoutNullStreams[] = []
const controls: OsControlServer[] = []
const decoys: net.Server[] = []
function python(endpoint: string, body: string, connect = true, timeout = 8000) {
  const executable = process.env.HERALD_TEST_PYTHON
  if (!executable) throw new Error('HERALD_TEST_PYTHON must identify the qualified Windows Python')
  const modulePath = path.resolve('../../plugins/herald-os-bridge/bridge/windows_pipe.py')
  const source = 'import importlib.util,sys\nspec=importlib.util.spec_from_file_location("pipe",sys.argv[1])\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n' + (connect ? 'p=m.WindowsPipe()\np.settimeout(3)\np.connect(sys.argv[2])\n' : '') + body
  const child = spawn(executable, ['-B', '-S', '-u', '-c', source, modulePath, endpoint], { windowsHide: true, stdio: 'pipe', timeout, env: { ...process.env, HERALD_OS_CONTROL_SOCKET: endpoint, HERALD_OS_CONTROL_TOKEN: osControlToken() } })
  children.push(child)
  let stdout = '', stderr = ''
  let ready!: () => void
  const connected = new Promise<void>(resolve => { ready = resolve })
  child.stdout.on('data', data => { stdout += data.toString(); if (stdout.includes('CONNECTED')) ready() })
  child.stderr.on('data', data => { stderr += data.toString() })
  const done = new Promise<string>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`Python pipe client failed (${code}): ${stderr}`)))
  })
  return { done, connected, child }
}
afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy()
  await Promise.all(servers.splice(0).map(server => server.stop()))
  await Promise.all(controls.splice(0).map(server => server.stop()))
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill()
  await Promise.all(decoys.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})


describe.skipIf(process.platform !== 'win32')('native pipe negative cases and lifecycle', () => {
  it('drains a read and closes the endpoint when the accept callback throws', async () => {
    let report!: (error: Error) => void
    const failed = new Promise<Error>(resolve => { report = resolve })
    const server = new WindowsControlPipe(connection => { connection.resume(); throw new Error('injected accept failure') }, undefined, report)
    servers.push(server)
    const endpoint = await server.start()
    const client = python(endpoint, 'try:\n p=m.WindowsPipe()\n p.connect(sys.argv[2])\n assert p.recv(1)==b""\nexcept OSError:\n pass\nfinally:\n p.close()\nprint("CLOSED")', false)
    expect((await failed).message).toBe('injected accept failure')
    expect(server.securityVerified).toBe(false)
    await expect(server.stop()).rejects.toThrow('injected accept failure')
    expect(await client.done).toBe('CLOSED')
    const probe = net.createConnection(endpoint)
    clients.push(probe)
    await expect(new Promise<void>((resolve, reject) => { probe.once('connect', resolve); probe.once('error', reject) })).rejects.toThrow()
  })
  it.each(['dacl', 'pid', 'creation'])('rejects a native %s decoy before sending application bytes', async kind => {
    const secured = new WindowsControlPipe(connection => connection.destroy())
    servers.push(secured)
    let endpoint = await secured.start()
    await secured.stop()
    if (kind === 'pid') endpoint = endpoint.replace('herald-os-' + process.pid + '-', 'herald-os-4294967295-')
    if (kind === 'creation') endpoint = endpoint.replace(/-[0-9a-f]+-([0-9a-f]{32})$/, '-1-$1')
    let received = 0
    const decoy = net.createServer(connection => {
      clients.push(connection)
      connection.on('data', data => { received += data.length })
    })
    decoys.push(decoy)
    await new Promise<void>((resolve, reject) => { decoy.once('error', reject); decoy.listen(endpoint, resolve) })
    const client = python(endpoint, 'p=m.WindowsPipe()\ntry:\n p.connect(sys.argv[2])\nexcept OSError as e:\n print("REJECTED",str(e))\nelse:\n raise AssertionError("decoy accepted")\nfinally:\n p.close()', false)
    expect(await client.done).toContain('REJECTED')
    expect(received).toBe(0)
  })

  it('bounds a busy client and accepts a new client after the first one closes', async () => {
    const server = new WindowsControlPipe(connection => connection.pipe(connection))
    servers.push(server)
    const endpoint = await server.start()
    const first = python(endpoint, 'print("CONNECTED",flush=True)\nassert sys.stdin.readline()=="release\\n"\np.sendall(b"held\\n")\nb=b""\nwhile not b.endswith(b"\\n"): b+=p.recv(20)\nassert b==b"held\\n"\nprint("STILL_HELD")\np.close()')
    await Promise.race([first.connected, first.done.then(() => { throw new Error('first client exited') })])
    // A delayed second launch must still encounter the first, explicitly held client.
    await delay(600)
    const second = python(endpoint, 'p=m.WindowsPipe()\np.settimeout(.1)\ntry:\n p.connect(sys.argv[2])\nexcept TimeoutError:\n print("BUSY_TIMEOUT")\nelse:\n raise AssertionError("second client unexpectedly connected")\nfinally:\n p.close()', false)
    try {
      expect(await second.done).toBe('BUSY_TIMEOUT')
    } finally {
      first.child.stdin.end('release\n')
    }
    expect((await first.done).split(/\r?\n/)).toEqual(['CONNECTED', 'STILL_HELD'])
    const third = python(endpoint, 'p.sendall(b"again\\n")\nassert p.recv(20)==b"again\\n"\np.close()\nprint("RECONNECTED")')
    expect(await third.done).toBe('RECONNECTED')
  })

  it('cancels a blocked native write without retaining the pipe handle', async () => {
    let entered!: () => void
    const writing = new Promise<void>(resolve => { entered = resolve })
    const server = new WindowsControlPipe(connection => {
      connection.on('error', () => undefined)
      connection.write(Buffer.alloc(2 * 1024 * 1024), () => undefined)
      entered()
    })
    servers.push(server)
    const endpoint = await server.start()
    const client = python(endpoint, 'import time\nprint("CONNECTED",flush=True)\ntime.sleep(.4)\np.close()')
    await writing
    await delay(40)
    await server.stop()
    expect(server.securityVerified).toBe(false)
    await client.done
    const restarted = await server.start()
    expect(restarted).not.toBe(endpoint)
    expect(server.securityVerified).toBe(true)
  })

  it('runs the real Python ui client through original auth and command dispatch', async () => {
    const handle = vi.fn(async (request: Record<string, unknown>) => ({ ok: true, result: request.command }))
    const server = new OsControlServer('', handle)
    controls.push(server)
    const endpoint = await server.start()
    const client = python(endpoint, 'import types,pathlib,importlib,json\npackage=types.ModuleType("native_bridge")\npackage.__path__=[str(pathlib.Path(sys.argv[1]).parent)]\nsys.modules["native_bridge"]=package\nui=importlib.import_module("native_bridge.ui")\nprint(json.dumps(ui.run_command("docs.test",{"text":"Grüße 世界"})))', false)
    expect(JSON.parse(await client.done)).toEqual({ ok: true, result: 'docs.test' })
    expect(handle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cmd: 'ui', command: 'docs.test', args: { text: 'Grüße 世界' }, token: osControlToken() }))
  })

  it('lets a real ui request wait beyond five seconds for an authenticated busy client', async () => {
    let entered!: () => void, release!: () => void
    const active = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const handle = vi.fn(async (request: Record<string, unknown>) => {
      if (request.command === 'docs.hold') { entered(); await held }
      return { ok: true, result: request.command }
    })
    const server = new OsControlServer('', handle)
    controls.push(server)
    const endpoint = await server.start()
    const setup = 'import types,pathlib,importlib,json\npackage=types.ModuleType("native_bridge")\npackage.__path__=[str(pathlib.Path(sys.argv[1]).parent)]\nsys.modules["native_bridge"]=package\nui=importlib.import_module("native_bridge.ui")\n'
    const first = python(endpoint, setup + 'print(json.dumps(ui.run_command("docs.hold",timeout=12)))', false, 18000)
    const firstDone = first.done.then(value => ({ value }), error => ({ error }))
    try {
      await Promise.race([active, firstDone.then(() => { throw new Error('held request ended before dispatch') })])
      const second = python(endpoint, setup + 'print("CONNECTED",flush=True)\nprint(json.dumps(ui.run_command("docs.after",timeout=12)))', false, 18000)
      const secondDone = second.done.then(value => ({ value }), error => ({ error }))
      await Promise.race([second.connected, secondDone.then(() => { throw new Error('waiting request exited before starting') })])
      await delay(6000)
      release()
      const firstResult = await firstDone
      if ('error' in firstResult) throw firstResult.error
      expect(JSON.parse(firstResult.value)).toEqual({ ok: true, result: 'docs.hold' })
      const secondResult = await secondDone
      if ('error' in secondResult) throw secondResult.error
      expect(JSON.parse(secondResult.value.split(/\r?\n/).at(-1)!)).toEqual({ ok: true, result: 'docs.after' })
      expect(handle.mock.calls.map(([request]) => request.command)).toEqual(['docs.hold', 'docs.after'])
    } finally { release() }
  }, 25000)

  it.each(['wrong-auth', 'oversized-auth', 'request-before-auth'])('rejects %s without dispatch', async kind => {
    const handle = vi.fn(async () => ({ ok: true }))
    const server = new OsControlServer('', handle)
    controls.push(server)
    const wire = kind === 'wrong-auth' ? '{"cmd":"auth","token":"wrong"}\n'
      : kind === 'oversized-auth' ? 'x'.repeat(4097)
      : JSON.stringify({ cmd: 'ui-state', token: osControlToken() }) + '\n'
    const client = python(await server.start(), 'p.sendall(bytes.fromhex("' + Buffer.from(wire).toString('hex') + '"))\nb=b""\nwhile not b.endswith(b"\\n"): b+=p.recv(65536)\nprint(b.decode().strip())\np.close()')
    expect(JSON.parse(await client.done).ok).toBe(false)
    expect(handle).not.toHaveBeenCalled()
  })

  it('rejects an unverified listener without a TCP fallback', async () => {
    const start = vi.spyOn(WindowsControlPipe.prototype, 'start').mockResolvedValue('unverified')
    const stop = vi.spyOn(WindowsControlPipe.prototype, 'stop').mockResolvedValue(undefined)
    try {
      const server = new OsControlServer('', async () => ({ ok: true }))
      controls.push(server)
      await expect(server.start()).rejects.toThrow('startup was cancelled or failed')
      expect(stop).toHaveBeenCalled()
    } finally { start.mockRestore(); stop.mockRestore() }
  })
})

describe.skipIf(process.platform !== 'win32')('native protected Windows pipe', () => {
  it('creates protected local IPC and transfers fragmented Unicode through real native I/O', async () => {
    const server = new WindowsControlPipe(connection => connection.pipe(connection))
    servers.push(server)
    const endpoint = await server.start()
    expect(endpoint).toMatch(/^\\\\\.\\pipe\\herald-os-[1-9][0-9]*-[0-9a-f]+-[0-9a-f]{32}$/)
    expect(server.securityVerified).toBe(true)
    const client = python(endpoint, 'p.sendall(bytes.fromhex("4772c3bcc39f6520"))\np.sendall(bytes.fromhex("e4b896e7958c0a"))\nb=b""\nwhile not b.endswith(b"\\n"): b+=p.recv(65536)\nprint(b.hex())\np.close()')
    expect(await client.done).toBe(Buffer.from('Grüße 世界\n').toString('hex'))
  })

  it('refuses namespace replacement while the first instance remains owned', async () => {
    const first = new WindowsControlPipe(connection => connection.destroy())
    servers.push(first)
    const endpoint = await first.start()
    const second = new WindowsControlPipe(connection => connection.destroy(), endpoint)
    servers.push(second)
    await expect(second.start()).rejects.toThrow()
    expect(first.securityVerified).toBe(true)
  })

  it('cancels an unconnected accept and releases its namespace on stop', async () => {
    const server = new WindowsControlPipe(connection => connection.destroy())
    servers.push(server)
    const endpoint = await server.start()
    await server.stop()
    const client = net.createConnection(endpoint)
    clients.push(client)
    await expect(new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject) })).rejects.toThrow()
  })

  it('cancels a pending native read on stop without retaining a connection', async () => {
    const server = new WindowsControlPipe(connection => { connection.resume() })
    servers.push(server)
    const endpoint = await server.start()
    const client = python(endpoint, 'print("CONNECTED",flush=True)\nassert p.recv(1)==b""\np.close()')
    await Promise.race([client.connected, client.done.then(() => { throw new Error('Client exited before connection') })])
    await server.stop()
    expect(await client.done).toBe('CONNECTED')
  })

  it('does not grant permission-changing access even to the pipe owner', async () => {
    const server = new WindowsControlPipe(connection => connection.destroy())
    servers.push(server)
    const client = python(await server.start(), 'a=m._API()\nh=a.open(sys.argv[2],0x40000,0,None,3,0x40000000|0x00100000,None)\ncode=m.ctypes.get_last_error()\nif h!=m._INVALID: a.close(h)\nassert h==m._INVALID and code==5,(h,code)\nprint("DENIED")', false)
    expect(await client.done).toBe('DENIED')
  })
})
