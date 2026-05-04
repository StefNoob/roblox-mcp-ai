import { v4 as uuidv4 } from 'uuid';
import type { ChatMessage } from './agents/types.js';
export type { ChatMessage } from './agents/types.js';
import type { WsPluginServer } from './ws-plugin-server.js';
import { unifiedChatBridge } from './agentic/unified-chat-bridge.js';

interface PendingRequest {
  id: string;
  endpoint: string;
  data: any;
  targetSessionId?: string;
  leased: boolean;
  leasedSessionId?: string;
  timestamp: number;
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export interface TaskUpdate {
	taskId: string;
	status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
	progress: number;
	agentId?: string;
	message?: string;
	result?: unknown;
	error?: string;
}

export interface DirectCommandDef {
	name: string;
	description: string;
	endpoint: string;
	params?: Record<string, unknown>;
}

export interface AgentThread {
  threadId: string;
  agentId: string;
  status: 'active' | 'paused' | 'stopped';
  messages: ChatMessage[];
  tokensIn: number;
  tokensOut: number;
  createdAt: number;
  lastActivityAt: number;
}

export interface AgentStatus {
  agentId: string;
  threadId: string;
  status: 'active' | 'paused' | 'stopped';
  tokensIn: number;
  tokensOut: number;
  avgLatencyMs: number;
  requestCount: number;
  lastActivityAt: number;
  threadCount: number;
}

export interface AgentMetrics {
  tokensInTotal: number;
  tokensOutTotal: number;
  requestsTotal: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p99LatencyMs: number;
  laneStats: Array<{
    lane: string;
    inFlight: number;
    pending: number;
    completed: number;
  }>;
}

export interface StudioSessionInfo {
  sessionId: string;
  lastSeenAt: number;
  ready: boolean;
  version?: string | null;
  capabilities?: Record<string, boolean>;
  serverUrl?: string | null;
  placeId?: number | null;
  placeName?: string | null;
}

export interface PluginClient {
  clientId: string;
  sessionId: string;
  agentId?: string;
  connectedAt: number;
  lastActivityAt: number;
  capabilities: Record<string, boolean>;
  subscribedThreads: Set<string>;
}

type SendRequestOptions = {
  sessionId?: string;
};

export class BridgeService {
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private studioSessions: Map<string, StudioSessionInfo> = new Map();
  private agentThreads: Map<string, AgentThread> = new Map();
  private pluginClients: Map<string, PluginClient> = new Map();
  private requestTimeout = 30000; // 30 seconds timeout
  private totalRequests = 0;
  private totalResolved = 0;
  private totalRejected = 0;
  private totalTimeouts = 0;
  private totalLatencyMs = 0;
  private latencySamples: number[] = [];
  private maxLatencySamples = 500;
  private endpointStats: Map<string, { total: number; resolved: number; rejected: number; totalLatencyMs: number }> = new Map();
  private agentRequestCount: Map<string, number> = new Map();
  private agentLatencySamples: Map<string, number[]> = new Map();
  private wsServer: WsPluginServer | null = null;

  upsertPluginClient(clientId: string, info: Partial<PluginClient> & { sessionId: string }): PluginClient {
    const existing = this.pluginClients.get(clientId);
    const merged: PluginClient = {
      clientId,
      sessionId: info.sessionId,
      agentId: info.agentId ?? existing?.agentId ?? undefined,
      connectedAt: info.connectedAt ?? existing?.connectedAt ?? Date.now(),
      lastActivityAt: info.lastActivityAt ?? Date.now(),
      capabilities: info.capabilities ?? existing?.capabilities ?? {},
      subscribedThreads: info.subscribedThreads ?? existing?.subscribedThreads ?? new Set(),
    };
    this.pluginClients.set(clientId, merged);
    return merged;
  }

  removePluginClient(clientId: string): void {
    this.pluginClients.delete(clientId);
  }

  getPluginClient(clientId: string): PluginClient | undefined {
    return this.pluginClients.get(clientId);
  }

  getPluginClientsBySession(sessionId: string): PluginClient[] {
    return [...this.pluginClients.values()].filter(c => c.sessionId === sessionId);
  }

  getAllPluginClients(): PluginClient[] {
    return [...this.pluginClients.values()];
  }

  updatePluginClientActivity(clientId: string): void {
    const client = this.pluginClients.get(clientId);
    if (client) {
      client.lastActivityAt = Date.now();
    }
  }

