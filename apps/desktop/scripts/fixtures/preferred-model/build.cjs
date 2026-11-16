const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../../../..'),esbuild=require(path.join(root,'node_modules/esbuild'));
if(!process.argv[2])throw new Error('Pass a separate fixture output directory');
const output=path.resolve(process.argv[2]);
(async()=>{
fs.mkdirSync(output,{recursive:true});
await esbuild.build({entryPoints:[path.join(__dirname,'fixture.tsx')],bundle:true,platform:'browser',format:'esm',jsx:'automatic',outfile:path.join(output,'fixture.js'),banner:{js:'window.heraldOS={office:{onChanged:()=>()=>{},report:()=>{}}};'},plugins:[{name:'synthetic-gateway-boundary',setup(b){b.onResolve({filter:/gateway\.ts$/},a=>path.resolve(a.resolveDir,a.path)===path.resolve(root,'apps/desktop/src/store/gateway.ts')?{path:path.join(__dirname,'gateway.ts')}:null)}}],nodePaths:[path.join(root,'node_modules')],alias:{'@herald-os/client':path.join(root,'packages/hermes-client/src/index.ts')},loader:{'.png':'dataurl','.jpg':'dataurl','.svg':'dataurl','.woff2':'dataurl'},define:{'process.env.NODE_ENV':'"development"'},logLevel:'warning'});
const assets=path.join(root,'apps/desktop/dist/renderer/assets');
const css=fs.readdirSync(assets).find(x=>/^index-.*\.css$/.test(x));
fs.copyFileSync(path.join(assets,css),path.join(output,'styles.css'));
fs.writeFileSync(path.join(output,'index.html'),`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="/styles.css"><title>5A Preferred Model – isolierte Prüfung</title><style>body{overflow:auto!important;height:auto!important}header,main{padding:20px;max-width:1100px;margin:auto}header button{padding:8px;margin:6px;border:1px solid #888}pre{white-space:pre-wrap;font-size:12px}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
console.log(JSON.stringify({fixtureBuild:'PASS',realStore:true,realComponents:true,backend:false,css}));
})().catch(e=>{console.error(e);process.exitCode=1});
