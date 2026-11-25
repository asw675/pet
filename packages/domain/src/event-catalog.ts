import { validateEventCatalog } from '#event-engine';
import type { EventDefinition, PinnedEventAsset } from './event-engine.js';
import { findBuiltinEventCg } from '@pet-desktop/domain/cg-catalog';

/** Original heroine narratives. No provider, script, animation path or
 * remotely generated content; future CG references are explicitly unavailable. */
export const EVENT_CATALOG_VERSION = 2 as const;
const DAY = 86_400_000;
const CHOICE_EXPIRY = DAY;

/** Bind newly authored event versions to one exact CG manifest. Old frozen
 * occurrences retain their future/missing asset states when replayed. */
function eventArt(characterId: string, eventId: string): PinnedEventAsset {
  const entry = findBuiltinEventCg(characterId, eventId, 'default', '1.0.0');
  if (!entry || entry.eventDefId !== eventId) throw new Error('Missing original event CG pin');
  return { state: 'PINNED', characterId, eventDefId: eventId, cgId: entry.cgId, variant: entry.variant,
    assetVersion: entry.assetVersion, assetHash: entry.assetHash };
}

const definitions = [
  {
    eventId: 'star-singer.starlight-notes', version: 1, trigger: 'HOME_DAILY',
    conditions: [{ kind: 'CHARACTER', characterIds: ['star-singer'] }, { kind: 'PRESENCE', presence: 'HOME' }],
    weight: 100, rarity: 'COMMON', cooldownMs: DAY, maxPerPet: 12,
    narrative: {
      title: '星光笔记的空白页', actionId: 'happy',
      text: '星咏在窗边整理旅途笔记。她轻轻合上厚厚的书，询问你是否愿意一起为下一页记录一颗新发现的星星。',
    },
    effects: [{ kind: 'MOOD_DELTA', delta10: 10 }],
    choices: [
      { choiceId: 'share-notes', label: '一起写下星光笔记', resultText: '星咏认真写下你们的想法，将这页书签留作小小的纪念。',
        effects: [{ kind: 'BOND_DELTA', delta10: 15 }, { kind: 'MOOD_DELTA', delta10: 20 }] },
      { choiceId: 'study-herbs', label: '讨论旅行中的植物', resultText: '星咏翻到草原的插图，从收集品中挑出一株便于研究的草药留给你。',
        effects: [{ kind: 'ITEM', itemId: 'herb', quantity: 1 }, { kind: 'BOND_DELTA', delta10: 5 }] },
    ],
    defaultChoiceId: 'share-notes', expiresAfterMs: CHOICE_EXPIRY, asset: null,
  },
  {
    eventId: 'fluffy-ranger.forest-tea', version: 1, trigger: 'AFTER_INTERACTION',
    conditions: [{ kind: 'CHARACTER', characterIds: ['fluffy-ranger'] }, { kind: 'PRESENCE', presence: 'HOME' }],
    weight: 100, rarity: 'COMMON', cooldownMs: DAY, maxPerPet: 10,
    narrative: {
      title: '林地游侠的午后茶会', actionId: 'happy',
      text: '绒绒把一杯热茶放在桌边，兴致勃勃地说起收集来的花草。她希望把今天难得的休息时光分享给你。',
    },
    effects: [],
    choices: [
      { choiceId: 'tea-together', label: '一起慢慢喝茶', resultText: '你们分享轻松的下午，她笑着把杯子换成了珍藏已久的旅行茶具。',
        effects: [{ kind: 'MOOD_DELTA', delta10: 40 }, { kind: 'BOND_DELTA', delta10: 12 }] },
      { choiceId: 'prepare-trail', label: '帮忙整理下次旅行材料', resultText: '绒绒把多出的草药交给你，满意地拍了拍整理好的行囊。',
        effects: [{ kind: 'ITEM', itemId: 'herb', quantity: 2 }, { kind: 'BOND_DELTA', delta10: 5 }] },
    ],
    defaultChoiceId: 'tea-together', expiresAfterMs: CHOICE_EXPIRY, asset: null,
  },
  {
    eventId: 'nova.workshop-inventory', version: 1, trigger: 'HOME_DAILY',
    conditions: [{ kind: 'CHARACTER', characterIds: ['nova'] }, { kind: 'PRESENCE', presence: 'HOME' }],
    weight: 100, rarity: 'COMMON', cooldownMs: DAY, maxPerPet: 10,
    narrative: {
      title: '工坊里的小小清单', actionId: 'happy',
      text: '诺瓦整理着螺丝、工具与材料，认真标注每一个收纳格。她发现两种有趣的整理方案，想听听你的选择。',
    },
    effects: [{ kind: 'BOND_DELTA', delta10: 3 }],
    choices: [
      { choiceId: 'catalog-materials', label: '一起标注材料', resultText: '分类完成后，诺瓦找出一份备用的史莱姆凝胶，把它登记为共享材料。',
        effects: [{ kind: 'ITEM', itemId: 'slime-gel', quantity: 1 }, { kind: 'BOND_DELTA', delta10: 7 }] },
      { choiceId: 'polish-tools', label: '维护常用的机械工具', resultText: '检查十分顺利，她省下了一小笔工坊维护预算，并向你道谢。',
        effects: [{ kind: 'COIN', amount: 2 }, { kind: 'MOOD_DELTA', delta10: 25 }] },
    ],
    defaultChoiceId: 'catalog-materials', expiresAfterMs: CHOICE_EXPIRY, asset: null,
  },
  {
    eventId: 'star-singer.shared-constellation', version: 2, trigger: 'BOND_MILESTONE',
    conditions: [{ kind: 'CHARACTER', characterIds: ['star-singer'] }, { kind: 'PRESENCE', presence: 'HOME' },
      { kind: 'LEVEL_AT_LEAST', level: 2 }, { kind: 'BOND_AT_LEAST', bond10: 200 },
      { kind: 'PREREQUISITE', eventId: 'star-singer.starlight-notes', choiceId: 'share-notes' }],
    weight: 40, rarity: 'RARE', cooldownMs: 0, maxPerPet: 1,
    narrative: {
      title: '只属于两人的星座', actionId: 'happy',
      text: '星咏拿出你们曾一起记录的星光笔记，用一条绯色丝线连起几颗星。那不是书中已有的星座，而是这段旅途留下的记忆。',
    },
    effects: [{ kind: 'MOOD_DELTA', delta10: 20 }, { kind: 'CG_UNLOCK' }],
    choices: [
      { choiceId: 'name-constellation', label: '给这颗新星座命名', resultText: '星咏郑重地写下一行新名字。她说，这是一个值得永远记住的约定。',
        effects: [{ kind: 'BOND_DELTA', delta10: 30 }] },
      { choiceId: 'keep-the-memory', label: '将星图留作旅行纪念', resultText: '她小心地把手绘星图收进笔记中，并送上一点旅行纪念材料。',
        effects: [{ kind: 'BOND_DELTA', delta10: 10 }, { kind: 'ITEM', itemId: 'herb', quantity: 2 }] },
    ],
    defaultChoiceId: 'keep-the-memory', expiresAfterMs: CHOICE_EXPIRY,
    asset: eventArt('star-singer', 'star-singer.shared-constellation'),
  },
  {
    eventId: 'fluffy-ranger.meadow-homecoming', version: 2, trigger: 'TRIP_RETURNED',
    conditions: [{ kind: 'CHARACTER', characterIds: ['fluffy-ranger'] }, { kind: 'PRESENCE', presence: 'HOME' },
      { kind: 'ROUTE', routeIds: ['morning-dew-meadow'] }],
    weight: 80, rarity: 'COMMON', cooldownMs: DAY, maxPerPet: 10,
    narrative: {
      title: '归家后的草原故事', actionId: 'return',
      text: '绒绒已经回到家中，兴奋地讲述晨露草原的风景。她从自己的纪念品里挑出一份小礼物，等你一起决定如何纪念这次归来。',
    },
    effects: [{ kind: 'CG_UNLOCK' }],
    choices: [
      { choiceId: 'listen-to-story', label: '听她讲完整的故事', resultText: '绒绒绘声绘色地讲完了见闻，快乐地在旅行日历上标出今天。',
        effects: [{ kind: 'BOND_DELTA', delta10: 15 }, { kind: 'MOOD_DELTA', delta10: 30 }] },
      { choiceId: 'save-keepsake', label: '收下一份纪念材料', resultText: '她欣然交给你一株另行收藏的草药。已结束的旅行结算保持原样。',
        effects: [{ kind: 'ITEM', itemId: 'herb', quantity: 1 }, { kind: 'MOOD_DELTA', delta10: 10 }] },
    ],
    defaultChoiceId: 'listen-to-story', expiresAfterMs: CHOICE_EXPIRY,
    asset: eventArt('fluffy-ranger', 'fluffy-ranger.meadow-homecoming'),
  },
  {
    eventId: 'nova.field-calibration', version: 1, trigger: 'TRIP_RETURNED',
    conditions: [{ kind: 'CHARACTER', characterIds: ['nova'] }, { kind: 'PRESENCE', presence: 'HOME' },
      { kind: 'ROUTE', routeIds: ['morning-dew-meadow'] }],
    weight: 80, rarity: 'COMMON', cooldownMs: DAY, maxPerPet: 8,
    narrative: {
      title: '归家后的例行校准', actionId: 'happy',
      text: '诺瓦从草原归来后例行检查了工具。她把备用零件归回材料箱，并将精心整理的小小收获留给你。',
    },
    effects: [{ kind: 'ITEM', itemId: 'slime-gel', quantity: 1 }, { kind: 'MOOD_DELTA', delta10: 15 }],
    choices: [], defaultChoiceId: null, expiresAfterMs: null, asset: null,
  },
] satisfies readonly EventDefinition[];

export const EVENT_CATALOG: readonly EventDefinition[] = validateEventCatalog(definitions);
