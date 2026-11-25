import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const stage=fileURLToPath(new URL('../native/publish/win-x64/',import.meta.url));
const files=Object.freeze({whisperCliSha256:'voice/whisper-cli.exe',sapiHelperSha256:'voice/pet-desktop-sapi.exe',launchInspectorSha256:'launch-inspect/launch-inspect.exe'});
/** Build-time only. Pin actual final (signed if applicable) binary bytes into
 * the compiled Main/utility bundle, not a runtime mutable adjacent manifest. */
export function computeNativeArtifactPins(requireAll=false){
  const result={};
  for(const [key,relative] of Object.entries(files)){
    const target=join(stage,relative);
    let stat;
    try{stat=lstatSync(target);}catch(error){if(error?.code==='ENOENT'&&!requireAll){result[key]=null;continue;}throw new Error(`Missing required staged native artifact: ${relative}`);}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1024||stat.size>256*1024*1024||realpathSync(target)!==resolve(target))throw new Error(`Invalid staged native artifact: ${relative}`);
    const fd=openSync(target,'r');const hash=createHash('sha256');const buffer=Buffer.alloc(1024*1024);let total=0;
    try{for(;;){const count=readSync(fd,buffer,0,buffer.length,null);if(!count)break;total+=count;if(total>stat.size)throw new Error('Artifact changed during hashing');hash.update(buffer.subarray(0,count));}}
    finally{closeSync(fd);}
    const after=lstatSync(target);if(total!==stat.size||after.size!==stat.size||after.ino!==stat.ino||after.mtimeMs!==stat.mtimeMs)throw new Error(`Artifact changed: ${relative}`);
    result[key]=hash.digest('hex');
  }
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3||process.argv[2]!=='--require-all')throw new Error('Usage: native-artifact-pins.mjs --require-all');
  console.log('Verified staged native artifact SHA-256:',computeNativeArtifactPins(true));
}
