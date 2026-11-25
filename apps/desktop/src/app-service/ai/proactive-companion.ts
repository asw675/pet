import { createHash, randomUUID } from 'node:crypto';
import type { AppService, AppTransaction } from '@pet-desktop/app-service';
import { ProactiveSettingsConflict } from '@pet-desktop/app-service/ai-proactive-storage';
import type { AppSnapshot, PetSnapshot } from '@pet-desktop/contracts';
import { proactiveLimits } from '@pet-desktop/contracts/proactive';
import type { ProactiveGeneration, ProactiveNotice, ProactiveQuietHours, ProactiveTrigger } from '@pet-desktop/contracts/proactive';
import { proactiveFailure, proactiveResultSchema } from '../../shared/proactive-ipc';
import type { ProactiveNoticeReady, ProactiveRequest, ProactiveResult } from '../../shared/proactive-ipc';
import type { AiControlService } from './ai-control-service';

const phrases: Readonly<Record<string, Record<ProactiveTrigger, string>>> = {
  'star-singer': { RETURNED: '我从旅途中回来了，等有空再一起看看记录吧。', LOW_ENERGY: '今天的星光有点远，我想先歇一会儿。', IDLE: '刚记下了一点星光。你有空的时候，我们再聊聊。' },
  'fluffy-ranger': { RETURNED: '我回来啦！路上的见闻可以慢慢讲给你。', LOW_ENERGY: '有点困啦，让我先找个舒服的地方歇一会儿吧。', IDLE: '嗨！我就在这里，你忙完再来找我也行。' },
  nova: { RETURNED: '行程已结束。回顾已保存在旅行报告中。', LOW_ENERGY: '当前精力偏低，建议留一点休息时间。', IDLE: '例行问候。你有空时可以和我聊聊。' },
};

type Source = { trigger: ProactiveTrigger; sourceKey: string; sourceAt: number };
type GenerationIdentity = { petId: string; requestId: string; conversationId: string };
type GameService = Pick<AppService, 'withFeatureTransaction'>;
type ModelService = Pick<AiControlService, 'startProactive' | 'cancelInternal'>;

function isQuiet(hours: ProactiveQuietHours | null, minute: number): boolean {
  if (!hours) return false;
  const { startMinute: start, endMinute: end } = hours;
  return start < end ? start <= minute && minute < end : start <= minute || minute < end;
}

function eligiblePet(snapshot: AppSnapshot, petId: string): PetSnapshot | undefined {
  if (snapshot.doNotDisturb || snapshot.pausedRender || snapshot.primaryPetId !== petId) return undefined;
  return snapshot.pets.find(pet => pet.petId === petId && pet.visibility === 'VISIBLE' && pet.presence === 'HOME' && pet.activity === 'IDLE');
}

function proactiveConversationId(petId: string): string {
  return 'companion-' + createHash('sha256').update(petId).digest('hex');
}

/** Trusted utility scheduler. The host provides only the actual visible pet,
 * while settings, clocks, events, rate limits, and results stay with SQLite. */
export class ProactiveCompanion {
  private hostPetId: string | null = null;
  private generation: ProactiveNotice | null = null;
  private closed = false;
  constructor(private readonly options: {
    service: GameService;
    model: ModelService;
    publish: (event: ProactiveNoticeReady) => void;
    now?: () => number;
    localMinute?: (at: number) => number;
    createId?: () => string;
  }) {}

  private now(): number { return (this.options.now ?? Date.now)(); }

  private localMinute(at: number): number {
    if (this.options.localMinute) return this.options.localMinute(at);
    const local = new Date(at);
    return local.getHours() * 60 + local.getMinutes();
  }

  private createId(kind: string): string { return `${kind}-${(this.options.createId ?? randomUUID)()}`; }

  recover(): void {
    this.options.service.withFeatureTransaction(tx => tx.proactive().recoverPending(this.now()));
  }

