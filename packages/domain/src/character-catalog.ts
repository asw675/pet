/** Pure, versioned character definitions. This catalog is not a pet instance,
 * inventory, asset-license store, or AI provider configuration. */
export const CHARACTER_CATALOG_VERSION = 1 as const;
export const MAX_OWNED_PETS = 100;
export const MAX_INSTANCES_PER_CHARACTER = 1; // V1 product rule, not an instance ID constraint.
export const MAX_CHARACTER_NICKNAME_LENGTH = 80; // UTF-16 units, consistent with petSnapshot.

export interface BattleStats {
  readonly hp: number;
  readonly atk: number;
  readonly def: number;
  readonly spd: number;
  readonly luk: number;
}

export interface CharacterProgressionProfile {
  /** The original travel POC's scalar power, retained for existing starter compatibility. */
  readonly basePower: number;
  readonly baseStats: BattleStats;
  /** Additive growth for each level above the initial Lv.1. */
  readonly growthPerLevel: BattleStats;
}

export type CharacterProfession = 'MAGE' | 'RANGER' | 'MECHANICAL_SUPPORT';

export type CharacterUnlockRequirement =
  | { readonly kind: 'STARTER' }
  | { readonly kind: 'EXPLORATION_COINS'; readonly requiredSettledTrips: number; readonly coinCost: number };

export interface CharacterPersonality {
  readonly summary: string;
  readonly traits: readonly string[];
  readonly likes: readonly string[];
  readonly speechStyle: string;
}

export interface CharacterDefinition extends CharacterProgressionProfile {
  readonly characterId: string;
  readonly displayName: string;
  readonly species: string;
  readonly profession: CharacterProfession;
  readonly professionLabel: string;
  readonly background: string;
  readonly personality: CharacterPersonality;
  /** Stable internal style hint only; no TTS engine, voice asset or external provider ID. */
  readonly voiceStyleId: string;
  readonly adventureFocus: readonly string[];
  readonly unlock: CharacterUnlockRequirement;
}

function immutableCharacter(definition: CharacterDefinition): CharacterDefinition {
  return Object.freeze({
    ...definition,
    baseStats: Object.freeze({ ...definition.baseStats }),
    growthPerLevel: Object.freeze({ ...definition.growthPerLevel }),
    personality: Object.freeze({
      ...definition.personality,
      traits: Object.freeze([...definition.personality.traits]),
      likes: Object.freeze([...definition.personality.likes]),
    }),
    adventureFocus: Object.freeze([...definition.adventureFocus]),
    unlock: Object.freeze({ ...definition.unlock }),
  });
}

/** Project-original humanoid anime heroines. Starter IDs and power are retained
 * across the early save format. Profession strengths differ; no character is
 * intended to outperform every other role on all attributes.
 *
 * All numbers are V1 balance fixtures, centrally configured here. Calculating
 * effective progression/equipment and committing acquisitions remain separate.
 */
export const CHARACTER_CATALOG: readonly CharacterDefinition[] = Object.freeze([
  immutableCharacter({
    characterId: 'star-singer',
    displayName: '星咏',
    species: '魔族',
    profession: 'MAGE',
    professionLabel: '星辉魔法师',
    background: '拥有绯粉长发和异色双瞳的魔族少女，收集星光与旅途中的古老魔法知识。',
    personality: {
      summary: '好奇而细腻，喜欢认真观察新事物，也愿意分享发现。',
      traits: ['好奇', '温柔', '善于推理'],
      likes: ['看星星', '阅读', '寻找遗迹中的故事'],
      speechStyle: '语气温和，偶尔提出充满好奇的问题；不把推测冒充已知事实。',
    },
    voiceStyleId: 'voice.star-singer.gentle-curiosity',
    adventureFocus: ['魔法输出', '探索特殊事件'],
    basePower: 30,
    baseStats: { hp: 75, atk: 22, def: 12, spd: 14, luk: 16 },
    growthPerLevel: { hp: 8, atk: 4, def: 2, spd: 2, luk: 2 },
    unlock: { kind: 'STARTER' },
  }),
  immutableCharacter({
    characterId: 'fluffy-ranger',
    displayName: '绒绒',
    species: '人类',
    profession: 'RANGER',
    professionLabel: '林地游侠',
    background: '栗红长发、身穿森林绿衣的人形少女，擅长在林间寻找安全的小径和有趣的材料。',
    personality: {
      summary: '活泼乐观，热爱旅行，也懂得享受休息和美食。',
      traits: ['活泼', '爽朗', '善于观察'],
      likes: ['森林远足', '美食', '午睡'],
      speechStyle: '表达轻快自然，喜欢分享有趣的小见闻；认真回应用户的实际需求。',
    },
    voiceStyleId: 'voice.fluffy-ranger.bright',
    adventureFocus: ['高速行动', '采集材料', '发现隐藏路线'],
    basePower: 25,
    baseStats: { hp: 84, atk: 18, def: 14, spd: 22, luk: 20 },
    growthPerLevel: { hp: 9, atk: 3, def: 2, spd: 4, luk: 3 },
    unlock: { kind: 'STARTER' },
  }),
  immutableCharacter({
    characterId: 'nova',
    displayName: '诺瓦',
    species: '仿生机械人',
    profession: 'MECHANICAL_SUPPORT',
    professionLabel: '机械助手',
    background: '具有人形少女外观的机械助手，随身维护自己的工具，专注于整理、修理与守护同伴。',
    personality: {
      summary: '理性认真、可靠体贴，乐于把复杂的工作整理成清晰的小步骤。',
      traits: ['理性', '认真', '可靠'],
      likes: ['整理工坊', '研究机械结构', '记录任务进度'],
      speechStyle: '用简洁、清晰的语言提供帮助，保留温柔且自然的人情味。',
    },
    voiceStyleId: 'voice.nova.calm-clear',
    adventureFocus: ['稳定防御', '持续探索', '修理支持'],
    basePower: 28,
    baseStats: { hp: 100, atk: 15, def: 24, spd: 11, luk: 14 },
    growthPerLevel: { hp: 12, atk: 2, def: 4, spd: 1, luk: 2 },
    // Three settled trips and sixteen shared *in-game* coins. The existing
    // meadow battle pays eight on victory, making the gate attainable with
    // ordinary play (two wins among three trips, with additional retries).
    unlock: { kind: 'EXPLORATION_COINS', requiredSettledTrips: 3, coinCost: 16 },
  }),
]);