  subscribePluginClientToThread(clientId: string, threadId: string): boolean {
    const client = this.pluginClients.get(clientId);
    if (!client) return false;
    client.subscribedThreads.add(threadId);
    return true;
  }

  unsubscribePluginClientFromThread(clientId: string, threadId: string): boolean {
    const client = this.pluginClients.get(clientId);
    if (!client) return false;
    client.subscribedThreads.delete(threadId);
    return true;
  }

  getPluginClientSubscribedThreads(clientId: string): string[] {
    const client = this.pluginClients.get(clientId);
    return client ? Array.from(client.subscribedThreads) : [];
  }

  async sendRequest(endpoint: string, data: any, options?: SendRequestOptions): Promise<any> {
    const requestId = uuidv4();
    const targetSessionId = options?.sessionId;
    this.totalRequests += 1;
    const endpointStat = this.endpointStats.get(endpoint) || { total: 0, resolved: 0, rejected: 0, totalLatencyMs: 0 };
    endpointStat.total += 1;
    this.endpointStats.set(endpoint, endpointStat);

    return new Promise((resolve, reject) => {
      // Set timeout and store the ID so we can clear it later
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.totalRejected += 1;
          this.totalTimeouts += 1;
          this.pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, this.requestTimeout);

      const request: PendingRequest = {
        id: requestId,
        endpoint,
        data,
        targetSessionId,
        leased: false,
        timestamp: Date.now(),
        resolve,
        reject,
        timeoutId
      };

      this.pendingRequests.set(requestId, request);
    });
  }

  getPendingRequest(sessionId?: string): { requestId: string; request: { endpoint: string; data: any; targetSessionId?: string } } | null {
    // Get oldest pending request
    const chooseOldest = (predicate: (request: PendingRequest) => boolean): PendingRequest | null => {
      let oldest: PendingRequest | null = null;
      for (const request of this.pendingRequests.values()) {
        if (request.leased || !predicate(request)) {
          continue;
        }
        if (!oldest || request.timestamp < oldest.timestamp) {
          oldest = request;
        }
      }
      return oldest;
    };

    let oldestRequest: PendingRequest | null;
    if (sessionId) {
      oldestRequest = chooseOldest((request) => request.targetSessionId === sessionId)
        || chooseOldest((request) => !request.targetSessionId);
    } else {
      oldestRequest = chooseOldest((request) => !request.targetSessionId) || chooseOldest(() => true);
    }

    if (oldestRequest) {
      oldestRequest.leased = true;
      oldestRequest.leasedSessionId = sessionId;
      return {
        requestId: oldestRequest.id,
        request: {
          endpoint: oldestRequest.endpoint,
          data: oldestRequest.data,
          targetSessionId: oldestRequest.targetSessionId
        }
      };
    }

    return null;
  }

