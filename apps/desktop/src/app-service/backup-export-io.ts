import { linkSync, lstatSync, mkdtempSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path';
import type { BackupExportIo, BackupExportStage, SqliteConnection } from '@pet-desktop/app-service';

const samePath = (left:string,right:string):boolean => process.platform==='win32'
  ? normalize(left).toLowerCase()===normalize(right).toLowerCase() : normalize(left)===normalize(right);
const sameFile = (left:Stats,right:Stats):boolean => left.dev===right.dev&&left.ino===right.ino;
function absent(filename:string):boolean { return lstatSync(filename,{throwIfNoEntry:false})===undefined; }
function destinationParent(destination:string):string {
  // This path is supplied only by the trusted Main save-file dialog over
  // its internal channel. Do not accept relative paths, NUL, device/UNC
  // paths, stream syntax, alternate suffixes, or existing empty files.
  if(typeof destination!=='string'||!isAbsolute(destination)||destination.includes('\0')||destination.length>4096
    ||destination.startsWith('\\\\')||destination.startsWith('//')||!samePath(destination,resolve(destination))
    ||extname(destination).toLowerCase()!=='.sqlite3'||/[\u0000-\u001f\u007f:]/u.test(basename(destination))||!absent(destination)){
    throw new Error('Invalid or existing backup destination');
  }
  const parent=dirname(destination),info=lstatSync(parent);
  if(!info.isDirectory()||info.isSymbolicLink()||!samePath(realpathSync.native(parent),parent))throw new Error('Backup destination must use a direct directory');
  return parent;
}

interface StageState {
  directory:string; directoryIdentity:Stats; filename:string; destination:string; parent:string;
  fileIdentity:Stats|undefined; disposed:boolean; published:boolean;
}
function assertStage(state:StageState):void {
  const info=lstatSync(state.directory);
  if(state.disposed||!info.isDirectory()||info.isSymbolicLink()||!sameFile(info,state.directoryIdentity)
    ||!samePath(realpathSync.native(state.directory),state.directory))throw new Error('Backup staging directory changed');
}
function fileIdentity(state:StageState):Stats {
  assertStage(state);
  const info=lstatSync(state.filename);
  if(!info.isFile()||info.isSymbolicLink()||info.size<=0)throw new Error('Invalid backup staging file');
  return info;
}

/** A single app-owned staging copy on the selected destination's volume.
 * VACUUM INTO and verification live in SQLiteRepository; the verified file
 * is published by an exclusive hard link, never an overwrite-prone rename
 * or copy. Unsupported volumes fail safely. No OS operation runs until this
 * trusted port is called with the explicit Main-selected path. */
export function createBackupExportIo(openReadOnly:(filename:string)=>SqliteConnection):BackupExportIo {
  const stages=new Map<string,StageState>();
  return {
    stage(destination:string):BackupExportStage {
      const parent=destinationParent(destination),directory=mkdtempSync(join(parent,'.pet-backup-'));
      const state:StageState={directory,directoryIdentity:lstatSync(directory),filename:join(directory,'payload.sqlite3'),destination,parent,
        fileIdentity:undefined,disposed:false,published:false};
      stages.set(state.filename,state);
      return {
        filename:state.filename,
        publishVerified():void {
          assertStage(state);
          if(state.published||!state.fileIdentity||destinationParent(state.destination)!==state.parent)throw new Error('Backup cannot be published');
          const actual=fileIdentity(state);
          if(!sameFile(actual,state.fileIdentity)||actual.size!==state.fileIdentity.size||actual.mtimeMs!==state.fileIdentity.mtimeMs){
            throw new Error('Verified backup staging file changed');
          }
          // The filesystem enforces absence atomically, including an empty
          // file or a symlink created after our precheck. No fallback copy.
          linkSync(state.filename,state.destination);
          state.published=true;
        },
        dispose():void {
          if(state.disposed)return;
          assertStage(state);
          // Clean only exact files that our private VACUUM/readonly stage
          // may have created. Never recursively delete an unknown directory
          // and never unlink the selected destination after publication.
          for(const suffix of ['', '-wal', '-shm', '-journal']){
            const path=`${state.filename}${suffix}`;
            if(!absent(path))unlinkSync(path);
          }
          rmdirSync(state.directory);
          state.disposed=true;stages.delete(state.filename);
        },
      };
    },
    openReadOnly(filename:string):SqliteConnection {
      const state=stages.get(filename);
      if(!state||state.disposed||state.published||state.fileIdentity)throw new Error('Unknown backup staging verifier');
      const before=fileIdentity(state),connection=openReadOnly(filename);
      try{
        const after=fileIdentity(state);
        if(!sameFile(before,after)||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('Backup staging identity changed');
        state.fileIdentity=after;return connection;
      }catch(error){connection.close();throw error;}
    },
  };
}
