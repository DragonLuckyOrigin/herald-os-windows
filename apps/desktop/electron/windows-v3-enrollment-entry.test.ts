import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source=fs.readFileSync(new URL('./main.ts',import.meta.url),'utf8')

describe('actual main.ts explicit enrollment branch',()=>{
  async function run(options:{requested?:boolean;platform?:string;primary?:boolean;inspectionError?:boolean;failure?:boolean}={}) {
    const start=source.indexOf('const enrollmentRequested ='),end=source.indexOf('// Normal desktop startup remains separate from enrollment.')
    expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start)
    const enroll=vi.fn(async()=>{if(options.failure)throw new Error('must-not-be-logged-secret')})
    const app={requestSingleInstanceLock:vi.fn(()=>options.primary!==false),whenReady:vi.fn(async()=>{}),exit:vi.fn()}
    const normalStart=vi.fn(),error=vi.fn()
    runInNewContext(source.slice(start,end)+'normalStart();\n}',{app,enrollWindowsV3:enroll,normalStart,console:{error},process:{platform:options.platform??'win32',argv:options.requested===false?[]:['--enroll-windows-v3']},profileInspectionError:options.inspectionError?new Error('inspection'):undefined})
    await new Promise(resolve=>setImmediate(resolve))
    return {app,enroll,normalStart,error}
  }
  it('never enrolls on ordinary launch',async()=>{
    const r=await run({requested:false});expect(r.enroll).not.toHaveBeenCalled();expect(r.normalStart).toHaveBeenCalledOnce()
  })
  it.each([{platform:'linux'},{platform:'darwin'},{primary:false},{inspectionError:true}])('refuses without ordinary startup: %j',async options=>{
    const r=await run(options);expect(r.enroll).not.toHaveBeenCalled();expect(r.normalStart).not.toHaveBeenCalled();expect(r.app.exit).toHaveBeenCalledWith(1)
  })
  it('exits successfully only after enrollment, without starting backend or UI',async()=>{
    const r=await run();expect(r.enroll).toHaveBeenCalledOnce();expect(r.normalStart).not.toHaveBeenCalled();expect(r.app.exit).toHaveBeenCalledWith(0)
  })
  it('fails closed without emitting exception contents or continuing normal startup',async()=>{
    const r=await run({failure:true});expect(r.app.exit).toHaveBeenCalledWith(1);expect(r.normalStart).not.toHaveBeenCalled();expect(JSON.stringify(r.error.mock.calls)).not.toContain('must-not-be-logged-secret')
  })
  it('never forwards an enrollment invocation to the running window',()=>{
    const start=source.indexOf("app.on('second-instance'"),end=source.indexOf("app.on('activate'",start)
    expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start)
    const mainWindow={show:vi.fn(),focus:vi.fn()},handlers=new Map<string,Function>()
    runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText,{mainWindow,app:{on:(name:string,callback:Function)=>handlers.set(name,callback)}})
    const handle=handlers.get('second-instance')!
    handle({},['--enroll-windows-v3'],'',{});handle({},[],'',{windowsV3Enrollment:true})
    expect(mainWindow.show).not.toHaveBeenCalled();expect(mainWindow.focus).not.toHaveBeenCalled()
    handle({},[],'',{})
    expect(mainWindow.show).toHaveBeenCalledOnce();expect(mainWindow.focus).toHaveBeenCalledOnce()
  })
})
