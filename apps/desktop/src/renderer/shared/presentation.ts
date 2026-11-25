import type { Activity, PetSnapshot } from '@pet-desktop/contracts';
import type { ServiceStatus } from '../../shared/protocol';

const activities: Record<Activity, string> = {
  IDLE: '在家待机', WALK: '散步中', DRAG: '移动中', INTERACT: '开心互动', CHAT: '交谈中',
  EAT: '用餐中', REST: '休息中', SLEEP: '熟睡中', CELEBRATE: '庆祝中',
};

export function petStatus(pet: PetSnapshot): string {
  if (pet.presence === 'RETURNING') return '返程中';
  if (pet.presence === 'AWAY') return '旅行中';
  return pet.activity === null ? '在家' : activities[pet.activity];
}

export function routeName(routeId: string): string {
  switch (routeId) {
    case 'morning-dew-meadow': return '晨露草原';
    case 'mist-forest': return '迷雾森林';
    case 'starfall-ruins': return '星落遗迹';
    default: return routeId;
  }
}

export function formatRemaining(expectedReturnAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expectedReturnAt - now) / 1000));
  if (seconds === 0) return '等待结算';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remaining = seconds % 60;
  return hours > 0 ? `${hours}小时 ${minutes}分` : `${minutes}分 ${String(remaining).padStart(2, '0')}秒`;
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function formatTime(at: number): string {
  return Number.isFinite(new Date(at).getTime()) ? timeFormatter.format(at) : '时间不可用';
}

export function serviceStatusLabel(status: ServiceStatus | null): string {
  switch (status?.stage) {
    case 'STARTING': return '启动中';
    case 'READY': return '服务已连接';
    case 'RESTARTING': return '恢复连接中';
    case 'UNAVAILABLE': return '服务暂不可用';
    case 'STOPPING': return '服务正在停止';
    default: return '连接中';
  }
}
