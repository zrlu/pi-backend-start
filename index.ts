import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { spawn, execFile } from 'node:child_process';
import { get } from 'node:http';
import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export type Spec = {
 key: string; alias: string; port: number; served: string; cwd: string; script: string;
 start: string[]; stop: string[]; readySec: number; manual: boolean;
 alwaysReady?: boolean; containers?: string[]; lane?: number;
};
// Machine-specific backends live outside the repo; see backends.example.json.
function configPaths(): string[] {
 const paths: string[] = [];
 if (process.env.PI_BACKEND_CONFIG) paths.push(process.env.PI_BACKEND_CONFIG);
 try { paths.push(join(dirname(fileURLToPath(import.meta.url)), 'backends.json')); } catch { /* not an ES module */ }
 paths.push(join(homedir(), '.pi', 'agent', 'backends.json'));
 return paths;
}
function loadSpecs(): Spec[] {
 for (const file of configPaths()) {
  if (!existsSync(file)) continue;
  try {
   const parsed = JSON.parse(readFileSync(file, 'utf8'));
   return Array.isArray(parsed) ? parsed : (parsed.backends ?? []);
  } catch { /* unreadable or malformed config: try the next candidate */ }
 }
 return [];
}
export const SPECS: Spec[] = loadSpecs();
const isXpu = (spec:Spec) => spec.key.startsWith('local-xpu');
const laneLock = (spec:Spec) => isXpu(spec) ? (spec.lane ?? 18001) : spec.port;
const logDir = join(homedir(), '.pi', 'agent', 'backend-logs');
export function isReady(spec: Spec): Promise<boolean> {
 if ((spec as any).alwaysReady) return Promise.resolve(true);
 return new Promise(resolve => {
  const req = get({host:'127.0.0.1',port:spec.port,path:'/v1/models',timeout:3000},res => {
   let body = ''; res.on('data',chunk => {body += chunk;});
   res.on('error',()=>resolve(false));
   res.on('end',()=>{try {resolve(res.statusCode === 200 && JSON.parse(body).data.some((m:{id:string})=>m.id === spec.served));} catch {resolve(false);}});
  });
  req.on('timeout',()=>{req.destroy();resolve(false);}); req.on('error',()=>resolve(false));
 });
}
function tell(ctx: ExtensionContext, message:string, kind:'info'|'warning'|'error'='info') {
 if (ctx.hasUI) ctx.ui.notify(message,kind); else console.log(message);
}
function launch(spec:Spec,stop=false) {
 mkdirSync(logDir,{recursive:true}); const log=join(logDir,`${spec.alias}.log`);
 const child=spawn('pwsh',['-NoProfile','-File',join(spec.cwd,stop && spec.alias !== 'strata' ? 'stop.ps1' : spec.script),...(stop ? spec.stop : spec.start)],{cwd:spec.cwd,windowsHide:true,detached:false,stdio:['ignore','pipe','pipe']});
 child.stdout?.on('data',data=>appendFileSync(log,data));
 child.stderr?.on('data',data=>appendFileSync(log,data));
 const done=new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{child.stdout?.destroy();child.stderr?.destroy();resolve(code ?? -1);});});
 return {done,log};
}
// Docker state is authoritative even while vLLM is loading and /v1/models is unavailable.
export async function runningXpu(): Promise<Spec[]> {
 const output = await new Promise<string>((resolve,reject)=>{
  execFile('docker',['ps','--format','{{.Names}}'],{windowsHide:true,timeout:5000},(error,stdout)=>error ? reject(error) : resolve(stdout));
 });
  const names = output.trim().split(/\r?\n/).filter(Boolean);
  return SPECS.filter(spec=>isXpu(spec) && spec.containers?.some(name=>names.includes(name)));
}
export async function runningStrata(): Promise<Spec[]> {
 const spec=SPECS.find(s=>s.alias==='strata')!;
 const server=join(spec.cwd,'serve','server.py').replace(/'/g,"''");
 const engine=join(spec.cwd,'engine','strata.exe').replace(/'/g,"''");
 const command=`Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='strata.exe'" | Where-Object { $_.ExecutablePath -eq '${engine}' -or ($_.CommandLine -and $_.CommandLine.Contains('${server}')) } | Select-Object -ExpandProperty ProcessId`;
 const output=await new Promise<string>((resolve,reject)=>{
  execFile('pwsh',['-NoProfile','-Command',command],{windowsHide:true,timeout:10000},(error,stdout)=>error ? reject(error) : resolve(stdout));
 });
 return output.trim() ? [spec] : [];
}
export async function runningBackends(): Promise<Spec[]> {
 const [xpu,strata]=await Promise.all([runningXpu(),runningStrata()]);
 return [...xpu,...strata];
}

type Hooks = { ready:typeof isReady; running:typeof runningXpu; launch:typeof launch; started:typeof getBackendStart; pollMs:number };
export function backendLight(ready:boolean,running:boolean,starting:boolean):string {
 return ready ? '\u{1F7E2}' : (starting || running) ? '\u{1F7E1}' : '\u26AB';
}
function fmtUptime(ms:number):string {
 const s=Math.floor(ms/1000);
 if(s<60) return `${s}s`;
 const m=Math.floor(s/60);
 if(m<60) return `${m}m`;
 const h=Math.floor(m/60);
 if(h<24) return `${h}h`;
 return `${Math.floor(h/24)}d`;
}
function displayWidth(text:string):number {
 let width=0;for(const ch of text) width+=ch.codePointAt(0)!>0xffff ? 2 : 1;
 return width;
}
// Render the readiness light plus as much uptime as the footer slot width allows:
// full "uptime: 2m", short "up:2m", compact "2m", or the light alone. Unknown width
// shows the full form so the footer can measure and reserve room for it.
export function backendStatus(dot:string, uptime?:string, width?:number):string {
	if(!uptime) return dot;
	const full=`${dot} uptime: ${uptime}`;
	const short=`${dot} up:${uptime}`;
	const compact=`${dot} ${uptime}`;
	if(width===undefined) return full;
	if(width>=displayWidth(full)) return full;
	if(width>=displayWidth(short)) return short;
	return width>=displayWidth(compact) ? compact : dot;
}
// Query the actual start timestamp of a backend (survives pi restart).
async function getBackendStart(spec:Spec):Promise<number|undefined> {
 if ((spec as any).alwaysReady) return Date.now();
 try {
  if(isXpu(spec)) {
   // Find the container name for this spec
   const candidates=spec.containers;
   if(!candidates) return undefined;
   for(const name of candidates) {
    try {
     const out=await new Promise<string>((resolve,reject)=>{
      execFile('docker',['inspect','--format','{{.State.StartedAt}}',name],{windowsHide:true,timeout:3000},(e,stdout)=>e?reject(e):resolve(stdout));
     });
     const t=Date.parse(out.trim());
     if(!isNaN(t)) return t;
    } catch { /* container not found, try next */ }
   }
   return undefined;
  } else {
   // Strata: get process creation time
   const server=join(spec.cwd,'serve','server.py').replace(/'/g,"''");
   const engine=join(spec.cwd,'engine','strata.exe').replace(/'/g,"''");
   const cmd=`Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='strata.exe'" | Where-Object { $_.ExecutablePath -eq '${engine}' -or ($_.CommandLine -and $_.CommandLine.Contains('${server}')) } | Select-Object -First 1 -ExpandProperty CreationDate`;
   const out=await new Promise<string>((resolve,reject)=>{
    execFile('pwsh',['-NoProfile','-Command',cmd],{windowsHide:true,timeout:5000},(e,stdout)=>e?reject(e):resolve(stdout));
   });
   const t=Date.parse(out.trim());
   return isNaN(t)?undefined:t;
  }
 } catch { return undefined; }
}
export function createBackendExtension(pi:ExtensionAPI, overrides:Partial<Hooks>={}) {
 const hooks:Hooks={ready:isReady,running:runningBackends,launch,started:getBackendStart,pollMs:5000,...overrides};
 const pending=new Map<number,Promise<boolean>>();
 const starting=new Set<string>();
 const startTs=new Map<string,number>();
 const slotWidths=new Map<string,number>();
 let lastCtx:ExtensionContext|undefined;
 // The footer reports how much room each slot has; use it to trim the backend status.
 pi.events.on('pi.footer.slotWidth',data=>{
  const report=data as {key?:unknown;width?:unknown}|undefined;
  if(typeof report?.key!=='string'||typeof report.width!=='number') return;
  if(slotWidths.get(report.key)===report.width) return;
  slotWidths.set(report.key,report.width);
  // A resize changes the slot width mid-render; re-render the light now instead of waiting for the poll.
  if(report.key==='backend'&&lastCtx) void updateLights(lastCtx);
 });
 let lightsRevision=0;
 let selecting=false;
 let watch:ReturnType<typeof setInterval>|undefined;
 const current=(ctx:ExtensionContext)=>SPECS.find(s=>s.key === `${ctx.model?.provider}/${ctx.model?.id}`
  || (s.alwaysReady && s.key.split('/')[0] === ctx.model?.provider));
 async function select(spec:Spec,ctx:ExtensionContext) {
  if(current(ctx)?.key===spec.key) return true;
  const [provider,id]=spec.key.split('/');
  const model=ctx.modelRegistry.find(provider,id);
  if(!model) {tell(ctx,`Running ${spec.alias} has no Pi model registration; backend left running.`,'warning');return false;}
  selecting=true;
  try {
   if(!await pi.setModel(model)) {tell(ctx,`Cannot select ${spec.key}; backend left running.`,'warning');return false;}
   tell(ctx,`Selected backend: ${spec.alias} :${spec.port}`);
   return true;
  } finally {selecting=false;}
 }
 async function start(spec:Spec,ctx:ExtensionContext,explicit=false):Promise<boolean> {
  const lock=laneLock(spec);
  while(pending.has(lock)) await pending.get(lock);
  if(explicit && !await select(spec,ctx)) return false;
  starting.add(spec.key);
  void updateLights(ctx);
  const work=(async()=>{
   const t0=Date.now();
   if(await hooks.ready(spec)) return true;
   // A running but warming container must be reused, not recreated.
   const warming=(await hooks.running()).some(s=>s.key===spec.key);
   tell(ctx,`${warming ? 'Waiting for' : 'Starting'} ${spec.alias} :${spec.port}...`);
   if(ctx.hasUI) ctx.ui.setStatus('backend',`starting ${spec.alias} :${spec.port}`);
   try {
    let result:number|undefined;let failure:Error|undefined;let log='Docker container logs';
    if(!warming) {
     const child=hooks.launch(spec);log=child.log;
     child.done.then(code=>{result=code;},error=>{failure=error;});
    }
    const deadline=Date.now()+spec.readySec*1000;
    while(Date.now()<deadline) {
     if(failure) throw failure;
     if(result!==undefined && result!==0) throw new Error(`Launcher exited ${result}; see ${log}`);
     if(await hooks.ready(spec)) {const el=Date.now()-t0;const s=Math.floor(el/1000);const tag=s<60?`${s}s`:`${Math.floor(s/60)}m${s%60}s`;tell(ctx,`Ready: ${spec.alias} :${spec.port} (${tag})`);return true;}
     await new Promise(resolve=>setTimeout(resolve,2000));
    }
    throw new Error(`Startup timed out; see ${log}`);
   } catch(error) {tell(ctx,`${spec.alias}: ${error instanceof Error ? error.message : error}`,'error');return false;}
   finally {if(ctx.hasUI) ctx.ui.setStatus('backend',undefined);}
  })();
  pending.set(lock,work);try {return await work;} finally {pending.delete(lock);starting.delete(spec.key);await updateLights(ctx);}
 }
 async function updateLights(ctx:ExtensionContext) {
  if(!ctx.hasUI) return;
  lastCtx=ctx;
  const revision=++lightsRevision;
  const spec=current(ctx);
  if(!spec){ctx.ui.setStatus('backend',undefined);return;}
  const ready=await hooks.ready(spec);
  let running=false;
  if(!ready) try{running=(await hooks.running()).some(s=>s.key===spec.key);}catch{}
  if(revision!==lightsRevision || current(ctx)?.key!==spec.key) return;
  // A green light always requires a successful model readiness check.
  const dot=backendLight(ready,running,starting.has(spec.key));
  let uptime:string|undefined;
  if(ready){
   if(!startTs.has(spec.key)) {
    const ts=await hooks.started(spec);
    if(revision!==lightsRevision || current(ctx)?.key!==spec.key) return;
    startTs.set(spec.key,ts??Date.now());
   }
   uptime=fmtUptime(Date.now()-startTs.get(spec.key)!);
  } else { startTs.delete(spec.key); }
  ctx.ui.setStatus('backend',backendStatus(dot,uptime,slotWidths.get('backend')));
 }
 const auto=async(ctx:ExtensionContext)=>{
  const spec=current(ctx);
  // Only registered local backends participate; remote providers have no launcher.
  if(!spec || !/^(local-xpu(?:-[^/]+)?|local-cuda|local-opencode-free)\//.test(spec.key)) return;
  if ((spec as any).alwaysReady) return;
  await start(spec,ctx);
 };
 pi.on('session_start',async(_event,ctx)=>{
  // Session entry only observes status; it never selects a model or starts a backend.
  await updateLights(ctx);
  if(watch) clearInterval(watch);
  if(ctx.hasUI && hooks.pollMs>0) {
   watch=setInterval(()=>{
    // Readiness lights must keep updating during startup and agent activity.
    void updateLights(ctx);
   },hooks.pollMs);watch.unref();
  }
 });
 pi.on('session_shutdown',async()=>{if(watch) clearInterval(watch);watch=undefined;});
 pi.on('model_select',async(event,ctx)=>{
  if(selecting) return; // Explicit backend commands emit model_select through pi.setModel.
  void updateLights(ctx);
  const spec=SPECS.find(s=>s.key===`${event.model.provider}/${event.model.id}`);if(!spec)return;
  // Respect the user's selection; selecting a profile does not inspect/adopt another backend.
  // Non-XPU or no running container: defer start to before_agent_start.
 });
 pi.on('before_agent_start',async(_event,ctx)=>{
  // Lazy start: only launch the backend when the user actually sends a command.
  await auto(ctx);
 });
 pi.registerCommand('backend',{
  description:'Backend [start|stop|restart|status|list] [strata|swift15|jp-rp|nerkyor]. Restart stops then starts the backend. Start explicitly switches the running XPU profile; deployed containers are otherwise preserved.',
  handler:async(args,ctx)=>{
   const parts=args.trim().split(/\s+/).filter(Boolean);const verbs=['start','stop','status','list','restart'];
   const action=verbs.includes(parts[0]) ? parts[0] : 'start';const target=verbs.includes(parts[0]) ? parts[1] : parts[0];
   if(action==='list') {
    let active:Spec[]=[];try {active=await hooks.running();} catch(error) {tell(ctx,`Backend detection failed: ${String(error)}`,'warning');}
    for(const spec of SPECS) tell(ctx,`${await hooks.ready(spec) ? 'UP' : (starting.has(spec.key) || active.some(s=>s.key===spec.key)) ? 'LOADING' : 'DOWN'} :${spec.port} ${spec.key}`);return;
   }
   const spec=target ? SPECS.find(s=>[s.alias,s.key,s.key.split('/')[1]].includes(target)) : current(ctx);
   if(!spec){tell(ctx,'Unknown backend. Use /backend list','warning');return;}
   if(action==='status'){tell(ctx,`${await hooks.ready(spec) ? 'UP' : 'NOT READY'} :${spec.port} ${spec.key}`);return;}
   if(action==='stop') {
    if ((spec as any).alwaysReady) {tell(ctx,`${spec.alias} is always available; nothing to stop.`,'info');return;}
    const lock=laneLock(spec);while(pending.has(lock)) await pending.get(lock);
    try {const {done,log}=hooks.launch(spec,true);const code=await done;tell(ctx,code===0 ? `Stopped: ${spec.alias}` : `Stop failed (${code}); see ${log}`,code===0 ? 'info' : 'error');}catch(error){tell(ctx,String(error),'error');}
    void updateLights(ctx);return;
   }
   if(action==='restart') {
    if ((spec as any).alwaysReady) {tell(ctx,`${spec.alias} is always available; nothing to restart.`,'info');return;}
    const lock=laneLock(spec);while(pending.has(lock)) await pending.get(lock);
    try {const {done,log}=hooks.launch(spec,true);const code=await done;if(code!==0) tell(ctx,`Stop returned ${code}; continuing restart`, 'warning');}catch(error){tell(ctx,`Stop failed: ${String(error)}`,'error');}
      if(await start(spec,ctx,true)) await select(spec,ctx);
    void updateLights(ctx);
    return;
   }
    if(await start(spec,ctx,true)) await select(spec,ctx);
   void updateLights(ctx);
  }
 });
}
export default function(pi:ExtensionAPI) {createBackendExtension(pi);}
