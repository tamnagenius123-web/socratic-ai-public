import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { prepareLocalSchema } from './prepare-local-schema.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smoke = process.argv.includes('--smoke');
const requestedPort = process.argv.find((argument) => argument.startsWith('--port='));
const port = requestedPort ? Number(requestedPort.split('=')[1]) : 8787;
if (!Number.isInteger(port) || port<0 || port>65535) throw new Error('Invalid local port');
let blockedOutboundRequests = 0;
const denyOutbound = () => { blockedOutboundRequests++; return new Response('External services are disabled in the local synthetic demo.', { status:503 }); };
const runtime = new Miniflare({
  modules:true, scriptPath:resolve(root,'dist/_worker.js'), compatibilityDate:'2026-03-31',
  compatibilityFlags:['nodejs_compat'], host:'127.0.0.1', port:0, inspectorPort:0,
  log:new Log(LogLevel.ERROR), d1Databases:{DB:'socratic-synthetic-local-only'}, d1Persist:false,
  bindings:{JWT_SECRET:randomBytes(32).toString('hex'),GROWTH_CYCLE_HMAC_SECRET:randomBytes(32).toString('hex')}, outboundService:denyOutbound,
});

async function initialize() {
  const schema=prepareLocalSchema(); const db=await runtime.getD1Database('DB');
  for (const sql of schema.definitions) await db.prepare(sql).run();
  // Reviewed product constants are inserted before immutable runtime guards are attached.
  for (const {table,row} of schema.catalogs) {
    const columns=Object.keys(row); const names=columns.map((name)=>'"'+name.replaceAll('"','""')+'"');
    await db.prepare(`INSERT INTO "${table}" (${names.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).bind(...columns.map((column)=>row[column])).run();
  }
  for (const sql of schema.triggers) await db.prepare(sql).run();
  await db.prepare('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, public_derivative_sha256 TEXT NOT NULL)').run();
  for (const migration of schema.migrationFiles) await db.prepare('INSERT INTO d1_migrations(name,public_derivative_sha256) VALUES (?,?)').bind(migration.name,migration.sha256).run();
  const violations=await db.prepare('PRAGMA foreign_key_check').all();
  if (violations.results.length) throw new Error('LOCAL_D1_FOREIGN_KEY_VIOLATION');
  return { db, tables:schema.tables, catalogRows:schema.catalogs.length };
}

const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml','.txt':'text/plain','.webmanifest':'application/manifest+json'};
async function handle(request) {
  const url=new URL(request.url); const relative=decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (!relative.startsWith('api/')) {
    const publicAsset=relative.startsWith('static/') || relative.startsWith('third-party-licenses/') || ['index.html','manifest.json','site.webmanifest','robots.txt','sw.js'].includes(relative);
    const base=resolve(root,'dist'); const path=resolve(base,publicAsset ? relative : 'index.html');
    if (!path.startsWith(base+sep)) return new Response('Not found',{status:404});
    try {
      if (!(await stat(path)).isFile()) return new Response('Not found',{status:404});
      let body=await readFile(path);
      if (extname(path)==='.html') body=Buffer.from(body.toString('utf8').replace(/<body([^>]*)>/i,'<body$1><div role="status" style="padding:10px;background:#fff3cd;color:#402d00;text-align:center">Local synthetic demo · External AI services are disabled · Data resets on restart</div>'));
      return new Response(body,{headers:{'content-type':types[extname(path)]||'application/octet-stream'}});
    }
    catch { return new Response('Not found',{status:404}); }
  }
  return runtime.dispatchFetch(request.url, {
    method:request.method, headers:Object.fromEntries(request.headers),
    ...(['GET','HEAD'].includes(request.method) ? {} : {body:await request.arrayBuffer()}),
  });
}

async function smokeCheck(initialized) {
  const checks=[];
  async function call(path,method='GET',body,token) {
    const headers={'content-type':'application/json'}; if(token) headers.authorization=`Bearer ${token}`;
    return handle(new Request('http://localhost'+path,{method,headers,...(body ? {body:JSON.stringify(body)} : {})}));
  }
  function check(name,condition) { if(!condition) throw new Error('LOCAL_SMOKE_FAILED:'+name); checks.push(name); }
  const home=await call('/'); check('home renders',home.status===200 && (await home.text()).length>200);
  const health=await call('/api/health');const readiness=await health.json();
  check('database and journey schema ready',readiness.checks.database.status==='ready' && readiness.checks.trainingJourney.status==='ready');
  check('AI readiness remains honestly unavailable',health.status===503 && readiness.checks.aiRouting.runtimeVerification==='unconfigured');
  const assets=await call('/static/tailwind.generated.css'); check('static CSS is served',assets.status===200);
  const anonymous=await call('/api/auth/me'); check('anonymous identity rejected',anonymous.status===401);
  const password=randomBytes(20).toString('hex');
  const registration=await call('/api/auth/register','POST',{username:'synthetic_student',email:'student@example.invalid',password});
  const account=await registration.json(); check('synthetic registration',registration.status===200 && Boolean(account.accessToken));
  const token=account.accessToken;
  const me=await call('/api/auth/me','GET',undefined,token); check('synthetic identity resolved',me.status===200);
  const login=await call('/api/auth/login','POST',{email:'student@example.invalid',password}); check('synthetic login',login.status===200);
  const books=await call('/api/books','GET',undefined,token); const library=await books.json(); check('synthetic library available',books.status===200 && library.books.length>0);
  const caseResponse=await call('/api/training/cases','GET',undefined,token); const caseCatalog=await caseResponse.json();
  const syntheticCase=caseCatalog.cases?.find(entry=>entry.caseId==='HH-INVEST-100B');
  const syntheticSourceIds=['SYNTHETIC-HH-DEMAND-EXAMPLE','SYNTHETIC-HH-OPERATIONS-EXAMPLE'];
  check('training catalog labels synthetic source identities',caseResponse.status===200 && syntheticCase?.caseVersion==='1.1.0-synthetic' && syntheticCase.sourceManifestVersion==='HH-SYNTHETIC-SOURCES-1.0.0' && syntheticCase.sources.length===2 && syntheticCase.sources.every(source=>syntheticSourceIds.includes(source.bookId) && source.author==='Socratic AI synthetic example'));
  const sourceCards=library.books.filter(book=>syntheticSourceIds.includes(book.id));
  check('synthetic training cards seed usable local chunks',sourceCards.length===2 && sourceCards.reduce((sum,book)=>sum+book.chunkCount,0)>=3 && sourceCards.every(book=>book.textPreview.startsWith('[Synthetic example') && book.author==='Socratic AI synthetic example'));
  const upload=await call('/api/books/upload','POST',{title:'Synthetic smoke document',author:'Synthetic fixture',language:'en',text:'A fictional neighborhood is choosing how to share a small park. One proposal reserves mornings for quiet activities. Another proposal rotates the schedule each week. Residents ask what evidence would support a fair decision.'},token);
  const uploaded=await upload.json(); check('synthetic document upload',upload.status===200 && Boolean(uploaded.bookId || uploaded.id));
  const id=uploaded.bookId || uploaded.id;
  const read=await call('/api/books/'+id,'GET',undefined,token); check('owner document readable',read.status===200);
  const hidden=await call('/api/books/'+id); check('anonymous private document hidden',hidden.status===404);
  const deleted=await call('/api/books/'+id,'DELETE',undefined,token); check('owner document deletion',deleted.status===200);
  const probe=new Miniflare({modules:true,compatibilityDate:'2026-03-31',host:'127.0.0.1',port:0,inspectorPort:0,log:new Log(LogLevel.ERROR),script:'export default {async fetch(){const r=await fetch("https://example.invalid/outbound-probe");return new Response(String(r.status))}}',outboundService:denyOutbound});
  try { const response=await probe.dispatchFetch('http://localhost/'); check('worker outbound fetch denied',await response.text()==='503'); } finally { await probe.dispose(); }
  const rows=await initialized.db.prepare('SELECT count(*) AS count FROM users').first();
  return { status:'passed',checks,checkCount:checks.length,tables:initialized.tables,catalogRows:initialized.catalogRows,syntheticUsers:rows.count,blockedOutboundRequests,externalServiceCredentialsSupplied:false };
}

let server;
try {
  const initialized=await initialize();
  if (smoke) { const result=await smokeCheck(initialized); console.log(JSON.stringify(result)); await runtime.dispose(); }
  else {
    server=createServer(async(req,res)=>{
      try {
        const chunks=[];for await(const chunk of req) chunks.push(chunk);
        const request=new Request('http://127.0.0.1:'+server.address().port+req.url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
        const response=await handle(request);
        res.writeHead(response.status,{...Object.fromEntries(response.headers),'content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'"});
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500,{'content-type':'text/plain'});res.end('Local demo request failed.'); }
    });
    server.once('error',async(error)=>{console.error(error.code==='EADDRINUSE' ? 'Local port is occupied; choose --port=0 or another loopback port.' : 'Local listener could not start.');await Promise.race([runtime.dispose(),new Promise(resolve=>setTimeout(resolve,2000))]);process.exit(1);});
    server.listen(port,'127.0.0.1',()=>console.log(`Local synthetic demo: http://127.0.0.1:${server.address().port}. Data resets on restart; external services are disabled.`));
    const stop=async()=>{server.close();await Promise.race([runtime.dispose(),new Promise(resolve=>setTimeout(resolve,2000))]);process.exit(0);};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }
} catch(error) {
  if(server)server.close();await runtime.dispose();
  console.error(error instanceof Error ? error.message : 'LOCAL_DEMO_FAILED');process.exitCode=1;
}