  validateResponseSession(requestId: string, sessionId?: string): { ok: true } | { ok: false; reason: string } {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      return { ok: false, reason: `Unknown request: ${requestId}` };
    }
    if (!request.leased) {
      return { ok: false, reason: `Request ${requestId} was not leased to a studio session.` };
    }
    if (!request.leasedSessionId) {
      return { ok: true };
    }
    if (!sessionId) {
      return { ok: false, reason: `Response for request ${requestId} is missing sessionId.` };
    }
    if (request.leasedSessionId !== sessionId) {
      return {
        ok: false,
        reason: `Response session mismatch for request ${requestId}: expected ${request.leasedSessionId}, received ${sessionId}.`,
      };
    }
    return { ok: true };
  }

  resolveRequest(requestId: string, response: any) {
    const request = this.pendingRequests.get(requestId);
    if (request) {
      const latency = Date.now() - request.timestamp;
      clearTimeout(request.timeoutId);
      this.pendingRequests.delete(requestId);
      this.totalResolved += 1;
      this.totalLatencyMs += latency;
      this.latencySamples.push(latency);
      if (this.latencySamples.length > this.maxLatencySamples) {
        this.latencySamples.shift();
      }
      const endpointStat = this.endpointStats.get(request.endpoint);
      if (endpointStat) {
        endpointStat.resolved += 1;
        endpointStat.totalLatencyMs += latency;
      }
      request.resolve(response);
    }
  }

  rejectRequest(requestId: string, error: any) {
    const request = this.pendingRequests.get(requestId);
    if (request) {
      clearTimeout(request.timeoutId);
      this.pendingRequests.delete(requestId);
      this.totalRejected += 1;
      const endpointStat = this.endpointStats.get(request.endpoint);
      if (endpointStat) {
        endpointStat.rejected += 1;
      }
      if (error instanceof Error && error.message === 'Request timeout') {
        this.totalTimeouts += 1;
      } else if (typeof error === 'string' && error.toLowerCase().includes('timeout')) {
        this.totalTimeouts += 1;
      }
      request.reject(error);
    }
  }

  // Clean up old requests
  cleanupOldRequests() {
    const now = Date.now();
    for (const [id, request] of this.pendingRequests.entries()) {
      if (now - request.timestamp > this.requestTimeout) {
        clearTimeout(request.timeoutId);
        this.pendingRequests.delete(id);
        this.totalRejected += 1;
        this.totalTimeouts += 1;
        const endpointStat = this.endpointStats.get(request.endpoint);
        if (endpointStat) {
          endpointStat.rejected += 1;
        }
        request.reject(new Error('Request timeout'));
      }
    }
  }

  // Force cleanup all pending requests (used on disconnect)
  clearAllPendingRequests() {
    for (const [, request] of this.pendingRequests.entries()) {
      clearTimeout(request.timeoutId);
      this.totalRejected += 1;
      const endpointStat = this.endpointStats.get(request.endpoint);
      if (endpointStat) {
        endpointStat.rejected += 1;
      }
      request.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
  }

  clearPendingRequestsForSession(sessionId: string) {
    if (!sessionId) {
      return;
    }
    for (const [id, request] of this.pendingRequests.entries()) {
      if (request.targetSessionId !== sessionId && request.leasedSessionId !== sessionId) {
        continue;
      }
      clearTimeout(request.timeoutId);
      this.totalRejected += 1;
      const endpointStat = this.endpointStats.get(request.endpoint);
      if (endpointStat) {
        endpointStat.rejected += 1;
      }
      request.reject(new Error(`Connection closed for session ${sessionId}`));
      this.pendingRequests.delete(id);
    }
  }

  upsertStudioSession(sessionId: string, info?: Partial<StudioSessionInfo>) {
    if (!sessionId) {
      return;
    }
    const existing = this.studioSessions.get(sessionId);
    const merged: StudioSessionInfo = {
      sessionId,
      lastSeenAt: info?.lastSeenAt ?? Date.now(),
      ready: info?.ready ?? existing?.ready ?? false,
      version: info?.version ?? existing?.version ?? null,
      capabilities: info?.capabilities ?? existing?.capabilities ?? {},
      serverUrl: info?.serverUrl ?? existing?.serverUrl ?? null,
      placeId: info?.placeId ?? existing?.placeId ?? null,
      placeName: info?.placeName ?? existing?.placeName ?? null,
    };
    this.studioSessions.set(sessionId, merged);
  }

  markStudioSessionDisconnected(sessionId: string) {
    if (!sessionId) {
      return;
    }
    const existing = this.studioSessions.get(sessionId);
    if (!existing) {
      return;
    }
    this.studioSessions.set(sessionId, {
      ...existing,
      ready: false,
      lastSeenAt: Date.now(),
    });
  }

getStudioSessions(maxAgeMs: number = 60_000): StudioSessionInfo[] {
    const now = Date.now();
    return [...this.studioSessions.values()]
      .filter((session) => now - session.lastSeenAt <= maxAgeMs)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  createAgentThread(agentId?: string): AgentThread {
    const effectiveAgentId = agentId || 'default';
    const threadInfo = unifiedChatBridge.createThread(effectiveAgentId);
    const thread: AgentThread = {
      threadId: threadInfo.threadId,
      agentId: threadInfo.agentId,
      status: threadInfo.status,
      messages: [],
      tokensIn: 0,
      tokensOut: 0,
      createdAt: threadInfo.createdAt,
      lastActivityAt: threadInfo.lastActivityAt,
    };
    this.agentThreads.set(threadInfo.threadId, thread);
    if (!this.agentRequestCount.has(effectiveAgentId)) {
      this.agentRequestCount.set(effectiveAgentId, 0);
      this.agentLatencySamples.set(effectiveAgentId, []);
    }
    return thread;
  }

  getAgentThreads(): AgentThread[] {
    const unifiedThreads = unifiedChatBridge.getAllThreads();
    const result: AgentThread[] = unifiedThreads.map(t => {
      const existing = this.agentThreads.get(t.threadId);
      return {
        threadId: t.threadId,
        agentId: t.agentId,
        status: t.status,
        messages: existing?.messages || [],
        tokensIn: existing?.tokensIn || 0,
        tokensOut: existing?.tokensOut || 0,
        createdAt: t.createdAt,
        lastActivityAt: t.lastActivityAt,
      };
    });
    return result.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  getAgentThread(threadId: string): AgentThread | undefined {
    return this.agentThreads.get(threadId);
  }

  getAgentStatus(): AgentStatus[] {
    const agentMap = new Map<string, { threads: AgentThread[]; activeThreadId: string | null }>();
    for (const thread of this.agentThreads.values()) {
      if (!agentMap.has(thread.agentId)) {
        agentMap.set(thread.agentId, { threads: [], activeThreadId: null });
      }
      const entry = agentMap.get(thread.agentId)!;
      entry.threads.push(thread);
      if (thread.status === 'active' && !entry.activeThreadId) {
        entry.activeThreadId = thread.threadId;
      }
    }
    const result: AgentStatus[] = [];
    for (const [agentId, { threads, activeThreadId }] of agentMap) {
      const activeThread = activeThreadId ? this.agentThreads.get(activeThreadId) : threads[0];
      if (!activeThread) continue;
      const latencySamples = this.agentLatencySamples.get(agentId) || [];
      const avgLatencyMs = latencySamples.length > 0
        ? Math.round(latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length)
        : 0;
      result.push({
        agentId,
        threadId: activeThread.threadId,
        status: activeThread.status,
        tokensIn: activeThread.tokensIn,
        tokensOut: activeThread.tokensOut,
        avgLatencyMs,
        requestCount: this.agentRequestCount.get(agentId) || 0,
        lastActivityAt: activeThread.lastActivityAt,
        threadCount: threads.length,
      });
    }
    return result;
  }

  getAgentMetrics(): AgentMetrics {
    let tokensInTotal = 0;
    let tokensOutTotal = 0;
    const allLatencySamples: number[] = [];
    for (const thread of this.agentThreads.values()) {
      tokensInTotal += thread.tokensIn;
      tokensOutTotal += thread.tokensOut;
    }
    for (const samples of this.agentLatencySamples.values()) {
      allLatencySamples.push(...samples);
    }
    allLatencySamples.sort((a, b) => a - b);
    const p50 = allLatencySamples.length > 0 ? allLatencySamples[Math.floor(allLatencySamples.length * 0.5)] : 0;
    const p99 = allLatencySamples.length > 0 ? allLatencySamples[Math.floor(allLatencySamples.length * 0.99)] || allLatencySamples[allLatencySamples.length - 1] : 0;
    return {
      tokensInTotal,
      tokensOutTotal,
      requestsTotal: this.totalRequests,
      avgLatencyMs: this.totalResolved > 0 ? Math.round(this.totalLatencyMs / this.totalResolved) : 0,
      p50LatencyMs: p50,
      p99LatencyMs: p99,
      laneStats: [],
    };
  }

  pauseAgent(agentId: string): boolean {
    let found = false;
    for (const thread of this.agentThreads.values()) {
      if (thread.agentId === agentId && thread.status === 'active') {
        thread.status = 'paused';
        thread.lastActivityAt = Date.now();
        found = true;
      }
    }
    return found;
  }

  resumeAgent(agentId: string): boolean {
    let found = false;
    for (const thread of this.agentThreads.values()) {
      if (thread.agentId === agentId && thread.status === 'paused') {
        thread.status = 'active';
        thread.lastActivityAt = Date.now();
        found = true;
      }
    }
    return found;
  }

  stopAgent(agentId: string): boolean {
    let found = false;
    for (const thread of this.agentThreads.values()) {
      if (thread.agentId === agentId) {
        thread.status = 'stopped';
        thread.lastActivityAt = Date.now();
        found = true;
      }
    }
    return found;
  }

  addMessageToThread(threadId: string, message: ChatMessage): boolean {
    const thread = this.agentThreads.get(threadId);
    if (!thread) return false;
    thread.messages.push(message);
    thread.lastActivityAt = Date.now();
    if (message.role === 'user') {
      thread.tokensIn += message.tokensIn || Math.ceil(message.content.length / 4);
    } else if (message.role === 'assistant') {
      thread.tokensOut += message.tokensOut || Math.ceil(message.content.length / 4);
    }
    const agentId = thread.agentId;
    const count = this.agentRequestCount.get(agentId) || 0;
    this.agentRequestCount.set(agentId, count + 1);
    unifiedChatBridge.sendMessage(threadId, message.role, message.content, message.tokensIn, message.tokensOut);
    return true;
  }

  getThreadMessages(threadId: string): ChatMessage[] {
    const bridgeMessages = unifiedChatBridge.getMessages(threadId);
    if (bridgeMessages.length > 0) {
      return bridgeMessages as ChatMessage[];
    }
    const thread = this.agentThreads.get(threadId);
    return thread ? thread.messages : [];
  }

  private percentile(samples: number[], p: number): number {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
    return sorted[idx];
  }

getStats() {
    const p50 = this.percentile(this.latencySamples, 50);
    const p90 = this.percentile(this.latencySamples, 90);
    const p99 = this.percentile(this.latencySamples, 99);
    const endpoints = Array.from(this.endpointStats.entries()).map(([endpoint, stat]) => ({
      endpoint,
      total: stat.total,
      resolved: stat.resolved,
      rejected: stat.rejected,
      avgLatencyMs: stat.resolved > 0 ? Math.round(stat.totalLatencyMs / stat.resolved) : 0
    }));
    return {
      inFlightRequests: this.pendingRequests.size,
      activeStudioSessions: this.getStudioSessions().length,
      activePluginClients: this.pluginClients.size,
      totalRequests: this.totalRequests,
      totalResolved: this.totalResolved,
      totalRejected: this.totalRejected,
      totalTimeouts: this.totalTimeouts,
      averageLatencyMs: this.totalResolved > 0 ? Math.round(this.totalLatencyMs / this.totalResolved) : 0,
      p50LatencyMs: p50,
      p90LatencyMs: p90,
      p99LatencyMs: p99,
      latencySampleCount: this.latencySamples.length,
      endpoints
    };
  }

  setWsServer(ws: WsPluginServer | null): void {
    this.wsServer = ws;
  }

  broadcastTaskEvent(event: { taskId: string; type: string; goalId: string; agentId: string; progress?: { current: number; total: number }; result?: unknown; error?: unknown; timestamp: number }, excludeClientId?: string): void {
    this.wsServer?.broadcastTaskEvent(event, excludeClientId);
  }

  broadcastFileTreeDelta(path: string, change: 'created' | 'modified' | 'deleted', node: unknown): void {
    this.wsServer?.broadcastFileTreeDelta(path, change, node);
  }

  broadcastOrchestratorSelection(agentId: string, tier: string, teamId: string, lane: string, goalId: string): void {
    this.wsServer?.broadcastOrchestratorSelection(agentId, tier, teamId, lane, goalId);
  }

  private taskUpdates: Map<string, TaskUpdate> = new Map();
  private taskUpdateListeners: Map<string, Array<(update: TaskUpdate) => void>> = new Map();
  private directCommandDefs: DirectCommandDef[] = [];

  registerDirectCommand(def: DirectCommandDef): void {
    const existing = this.directCommandDefs.findIndex(d => d.endpoint === def.endpoint);
    if (existing >= 0) {
      this.directCommandDefs[existing] = def;
    } else {
      this.directCommandDefs.push(def);
    }
  }

  getDirectCommands(): DirectCommandDef[] {
    return [...this.directCommandDefs];
  }

  onTaskUpdate(taskId: string, handler: (update: TaskUpdate) => void): () => void {
    if (!this.taskUpdateListeners.has(taskId)) {
      this.taskUpdateListeners.set(taskId, []);
    }
    this.taskUpdateListeners.get(taskId)!.push(handler);
    return () => {
      const handlers = this.taskUpdateListeners.get(taskId);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
    };
  }

  emitTaskUpdate(update: TaskUpdate): void {
    this.taskUpdates.set(update.taskId, update);
    const listeners = this.taskUpdateListeners.get(update.taskId);
    if (listeners) {
      for (const handler of listeners) {
        handler(update);
      }
    }
    this.broadcastTaskEvent({
      taskId: update.taskId,
      type: 'statusChange',
      goalId: update.taskId,
      agentId: update.agentId ?? 'unknown',
      progress: { current: update.progress, total: 100 },
      result: update.result,
      error: update.error,
      timestamp: Date.now(),
    });
  }

  getTaskUpdate(taskId: string): TaskUpdate | undefined {
    return this.taskUpdates.get(taskId);
  }

  getRecentTaskUpdates(maxAgeMs: number = 30000): TaskUpdate[] {
    const now = Date.now();
    return [...this.taskUpdates.values()].filter(u => now - (u.result ? 0 : 0) <= maxAgeMs);
  }
}
