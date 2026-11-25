import { mkdtempSync, realpathSync, rmSync, mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SQLiteRepository, SCHEMA_VERSION } from '@pet-desktop/app-service';
import { createBackupExportIo } from '../src/app-service/backup-export-io.ts';

const openReadOnly=filename=>new DatabaseSync(filename,{readOnly:true});
const settings={hotkeysEnabled:false,scalePercent:150,reducedMotion:true};
function fixture(action){
  // realpath prevents the platform's tmpdir alias from itself being a
  // symlink; the selected test folder is a real, private directory.
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),'pet-export-test-'))),source=join(root,'source.sqlite3');
  const db=new DatabaseSync(source),repo=new SQLiteRepository(db,{persistent:true});
  repo.transaction(tx=>{tx.setWalletCoins(42);tx.hostPreferences().savePreferences(settings,0,1000);});
  try{return action({root,source,db,repo,io:createBackupExportIo(openReadOnly)});}
  finally{repo.close();rmSync(root,{recursive:true,force:true});}
}
function noStage(root){expect(readdirSync(root).filter(name=>name.startsWith('.pet-backup-'))).toEqual([]);}

describe('trusted native backup export on real SQLite WAL and local filesystem',()=>{
  it('publishes a verified current-schema committed WAL snapshot and never copies raw live DB bytes directly',()=>fixture(({root,repo,io,db})=>{
    const destination=join(root,'用户备份.sqlite3');
    expect(repo.exportBackup(destination,io)).toEqual({schemaVersion:SCHEMA_VERSION});noStage(root);
    const backup=openReadOnly(destination);
    try{
      expect(backup.prepare('PRAGMA user_version').get().user_version).toBe(SCHEMA_VERSION);
      expect(backup.prepare('PRAGMA integrity_check').all()).toEqual([{integrity_check:'ok'}]);
      expect(backup.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(backup.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all()).toEqual(db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all());
      expect(backup.prepare('SELECT balance FROM wallet').get().balance).toBe(42);
      expect(backup.prepare('SELECT scale_percent,hotkeys_enabled,reduced_motion FROM host_preferences').get()).toEqual({scale_percent:150,hotkeys_enabled:0,reduced_motion:1});
      repo.transaction(tx=>{tx.setWalletCoins(7);tx.hostPreferences().savePreferences({...settings,scalePercent:75},1,1001);});
      expect(backup.prepare('SELECT balance FROM wallet').get().balance).toBe(42);
      expect(backup.prepare('SELECT scale_percent FROM host_preferences').get().scale_percent).toBe(150);
    }finally{backup.close();}
  }));

  it('rejects existing files including empty file and source, never overwriting any bytes',()=>fixture(({root,source,repo,io})=>{
    const empty=join(root,'empty.sqlite3'),existing=join(root,'other.sqlite3');
    writeFileSync(empty,'');writeFileSync(existing,'synthetic prior file');
    for(const destination of [empty,existing,source,'relative.sqlite3',join(root,'wrong.txt')])expect(()=>repo.exportBackup(destination,io)).toThrow();
    expect(readFileSync(empty).length).toBe(0);expect(readFileSync(existing,'utf8')).toBe('synthetic prior file');
    expect(repo.transaction(tx=>tx.getWalletCoins())).toBe(42);noStage(root);
  }));

  it('does not write via destination symlink or symlinked parent directory',()=>fixture(({root,repo,io})=>{
    const actual=join(root,'real-directory'),alias=join(root,'alias'),target=join(root,'real.sqlite3'),link=join(root,'symlink.sqlite3');
    mkdirSync(actual);writeFileSync(target,'private existing test marker');
    // Directory junctions are available on Windows without elevated symlink
    // privileges. A regular file symlink may still require developer mode.
    try{symlinkSync(actual,alias,process.platform==='win32'?'junction':'dir');}catch(error){if(process.platform!=='win32')throw error;return;}
    expect(()=>repo.exportBackup(join(alias,'alias-write.sqlite3'),io)).toThrow();
    expect(existsSync(join(actual,'alias-write.sqlite3'))).toBe(false);
    try{symlinkSync(target,link,'file');expect(()=>repo.exportBackup(link,io)).toThrow();}catch(error){if(process.platform!=='win32')throw error;}
    expect(readFileSync(target,'utf8')).toBe('private existing test marker');noStage(root);
  }));

  it('rejects publication if a destination appears after staging, retaining the newly created file and cleaning only its own stage',()=>fixture(({root,repo})=>{
    const destination=join(root,'race.sqlite3');
    const racing=createBackupExportIo(filename=>{writeFileSync(destination,'appeared concurrently',{flag:'wx'});return openReadOnly(filename);});
    expect(()=>repo.exportBackup(destination,racing)).toThrow();
    expect(readFileSync(destination,'utf8')).toBe('appeared concurrently');
    expect(repo.transaction(tx=>tx.getWalletCoins())).toBe(42);noStage(root);
  }));

  it('never publishes before verification, closes failed read-only verifier, and remains usable after cleanup',()=>fixture(({root,repo})=>{
    const destination=join(root,'invalid.sqlite3');let closed=false;
    const invalid=createBackupExportIo(filename=>{
      const actual=openReadOnly(filename);
      return {prepare(sql){if(sql==='PRAGMA integrity_check')return {all:()=>[{integrity_check:'not ok'}]};return actual.prepare(sql);},
        exec:sql=>actual.exec(sql),close(){closed=true;actual.close();}};
    });
    expect(()=>repo.exportBackup(destination,invalid)).toThrow(/integrity verification failed/);
    expect(closed).toBe(true);expect(existsSync(destination)).toBe(false);noStage(root);
    expect(repo.transaction(tx=>tx.getWalletCoins())).toBe(42);
  }));

  it('reports success after publishing even if staging cleanup fails',()=>fixture(({root,repo,io})=>{
    const destination = join(root,'published.sqlite3');
    const cleanupFailure = {
      ...io,
      stage(path) {
        const stage = io.stage(path);
        return { ...stage, dispose() { stage.dispose(); throw new Error('synthetic cleanup failure'); } };
      },
    };
    expect(repo.exportBackup(destination, cleanupFailure)).toEqual({schemaVersion:SCHEMA_VERSION});
    expect(existsSync(destination)).toBe(true);
    expect(repo.transaction(tx=>tx.getWalletCoins())).toBe(42);
  }));

  it('checks both source and exported migration history, and refuses any nested transaction export',()=>fixture(({root,repo,db,io})=>{
    const destination=join(root,'history.sqlite3');
    expect(()=>repo.transaction(()=>repo.exportBackup(destination,io))).toThrow(/idle repository/);
    expect(existsSync(destination)).toBe(false);
    const corrupted=createBackupExportIo(filename=>{
      const actual=openReadOnly(filename);
      return {prepare(sql){const statement=actual.prepare(sql);if(sql==='SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')return {all:()=>statement.all().map(row=>({...row,checksum:'invalid'}))};return statement;},
        exec:sql=>actual.exec(sql),close:()=>actual.close()};
    });
    expect(()=>repo.exportBackup(destination,corrupted)).toThrow(/checksum mismatch/);expect(existsSync(destination)).toBe(false);noStage(root);
    const prior=db.prepare('SELECT checksum FROM schema_migrations WHERE version=1').get().checksum;
    db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=1').run('invalid');
    expect(()=>repo.exportBackup(destination,io)).toThrow(/checksum mismatch/);
    db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=1').run(prior);
    expect(repo.transaction(tx=>tx.getWalletCoins())).toBe(42);expect(existsSync(destination)).toBe(false);noStage(root);
  }));
});
