let mockLimits='Max core file size        0                    0                    bytes\n'
let mockMemory='SwapTotal:             0 kB\n'
const mockHandles=new Map<number,{data:Buffer;offset:number}>();let mockSerial=0
const mockClose=jest.fn((fd:number)=>mockHandles.delete(fd))
const mockOpen=jest.fn((path:string,flags:number)=>{expect(flags&jest.requireActual('fs').constants.O_NOFOLLOW).not.toBe(0);expect(flags&jest.requireActual('fs').constants.O_NONBLOCK).not.toBe(0);const fd=++mockSerial;mockHandles.set(fd,{data:Buffer.from(path==='/proc/self/limits'?mockLimits:mockMemory),offset:0});return fd})
jest.mock('fs',()=>({constants:jest.requireActual('fs').constants,openSync:(...args:unknown[])=>mockOpen(...args as [string,number]),closeSync:(fd:number)=>mockClose(fd),fstatSync:()=>({isFile:()=>true}),readSync:(fd:number,buffer:Buffer,offset:number,count:number)=>{const item=mockHandles.get(fd)!;const n=Math.min(count,item.data.length-item.offset);item.data.copy(buffer,offset,item.offset,item.offset+n);item.offset+=n;return n}}))
import {sourceRuntimeReady} from '../../src/server-setup/smiles-reboot-runtime'
describe('source ECS secret RAM admission',()=>{
 const platform=Object.getOwnPropertyDescriptor(process,'platform')!
 beforeEach(()=>{mockLimits='Max core file size        0                    0                    bytes\n';mockMemory='SwapTotal:             0 kB\n';mockOpen.mockClear();mockClose.mockClear();mockHandles.clear();Object.defineProperty(process,'platform',{value:'linux',configurable:true})})
 afterEach(()=>Object.defineProperty(process,'platform',platform))
 test('zero core and swap accepted, FDs closed',()=>{sourceRuntimeReady();expect(mockOpen.mock.calls.map(call=>call[0])).toEqual(['/proc/self/limits','/proc/meminfo']);expect(mockHandles.size).toBe(0);expect(mockClose).toHaveBeenCalledTimes(2)})
 test.each(['Max core file size 0 unlimited bytes\n','Max core file size 1 1 bytes\n','PRIVATE_UNKNOWN'])('unknown or nonzero limit refused',value=>{mockLimits=value;expect(()=>sourceRuntimeReady()).toThrow('SMILES_REBOOT_PROFILE_REFUSED');expect(mockHandles.size).toBe(0)})
 test('active swap refused without echo',()=>{mockMemory='SwapTotal: 1024 kB\nPRIVATE';expect(()=>sourceRuntimeReady()).toThrow('SMILES_REBOOT_PROFILE_REFUSED');expect(mockHandles.size).toBe(0)})
 test('bounded proc metadata refused rather than truncated accepted',()=>{mockMemory='SwapTotal: 0 kB\n'+'x'.repeat(65537);expect(()=>sourceRuntimeReady()).toThrow();expect(mockHandles.size).toBe(0)})
 test('unknown platform refuses without opening proc',()=>{Object.defineProperty(process,'platform',{value:'darwin',configurable:true});expect(()=>sourceRuntimeReady()).toThrow();expect(mockOpen).not.toHaveBeenCalled()})
})
