/** Source ECS secret-memory preflight. No host/global setting is changed. */
import {closeSync,constants,fstatSync,openSync,readSync} from 'fs'
function proc(path:string):string{
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
 try{
  if(!fstatSync(fd).isFile())throw new Error('SMILES_REBOOT_PROFILE_REFUSED')
  const buffer=Buffer.alloc(65537);let size=0
  while(size<buffer.length){const n=readSync(fd,buffer,size,buffer.length-size,null);if(n===0)break;size+=n}
  if(size>65536)throw new Error('SMILES_REBOOT_PROFILE_REFUSED')
  return buffer.subarray(0,size).toString('ascii')
 }finally{closeSync(fd)}
}
export function sourceRuntimeReady():void{
 try{
  if(process.platform!=='linux'||!/^Max core file size\s+0\s+0\s+bytes\s*$/m.test(proc('/proc/self/limits'))||!/^SwapTotal:\s+0 kB\s*$/m.test(proc('/proc/meminfo')))throw new Error()
 }catch{throw new Error('SMILES_REBOOT_PROFILE_REFUSED')}
}