  updateHost(petId: string | null): void {
    if (this.closed) return;
    this.hostPetId = petId;
    const current = this.generation;
    if (current?.generation && !this.isAuthorized({ petId: current.petId, ...current.generation })) this.cancelGeneration();
    if (!petId) return;
    const now = this.now();
    const notice = this.options.service.withFeatureTransaction((tx, getSnapshot) => this.reserve(tx, getSnapshot(), petId, now));
    if (!notice) return;
    if (!notice.generation) {
      this.publish(notice);
      return;
    }
    this.generation = notice;
    const identity = { petId, requestId: notice.generation.requestId, conversationId: notice.generation.conversationId };
    const result = this.options.model.startProactive({ ...identity, trigger: 'PROACTIVE', userText: null }, event => {
      if (event.kind === 'textDelta' || event.requestId !== identity.requestId
        || event.petId !== identity.petId || event.conversationId !== identity.conversationId) return;
      this.settle(notice, event.kind === 'final', event.kind !== 'cancelled');
    });
    if (!result.accepted) this.settle(notice, false, true);
  }

  private reserve(tx: AppTransaction, snapshot: AppSnapshot, petId: string, now: number): ProactiveNotice | null {
    const pet = eligiblePet(snapshot, petId);
    if (!pet || now < (tx.getPreferences()?.logicalTime ?? now)) return null;
    const storage = tx.proactive();
    const settings = storage.getSettings(petId);
    if (!settings.enabled || settings.enabledAt === null || now < settings.enabledAt) return null;

    const low = storage.observeLowEnergy(petId, pet.energy <= proactiveLimits.lowEnergyThreshold, now);
    if (isQuiet(settings.quietHours, this.localMinute(now)) || !storage.canReserve(petId, now)) return null;

    const ai = tx.aiState();
    const lastInteraction = Math.max(tx.getHomeSchedule(petId)?.lastInteractionAt ?? 0, ai.latestUserInteraction(petId) ?? 0);
    if (ai.countPendingTurns() > 0 || (lastInteraction > 0 && now - lastInteraction < proactiveLimits.interactionSilenceMs)) return null;
    const sources: Source[] = [];
    if (pet.trip?.status === 'SETTLED') {
      const settledAt = tx.getSettlement(pet.trip.tripId)?.settledAt;
      if (settledAt !== undefined && settledAt >= settings.enabledAt && settledAt <= now
        && now - settledAt <= proactiveLimits.returnFreshnessMs) {
        sources.push({ trigger: 'RETURNED', sourceKey: `return:${pet.trip.tripId}`, sourceAt: settledAt });
      }
    }
    if (low?.low && low.lowSince !== null) sources.push({ trigger: 'LOW_ENERGY', sourceKey: `low:${low.episode}`, sourceAt: low.lowSince });
    const idleSince = Math.max(lastInteraction, settings.enabledAt);
    if (now - idleSince >= proactiveLimits.idleMs) sources.push({ trigger: 'IDLE', sourceKey: `idle:${idleSince}`, sourceAt: idleSince });
    const source = sources.find(candidate => !storage.hasSource(petId, candidate.trigger, candidate.sourceKey));
    if (!source) return null;

    const config = settings.useLocalAi ? ai.resolveAssignedProvider(petId)?.provider.config : undefined;
    let generation: ProactiveGeneration | null = null;
    if (config && (config.privacyBoundary === 'MOCK' || config.privacyBoundary === 'LOCAL') && config.credentialRef === null) {
      const conversationId = proactiveConversationId(petId);
      if (!ai.getConversation(petId, conversationId)) {
        ai.createConversation({ petId, conversationId, title: '主动陪伴', createdAt: now, updatedAt: now });
      }
      generation = { requestId: this.createId('proactive-turn'), conversationId, kind: config.privacyBoundary === 'MOCK' ? 'MOCK' : 'LOCAL_AI' };
    }
    const text = phrases[pet.characterId]?.[source.trigger] ?? '等你有空，我们聊一会儿吧。';
    return storage.reserve({ ...source, noticeId: this.createId('proactive'), petId, createdAt: now, text, generation });
  }