export const STARTER_CHARACTER_IDS: readonly string[] = Object.freeze(
  CHARACTER_CATALOG.filter(definition => definition.unlock.kind === 'STARTER').map(definition => definition.characterId),
);

export function findCharacterDefinition(characterId: string): CharacterDefinition | undefined {
  return CHARACTER_CATALOG.find(definition => definition.characterId === characterId);
}

export interface CharacterAcquisitionContext {
  /** All existing pet instances, not unique templates. Old/unknown stable IDs
   * still consume a capacity slot. Future rules may allow repeated IDs. */
  readonly ownedCharacterIds: readonly string[];
  readonly settledTrips: number;
  readonly walletCoins: number;
}

export type CharacterAcquisitionDecision =
  | { readonly ok: true; readonly definition: CharacterDefinition; readonly coinCost: number }
  | { readonly ok: false; readonly reason: 'UNKNOWN_CHARACTER' }
  | { readonly ok: false; readonly reason: 'ALREADY_OWNED'; readonly ownedInstances: number; readonly maxInstances: number }
  | { readonly ok: false; readonly reason: 'CAPACITY_REACHED'; readonly ownedPets: number; readonly maxPets: number }
  | { readonly ok: false; readonly reason: 'UNMET_REQUIREMENT'; readonly settledTrips: number; readonly requiredSettledTrips: number }
  | { readonly ok: false; readonly reason: 'INSUFFICIENT_COINS'; readonly walletCoins: number; readonly coinCost: number };

const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function requireAcquisitionContext(context: CharacterAcquisitionContext): void {
  if (context === null || typeof context !== 'object' || !Array.isArray(context.ownedCharacterIds)
    || !Number.isSafeInteger(context.settledTrips) || context.settledTrips < 0
    || !Number.isSafeInteger(context.walletCoins) || context.walletCoins < 0) {
    throw new RangeError('Invalid authoritative character acquisition context');
  }
  for (const id of context.ownedCharacterIds) {
    if (typeof id !== 'string' || !stableId.test(id)) throw new RangeError('Invalid authoritative character acquisition context');
  }
}

/** Pure eligibility check over the authoritative context. Failure precedence
 * intentionally remains stable: unknown, duplicate template, total capacity,
 * exploration requirement, then insufficient shared in-game coins.
 * This never reserves currency or creates a pet; app-service must recompute
 * eligibility within the transaction that debits the wallet and creates one.
 */
export function evaluateCharacterAcquisition(characterId: string, context: CharacterAcquisitionContext): CharacterAcquisitionDecision {
  requireAcquisitionContext(context);
  const definition = findCharacterDefinition(characterId);
  if (definition === undefined) return { ok: false, reason: 'UNKNOWN_CHARACTER' };
  const ownedInstances = context.ownedCharacterIds.filter(id => id === definition.characterId).length;
  if (ownedInstances >= MAX_INSTANCES_PER_CHARACTER) {
    return { ok: false, reason: 'ALREADY_OWNED', ownedInstances, maxInstances: MAX_INSTANCES_PER_CHARACTER };
  }
  if (context.ownedCharacterIds.length >= MAX_OWNED_PETS) {
    return { ok: false, reason: 'CAPACITY_REACHED', ownedPets: context.ownedCharacterIds.length, maxPets: MAX_OWNED_PETS };
  }
  const requirement = definition.unlock;
  if (requirement.kind === 'STARTER') return { ok: true, definition, coinCost: 0 };
  if (context.settledTrips < requirement.requiredSettledTrips) {
    return { ok: false, reason: 'UNMET_REQUIREMENT', settledTrips: context.settledTrips, requiredSettledTrips: requirement.requiredSettledTrips };
  }
  if (context.walletCoins < requirement.coinCost) {
    return { ok: false, reason: 'INSUFFICIENT_COINS', walletCoins: context.walletCoins, coinCost: requirement.coinCost };
  }
  return { ok: true, definition, coinCost: requirement.coinCost };
}

/** Canonical user-visible nickname, independent of stable IDs. NFC accepts
 * ordinary Chinese and other Unicode scripts without changing their meaning;
 * control/format/surrogate characters and line breaks are refused. Rejecting
 * format characters also prevents invisible-only and bidirectional override
 * names; composed emoji without format joiners are accepted.
 */
export function normalizeCharacterNickname(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new RangeError('Invalid character nickname');
  }
  const nickname = value.normalize('NFC').trim();
  if (nickname.length < 1 || nickname.length > MAX_CHARACTER_NICKNAME_LENGTH) {
    throw new RangeError('Character nickname must contain 1–80 UTF-16 units');
  }
  return nickname;
}

export function isValidCharacterNickname(value: unknown): boolean {
  try { normalizeCharacterNickname(value); return true; }
  catch { return false; }
}
