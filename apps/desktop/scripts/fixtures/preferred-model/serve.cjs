const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
if(!process.argv[2])throw new Error('Pass the fixture output directory');
const output=path.resolve(process.argv[2]);
const server=http.createServer((req,res)=>{
const name=({'/':'index.html','/fixture.js':'fixture.js','/styles.css':'styles.css'})[req.url];
if(!name){res.writeHead(404);res.end();return}
res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
res.setHeader('Cache-Control','no-store');res.end(fs.readFileSync(path.join(output,name)));
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,pid:process.pid,backend:false})));