  isAuthorized(identity: GenerationIdentity): boolean {
    if (this.closed || this.hostPetId !== identity.petId) return false;
    const at = this.now();
    return this.options.service.withFeatureTransaction((tx, snapshot) => {
      if (!eligiblePet(snapshot(), identity.petId)) return false;
      const storage = tx.proactive(), settings = storage.getSettings(identity.petId);
      const config = tx.aiState().resolveAssignedProvider(identity.petId)?.provider.config;
      return config !== undefined && config.privacyBoundary !== 'CLOUD' && config.credentialRef === null
        && settings.updatedAt !== null && at >= settings.updatedAt && !isQuiet(settings.quietHours, this.localMinute(at))
        && storage.isAuthorizedGeneration(identity);
    });
  }

  private cancelGeneration(): void {
    const notice = this.generation;
    if (!notice?.generation) return;
    const { requestId, conversationId } = notice.generation;
    this.options.model.cancelInternal({ petId: notice.petId, requestId, conversationId }, 'SUPERSEDED');
    this.settle(notice, false, false);
  }

  private settle(notice: ProactiveNotice, final: boolean, deliver: boolean): void {
    if (this.generation?.noticeId !== notice.noticeId || !notice.generation) return;
    this.generation = null;
    const now = this.now();
    const identity = { petId: notice.petId, ...notice.generation };
    const usable = final && this.isAuthorized(identity);
    const [current, mayPresent] = this.options.service.withFeatureTransaction((tx, snapshot) => {
      const storage = tx.proactive();
      const settings = storage.getSettings(notice.petId);
      const row = storage.settleGeneration(notice.noticeId, identity, Math.max(notice.createdAt, now), usable);
      return [row, settings.enabled && now >= (settings.updatedAt ?? now)
        && !isQuiet(settings.quietHours, this.localMinute(now)) && eligiblePet(snapshot(), notice.petId) !== undefined] as const;
    });
    if (current?.deliveryStatus === 'READY' && mayPresent && deliver) this.publish(current);
  }

  private publish(notice: ProactiveNotice): void {
    if (!this.closed && this.hostPetId === notice.petId) this.options.publish({ kind: 'notice-ready', notice });
  }

  handle(request: ProactiveRequest): ProactiveResult {
    const intent = request.intent;
    const now = this.now();
    if (this.closed) return proactiveFailure(request);
    try {
      const result = this.options.service.withFeatureTransaction(tx => {
        const petId = intent.payload.petId;
        if (!tx.getPet(petId)) return proactiveFailure(request, 'INVALID_REQUEST');
        const storage = tx.proactive();
        let data;
        switch (intent.method) {
          case 'settings/get': data = storage.getSettings(petId); break;
          case 'settings/set': data = storage.setSettings(intent.payload, now); break;
          case 'notices/list': data = storage.listNotices(petId, intent.payload.offset, intent.payload.limit, intent.payload.filter); break;
          case 'notice/acknowledge':
          case 'notice/dismiss': {
            const { noticeId } = intent.payload;
            const changed = intent.method === 'notice/acknowledge'
              ? storage.acknowledge(petId, noticeId, now) : storage.dismiss(petId, noticeId, now);
            data = { petId, noticeId, changed };
            break;
          }
        }
        return proactiveResultSchema.parse({ requestId: request.requestId, method: intent.method, ok: true, data });
      });
      if (result.ok && result.method === 'settings/set' && this.generation?.petId === result.data.petId && this.generation.generation
        && !this.isAuthorized({ petId: result.data.petId, ...this.generation.generation })) this.cancelGeneration();
      return result;
    } catch (error) {
      return proactiveFailure(request, error instanceof ProactiveSettingsConflict ? 'CONFLICT' : 'UNAVAILABLE');
    }
  }

  close(): void {
    this.closed = true;
    this.hostPetId = null;
    this.generation = null;
  }
}
