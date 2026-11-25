import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import type { AppSnapshot, DomainCommand, IpcErrorCode } from '@pet-desktop/contracts';
import type { DesktopBridge, ServiceStatus } from '../../shared/protocol';

export type CommandIntent = {
  [Type in DomainCommand['type']]: Pick<Extract<DomainCommand, { type: Type }>, 'type' | 'payload'>;
}[DomainCommand['type']];

const errorMessages: Record<IpcErrorCode, string> = {
  INVALID_REQUEST: '此请求不被支持，请刷新后重试。',
  FORBIDDEN: '当前窗口没有执行此操作的权限。',
  NOT_FOUND: '目标已不存在，请刷新状态。',
  REVISION_CONFLICT: '游戏状态刚刚发生变化，正在刷新。请确认新状态后再操作。',
  COMMAND_CONFLICT: '命令发生冲突，请刷新状态。',
  BUSINESS_RULE: '当前宠物状态不允许此操作，请查看宠物状态后再试。',
  SERVICE_UNAVAILABLE: '本地游戏服务暂时不可用，请稍后刷新。',
  TIMEOUT: '尚未确认操作结果，请刷新状态后再决定是否重新操作。',
  INTERNAL_ERROR: '本地游戏服务处理失败，请稍后刷新。',
};

/** Per-window projection. The bridge remains outside Pinia's serializable state. */
export const useAppStore = defineStore('app-projection', () => {
  const snapshot = shallowRef<AppSnapshot | null>(null);
  const serviceStatus = shallowRef<ServiceStatus | null>(null);
  const pendingCommandId = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const liveSnapshot = ref(false);
  const ready = computed(() => serviceStatus.value?.stage === 'READY' && liveSnapshot.value);
  const busy = computed(() => pendingCommandId.value !== null);

  let bridge: DesktopBridge | undefined;
  let unsubscribers: Array<() => void> = [];
  let connection = 0;
  let epoch = 0;
  let statusRequests = 0;
  let statusPushes = 0;
  let snapshotRequests = 0;
  let acceptedGeneration: number | null = null;

  function clearFeedback(): void {
    error.value = null;
    notice.value = null;
  }

  function isCurrent(operationEpoch: number): boolean {
    return epoch === operationEpoch && serviceStatus.value?.stage === 'READY';
  }

  function acceptSnapshot(incoming: AppSnapshot): boolean {
    const status = serviceStatus.value;
    if (status?.stage !== 'READY') return false;
    // Revision order is scoped to one service generation. A fresh generation
    // legitimately starts at the same or a lower revision after recovery.
    if (acceptedGeneration === status.generation && snapshot.value !== null) {
      if (incoming.revision < snapshot.value.revision) return false;
      if (incoming.revision === snapshot.value.revision && liveSnapshot.value) return true;
    }
    snapshot.value = incoming;
    acceptedGeneration = status.generation;
    liveSnapshot.value = true;
    return true;
  }

  async function fetchSnapshot(): Promise<void> {
    const currentBridge = bridge;
    const operationEpoch = epoch;
    if (!currentBridge || !isCurrent(operationEpoch)) return;
    const request = ++snapshotRequests;
    loading.value = true;
    try {
      const result = await currentBridge.getSnapshot();
      if (!isCurrent(operationEpoch) || request !== snapshotRequests) return;
      if (result.ok) {
        acceptSnapshot(result.snapshot);
      } else {
        liveSnapshot.value = false;
        error.value = errorMessages[result.error.code];
      }
    } catch {
      if (isCurrent(operationEpoch) && request === snapshotRequests) {
        liveSnapshot.value = false;
        error.value = '无法读取宠物状态，请刷新。';
      }
    } finally {
      if (isCurrent(operationEpoch) && request === snapshotRequests) loading.value = false;
    }
  }

  function observeStatus(status: ServiceStatus, fetchOnReady: boolean): void {
    const previous = serviceStatus.value;
    if (previous && status.generation < previous.generation) return;
    if (previous?.generation === status.generation && previous.stage === status.stage) return;

    // Invalidate requests before replacing readiness, not after their replies.
    // Keep the last projection for display while restarting, but don't permit
    // commands until a fresh snapshot in the now-ready epoch is accepted.
    epoch += 1;
    liveSnapshot.value = false;
    pendingCommandId.value = null;
    loading.value = false;
    clearFeedback();
    serviceStatus.value = status;
    if (status.stage === 'READY' && fetchOnReady) void fetchSnapshot();
  }

  async function refresh(): Promise<void> {
    const currentBridge = bridge;
    if (!currentBridge) {
      error.value = '未连接桌宠宿主。请从桌宠应用中打开此页面。';
      return;
    }
    const requestConnection = connection;
    const request = ++statusRequests;
    const pushesAtStart = statusPushes;
    clearFeedback();
    loading.value = true;
    try {
      const status = await currentBridge.getServiceStatus();
      if (connection !== requestConnection || request !== statusRequests) return;
      // A pushed status is newer than a status query already in flight.
      if (pushesAtStart === statusPushes) observeStatus(status, false);
      if (serviceStatus.value?.stage === 'READY') await fetchSnapshot();
      else loading.value = false;
    } catch {
      if (connection === requestConnection && request === statusRequests) {
        liveSnapshot.value = false;
        error.value = '无法查询本地服务状态，请稍后刷新。';
        loading.value = false;
      }
    }
  }

  function disconnect(): void {
    // Old subscription callbacks and dispatched promises cannot affect a new
    // connection, even if a transport delivers a late reply during teardown.
    connection += 1;
    epoch += 1;
    bridge = undefined;
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers = [];
    acceptedGeneration = null;
    snapshot.value = null;
    serviceStatus.value = null;
    liveSnapshot.value = false;
    pendingCommandId.value = null;
    loading.value = false;
    clearFeedback();
  }

  function connect(nextBridge?: DesktopBridge): void {
    disconnect();
    bridge = nextBridge;
    if (!nextBridge) {
      error.value = '未连接桌宠宿主。请从桌宠应用中打开此页面。';
      return;
    }
    const subscriptionConnection = connection;
    // Subscribe before the first read so no update is missed in between.
    // Host events emit READY for a generation before its snapshots.
    unsubscribers.push(nextBridge.subscribeSnapshot((incoming) => {
      if (connection === subscriptionConnection) acceptSnapshot(incoming);
    }));
    unsubscribers.push(nextBridge.subscribeServiceStatus((status) => {
      if (connection !== subscriptionConnection) return;
      statusPushes += 1;
      observeStatus(status, true);
    }));
    void refresh();
  }

  async function dispatch(intent: CommandIntent, successMessage = '操作已确认。'): Promise<boolean> {
    const currentBridge = bridge;
    const currentSnapshot = snapshot.value;
    if (!currentBridge || !currentSnapshot || !ready.value || busy.value || loading.value) return false;
    clearFeedback();
    const operationEpoch = epoch;
    // Each user gesture owns its own globally distinct business command ID;
    // transport request IDs are generated independently inside preload.
    const commandId = globalThis.crypto.randomUUID();
    pendingCommandId.value = commandId;
    const command: DomainCommand = {
      ...intent, commandId, issuedAt: Date.now(), expectedRevision: currentSnapshot.revision,
    };
    try {
      const result = await currentBridge.dispatch(command);
      if (!isCurrent(operationEpoch) || pendingCommandId.value !== commandId) return false;
      if (result.ok) {
        acceptSnapshot(result.snapshot);
        notice.value = successMessage;
        return true;
      }
      error.value = errorMessages[result.error.code];
      if (result.error.code === 'SERVICE_UNAVAILABLE' || result.error.code === 'TIMEOUT') liveSnapshot.value = false;
      if (result.error.code === 'REVISION_CONFLICT') await fetchSnapshot();
      return false;
    } catch {
      if (isCurrent(operationEpoch) && pendingCommandId.value === commandId) {
        liveSnapshot.value = false;
        error.value = '操作结果未确认，请刷新宠物状态。';
      }
      return false;
    } finally {
      if (isCurrent(operationEpoch) && pendingCommandId.value === commandId) pendingCommandId.value = null;
    }
  }

  return {
    snapshot, serviceStatus, pendingCommandId, loading, busy, ready, liveSnapshot, error, notice,
    connect, disconnect, refresh, dispatch, clearFeedback,
  };
});
