import type { RoutineDraft } from '../shared/workspace-view-policy';

export const starterRoutineTemplates = [
  {
    id: 'work',
    label: '工作',
    examples: '编辑器、项目目录、协作文档',
    name: '开始工作',
    mode: 'SEQUENTIAL',
    delayMs: 500,
    failurePolicy: 'STOP',
  },
  {
    id: 'entertainment',
    label: '娱乐',
    examples: '播放器、游戏、娱乐网站',
    name: '开始娱乐',
    mode: 'PARALLEL',
    delayMs: 0,
    failurePolicy: 'CONTINUE',
  },
  {
    id: 'study',
    label: '学习',
    examples: '笔记、课程网页、资料目录',
    name: '开始学习',
    mode: 'SEQUENTIAL',
    delayMs: 600,
    failurePolicy: 'CONTINUE',
  },
] as const satisfies readonly (Omit<RoutineDraft, 'targetIds'> & { id: string; label: string; examples: string })[];

export type StarterRoutineTemplate = (typeof starterRoutineTemplates)[number];

export function applyStarterRoutineTemplate(template: StarterRoutineTemplate, draft: RoutineDraft): RoutineDraft {
  const { name, mode, delayMs, failurePolicy } = template;
  return { name, mode, delayMs, failurePolicy, targetIds: [...draft.targetIds] };
}
