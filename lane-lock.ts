import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Kernel-owned named pipes serialize Pi windows and release automatically on exit.
export async function withBackendLane<T>(lane:number, work:()=>Promise<T>, onWait:()=>void=()=>{}, timeoutMs=1800000):Promise<T> {
 const name='pi-backend-'+createHash('sha256').update(`${homedir()}:${lane}`).digest('hex').slice(0,24);
 const endpoint=process.platform==='win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(),name+'.sock');
 const deadline=Date.now()+timeoutMs;
 let announced=false;
 while(true) {
  const server=createServer(socket=>socket.destroy());
  try {
   await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(endpoint,()=>{server.removeListener('error',reject);resolve();});
   });
  } catch(error:any) {
   server.close();
   if(error.code!=='EADDRINUSE') throw error;
   if(!announced){announced=true;onWait();}
   if(Date.now()>=deadline) throw new Error('Another Pi window is still operating this backend; no backend was stopped.');
   await new Promise(resolve=>setTimeout(resolve,200));
   continue;
  }
  try {return await work();}
  finally {
   await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
 }
}
