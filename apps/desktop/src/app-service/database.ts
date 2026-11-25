import { randomInt, randomUUID } from 'node:crypto';
import { AppService, SQLiteRepository, verifyMigrationBackup } from '@pet-desktop/app-service';
import type { SqliteConnection } from '@pet-desktop/app-service';
import { dirname,join } from 'node:path';
import { AiAuthorityService } from '@pet-desktop/app-service/ai-authority-service';
import { AiControlService } from './ai/ai-control-service';
import { LocalVoiceProviders } from './voice/local-voice-provider';
import { VoiceService } from './voice/voice-service';
import {VoiceSettingsService} from './voice/voice-settings-service';
import { WorkspaceControl } from './workspace/workspace-control';
import { createUtilityFeatureRouter,UtilityCredentialBroker } from './feature-router';
import type { UtilityFeatures } from './feature-router';
import type { FeatureOutput } from '../shared/feature-protocol';
import { HostPreferenceStorageError } from '@pet-desktop/app-service/host-preference-storage';
import { createBackupExportIo } from './backup-export-io';
import type { HostAuthorityRequest, HostAuthorityResult } from '../shared/host-settings-ipc';
import {nativeArtifactPins} from '../shared/native-artifact-pins';

function requireSupportedSQLite(connection: SqliteConnection): string {
  const row = connection.prepare('SELECT sqlite_version() AS version').get();
  const version = row !== null && typeof row === 'object' && 'version' in row ? row.version : undefined;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('Invalid SQLite version');
  const [major, minor, patch] = version.split('.').map(Number);
  if (major === undefined || minor === undefined || patch === undefined
    || ![major, minor, patch].every(Number.isSafeInteger)
    || major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) {
    throw new Error('Unsupported SQLite version');
  }
  return version;
}

