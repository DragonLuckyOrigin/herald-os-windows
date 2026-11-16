import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from '@nanostores/react'
import { AgentsSection } from '../../../src/features/settings/sections/AgentsSection.tsx'
import { $prefs, $env, applyPrefsToDocument } from '../../../src/store/backend.ts'
import { bindLanguage } from '../../../src/store/i18n.ts'
import { $activeChatId, $chats } from '../../../src/store/chat.ts'
import { $notifications } from '../../../src/store/notifications.ts'
import { $providerChanges } from '../../../src/store/model-provider.ts'
import { atom } from 'nanostores'

const writes=atom<any[]>([])
let enabled=true, hold=false, release: (()=>void)|undefined, price=true
let selected='one.gguf', provider='llamacpp'
const record=(value:any)=>writes.set([...writes.get(),value])
const options=()=>({provider,model:selected,providers:[{slug:provider,name:provider==='llamacpp'?'Lokaler Hermes-Test':'Subscription-Test',authenticated:true,is_current:true,models:['one.gguf','two.gguf','org/Größe:Q4_K_M']}]})
;(window as any).fixtureGateway=async(method:string,params:any)=>{
 if(method==='model.options')return options()
 if(method==='config.set'){record({method,...params});return {key:'model',value:params.value.split(' --provider ')[0]}}
 if(method==='config.get')return {value:'ask'}
 if(method==='tools.list')return {tools:[]}
 throw new Error('Synthetic unsupported read: '+method)
}
window.heraldOS={...window.heraldOS,backend:{rest:async(request:any)=>{
 if(request.method==='GET'){
  if(request.path==='/api/config')return {local_runtime:{enabled}}
  if(request.path==='/api/env')return {}
  if(request.path==='/api/providers/oauth')return {providers:[]}
  if(request.path==='/api/config/raw')return {yaml:''}
  if(request.path==='/api/tools/terminal/backends')return {active:'local',backends:[{name:'local',label:'Local fixture'}]}
  if(request.path==='/api/tools/toolsets')return []
  throw new Error('Synthetic unsupported read: '+request.path)
 }
 if(request.path==='/api/model/set' && request.method==='POST'){
  record({method:'POST',...request.body})
  if(hold)await new Promise<void>(resolve=>{release=resolve})
  if(price&&!request.body.confirm_expensive_model)return {confirm_required:true,confirm_message:'Synthetische Preisbestätigung'}
  selected=request.body.model
  return {ok:true,provider,model:selected}
 }
 throw new Error('Synthetic write refused')
}},bridge:{readPolicy:async()=>'tiers:\n  act: confirm\n',readAudit:async()=>[],writePolicy:async()=>{throw new Error('Synthetic policy write refused')}},policy:{get:async()=>({tier:'ask'})},audit:{list:async()=>[]},notifications:{native:async()=>{}},prefs:{set:async(p:any)=>({...$prefs.get(),...p})}} as any
$env.set({platform:'win32',languages:['de-DE'],hermesHome:'/synthetic',homeDir:'/synthetic',version:'0.1.3-test-only',isDev:true,shellMode:'desktop'} as any)
$prefs.set({...$prefs.get(),language:'de-DE'})
applyPrefsToDocument($prefs.get());bindLanguage()
const session=(id:string)=>{$chats.set({['original']:{sessionId:'original'},['other']:{sessionId:'other'}} as any);$activeChatId.set(id)}
session('original')
function Fixture(){
 const log=useStore(writes), notices=useStore($notifications),active=useStore($activeChatId)
 const [runtime,setRuntime]=useState(enabled), [holding,setHolding]=useState(hold),[counter,setCounter]=useState(0)
 return <><header><h1>5A: synthetische Bedienprüfung</h1><p>Reale Komponenten und Modellstore. Kein Electron, kein Backend, keine Inferenz. Netzverbindungen per CSP gesperrt.</p>
 <p>Testsitzung: {active}; Runtime-Fixture: {String(runtime)}; Antwort halten: {String(holding)}</p>
 <button onClick={()=>{enabled=!enabled;setRuntime(enabled)}}>Runtime-Fixture umschalten</button>
 <button onClick={()=>{provider=provider==='llamacpp'?'openai-codex':'llamacpp';$providerChanges.set($providerChanges.get()+1)}}>Anbieter A/B wechseln</button>
 <button onClick={()=>session(active==='original'?'other':'original')}>Testsitzung wechseln</button>
 <button onClick={()=>{hold=!hold;setHolding(hold)}}>Antwort halten umschalten</button>
 <button onClick={()=>{release?.();release=undefined}}>Antwort freigeben</button>
 <button onClick={()=>{enabled=true;setRuntime(true);hold=false;setHolding(false);price=true;selected='one.gguf';provider='llamacpp';session('original');writes.set([]);$notifications.set([]);$providerChanges.set($providerChanges.get()+1);setCounter(counter+1)}}>Fixture zurücksetzen</button>
 <h2>Synthetische Writes</h2><pre aria-label="Synthetische Writes">{JSON.stringify(log,null,2)}</pre>
 <h2>Hinweise</h2><pre aria-label="Hinweise">{JSON.stringify(notices.map(n=>({title:n.title,body:n.body})),null,2)}</pre>
 </header><main key={counter}><AgentsSection/></main></>
}
createRoot(document.getElementById('root')!).render(<Fixture/>)