/** Probe the actual loaded engine before even opening a user's save. */
export function openPersistentService(databasePath: string, open: (filename: string, readOnly?: boolean) => SqliteConnection,
  features?:{resourcesDirectory:string}): {
  service: AppService; sqliteVersion: string; createFeatures?: (send:(message:FeatureOutput)=>void,fault:()=>void)=>UtilityFeatures;
} {
  const probe = open(':memory:');
  let sqliteVersion: string;
  try {
    sqliteVersion = requireSupportedSQLite(probe);
  } finally {
    probe.close();
  }

  // This is the only persistent connection. SQLiteRepository applies and
  // verifies the pragmas, migrates, and owns the connection after construction.
  const connection = open(databasePath);
  try {
    const repository = new SQLiteRepository(connection, {
      persistent: true,
      beforeMigration: (fromVersion, toVersion) => {
        const backup = `${databasePath}.pre-v${fromVersion}-to-v${toVersion}-${randomUUID()}.sqlite3`;
        verifyMigrationBackup(connection, backup, fromVersion, (filename) => open(filename, true));
      },
    });
    const service = new AppService(repository, {
      now: Date.now,
      createId: (kind) => `${kind}-${randomUUID()}`,
      seed: () => randomInt(1, 0x1_0000_0000),
    });
    if(!features)return{service,sqliteVersion};
    const factory=(send:(message:FeatureOutput)=>void,fault:()=>void):UtilityFeatures=>{
      const authority=new AiAuthorityService({transaction:run=>service.withFeatureTransaction((tx,snapshot)=>run(tx.aiState(),{snapshot,
        recentEvents:petId=>tx.listEvents({petId,filter:'HISTORY',offset:0,limit:12}).events.map(record=>({eventId:record.occurrence.occurrenceId,
          petId,type:'NarrativeEvent',occurredAt:record.resolvedAt??record.occurrence.occurredAt,summary:(record.resultText??record.occurrence.narrative.text).slice(0,512)}))})),
        createId:kind=>`${kind}-${randomUUID()}`});
      authority.recoverPendingTurns(Date.now());
      const broker=new UtilityCredentialBroker(send);
      const ai=new AiControlService({authority,readGameSnapshot:()=>service.getSnapshot(),credentialBroker:broker,sendEvent:event=>send({kind:'chat-event',event})});
      // Artifact digests must be set by a verified release manifest, never by
      // the renderer. Missing binary/hash means explicit provider unavailable.
      const providers=new LocalVoiceProviders({bundledRoot:join(features.resourcesDirectory,'native','voice'),modelsRoot:join(dirname(databasePath),'speech-models'),
        tempRoot:join(dirname(databasePath),'voice-tmp'),integrity:{...(nativeArtifactPins.whisperCliSha256?{whisperCliSha256:nativeArtifactPins.whisperCliSha256}:{}),
          ...(nativeArtifactPins.sapiHelperSha256?{sapiHelperSha256:nativeArtifactPins.sapiHelperSha256}:{})}});
      const voice=new VoiceService({authority:{readConfig:scope=>service.withFeatureTransaction(tx=>tx.voiceProfiles().readConfig(scope)),
        completedAssistantText:job=>service.withFeatureTransaction(tx=>tx.voiceProfiles().completedAssistantText(job))},providers});
      const voiceSettings=new VoiceSettingsService({authority:{get:petId=>service.withFeatureTransaction(tx=>tx.voiceProfiles().get(petId)),
        save:(petId,config,expectedRevision,at,authorization)=>service.withFeatureTransaction(tx=>tx.voiceProfiles().save(petId,config,expectedRevision,at,authorization)),
        reset:(petId,expectedRevision,at)=>service.withFeatureTransaction(tx=>tx.voiceProfiles().reset(petId,expectedRevision,at))},providers,now:Date.now});
      const workspace=new WorkspaceControl({transaction:run=>service.withFeatureTransaction(tx=>run(tx.workspaceState())),now:Date.now,
        utcOffsetMinutes:()=>-new Date().getTimezoneOffset(),createId:kind=>`${kind}-${randomUUID()}`});
      const backupIo = createBackupExportIo(filename => open(filename, true));
      const host = (request: HostAuthorityRequest): HostAuthorityResult => {
        if (request.kind === 'backup') {
          try {
            return { kind: 'backup', result: { ok: true, ...repository.exportBackup(request.destination, backupIo) } };
          } catch {
            return { kind: 'backup', result: { ok: false, code: 'EXPORT_FAILED' } };
          }
        }
        try {
          const stored = service.withFeatureTransaction(tx => {
            const storage = tx.hostPreferences();
            const { hotkeysEnabled, scalePercent, reducedMotion, ...metadata } = storage.getPreferences();
            if (request.kind === 'preferences') return { hotkeysEnabled, scalePercent, reducedMotion, ...metadata };
            const values = request.kind === 'save'
              ? { hotkeysEnabled, scalePercent: request.edit.scalePercent, reducedMotion: request.edit.reducedMotion }
              : { hotkeysEnabled: request.enabled, scalePercent, reducedMotion };
            const at = Math.max(Date.now(), metadata.updatedAt ?? 0);
            return storage.savePreferences(values, request.kind === 'save' ? request.edit.expectedRevision : request.expectedRevision, at);
          });
          const { revision, updatedAt, ...values } = stored;
          return { kind: 'preferences', result: { ok: true, preferences: {
            values, revision, updatedAt: updatedAt === null ? null : new Date(updatedAt).toISOString(),
          } } };
        } catch (error) {
          const code = error instanceof HostPreferenceStorageError && error.code === 'REVISION_CONFLICT'
            ? 'REVISION_CONFLICT' : 'SERVICE_UNAVAILABLE';
          return { kind: 'preferences', result: { ok: false, code } };
        }
      };
      return createUtilityFeatureRouter({ai,voice,voiceSettings,workspace,host,broker,send,fault});
    };
    return { service, sqliteVersion,createFeatures:factory };
  } catch (error) {
    // Includes migration/recovery failures before AppService can take ownership.
    connection.close();
    throw error;
  }
}
