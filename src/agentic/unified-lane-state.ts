import type { AgentLane } from '../agents/types.js';

export type LaneStatus = 'healthy' | 'busy' | 'stalled' | 'overloaded';

export interface LaneState {
  lane: AgentLane;
  inFlight: number;
  pending: number;
  completed: number;
  failed: number;
  weight: number;
  maxInFlight: number;
  avgLatencyMs: number;
  status: LaneStatus;
}

export interface LaneConflict {
  lane: AgentLane;
  serverValue: number;
  pluginValue: number;
  resolution: 'server' | 'plugin';
}

const LANE_NAMES: AgentLane[] = ['core', 'reviewer', 'qa', 'background'];

const DEFAULT_LANE_CONFIG: Record<AgentLane, { maxInFlight: number; weight: number }> = {
  core: { maxInFlight: 4, weight: 3 },
  reviewer: { maxInFlight: 2, weight: 1 },
  qa: { maxInFlight: 2, weight: 1 },
  background: { maxInFlight: 1, weight: 1 },
};

export class UnifiedLaneState {
  private static instance: UnifiedLaneState;
  private lanes: Map<AgentLane, LaneState> = new Map();
  private latencies: Map<AgentLane, number[]> = new Map();
  private maxLatencySamples = 100;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private lastSyncFromServer: Map<AgentLane, number> = new Map();
  private lastSyncFromPlugin: Map<AgentLane, number> = new Map();

  private constructor() {
    for (const lane of LANE_NAMES) {
      const config = DEFAULT_LANE_CONFIG[lane];
      this.lanes.set(lane, {
        lane,
        inFlight: 0,
        pending: 0,
        completed: 0,
        failed: 0,
        weight: config.weight,
        maxInFlight: config.maxInFlight,
        avgLatencyMs: 0,
        status: 'healthy',
      });
      this.latencies.set(lane, []);
    }
  }

  static getInstance(): UnifiedLaneState {
    if (!UnifiedLaneState.instance) {
      UnifiedLaneState.instance = new UnifiedLaneState();
    }
    return UnifiedLaneState.instance;
  }

  update(lane: AgentLane, update: Partial<LaneState>): void {
    const existing = this.lanes.get(lane);
    if (!existing) return;
    Object.assign(existing, update);
    this.recalculateStatus(lane);
  }

  get(lane: AgentLane): LaneState | undefined {
    return this.lanes.get(lane);
  }

  getAll(): LaneState[] {
    return [...this.lanes.values()];
  }

  getByStatus(status: LaneStatus): LaneState[] {
    return this.getAll().filter(l => l.status === status);
  }

  recordActivity(lane: AgentLane, action: 'start' | 'complete' | 'fail' | 'pending', latencyMs?: number): void {
    const state = this.lanes.get(lane);
    if (!state) return;

    switch (action) {
      case 'start':
        state.inFlight += 1;
        break;
      case 'complete':
        state.inFlight = Math.max(0, state.inFlight - 1);
        state.completed += 1;
        if (latencyMs !== undefined) {
          this.recordLatency(lane, latencyMs);
        }
        break;
      case 'fail':
        state.inFlight = Math.max(0, state.inFlight - 1);
        state.failed += 1;
        break;
      case 'pending':
        state.pending += 1;
        break;
    }

    this.recalculateStatus(lane);
  }

  setConfig(lane: AgentLane, maxInFlight: number, weight: number): void {
    const state = this.lanes.get(lane);
    if (!state) return;
    state.maxInFlight = maxInFlight;
    state.weight = weight;
    this.recalculateStatus(lane);
  }

  syncFromServer(serverLanes: LaneState[]): void {
    const now = Date.now();
    for (const serverLane of serverLanes) {
      this.lastSyncFromServer.set(serverLane.lane, now);
      const local = this.lanes.get(serverLane.lane);
      if (local) {
        local.inFlight = serverLane.inFlight;
        local.weight = serverLane.weight;
        local.maxInFlight = serverLane.maxInFlight;
        this.recalculateStatus(serverLane.lane);
      }
    }
  }

  syncFromPlugin(pluginLanes: Array<{ lane: string; inFlight: number; pending: number; completed: number; failed: number }>): void {
    const now = Date.now();
    for (const pLane of pluginLanes) {
      this.lastSyncFromPlugin.set(pLane.lane as AgentLane, now);
      const local = this.lanes.get(pLane.lane as AgentLane);
      if (local) {
        local.inFlight = pLane.inFlight;
        local.pending = pLane.pending;
        local.completed = pLane.completed;
        local.failed = pLane.failed;
        this.recalculateStatus(pLane.lane as AgentLane);
      }
    }
  }

  getConflicts(): LaneConflict[] {
    const conflicts: LaneConflict[] = [];
    const now = Date.now();
    const SYNC_THRESHOLD_MS = 5000;

    for (const [lane, lastServer] of this.lastSyncFromServer) {
      const lastPlugin = this.lastSyncFromPlugin.get(lane) ?? 0;
      const local = this.lanes.get(lane);
      if (!local) continue;

      if (now - lastServer < SYNC_THRESHOLD_MS && now - lastPlugin < SYNC_THRESHOLD_MS) {
        const serverRecent = now - lastServer < SYNC_THRESHOLD_MS;
        const pluginRecent = now - lastPlugin < SYNC_THRESHOLD_MS;
        if (serverRecent && pluginRecent && Math.abs(local.inFlight - (this.get(lane)?.inFlight ?? 0)) > 1) {
          conflicts.push({
            lane,
            serverValue: local.inFlight,
            pluginValue: local.inFlight,
            resolution: 'server',
          });
        }
      }
    }

    return conflicts;
  }

  getBestAvailableLane(): AgentLane | undefined {
    let bestLane: AgentLane | undefined;
    let bestScore = -1;

    for (const [lane, state] of this.lanes) {
      if (state.inFlight >= state.maxInFlight) continue;
      const score = state.weight / (state.inFlight + 1);
      if (score > bestScore) {
        bestScore = score;
        bestLane = lane;
      }
    }

    return bestLane;
  }

  getSwarmStatus(): {
    totalAgents: number;
    activeAgents: number;
    avgLatencyMs: number;
    overallStatus: 'healthy' | 'degraded' | 'critical';
    laneHealth: LaneState[];
  } {
    let totalAgents = 0;
    let activeAgents = 0;
    let totalLatency = 0;
    let latencyCount = 0;

    for (const state of this.lanes.values()) {
      totalAgents += state.inFlight + state.pending;
      activeAgents += state.inFlight;
      if (state.avgLatencyMs > 0) {
        totalLatency += state.avgLatencyMs;
        latencyCount += 1;
      }
    }

    const criticalLanes = [...this.lanes.values()].filter((l: LaneState) => l.status === 'overloaded' || l.status === 'stalled');
    let overallStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (criticalLanes.length > 0) {
      overallStatus = 'critical';
    } else {
      const degradedLanes = [...this.lanes.values()].filter((l: LaneState) => l.status === 'busy');
      if (degradedLanes.length > LANE_NAMES.length / 2) {
        overallStatus = 'degraded';
      }
    }

    return {
      totalAgents,
      activeAgents,
      avgLatencyMs: latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0,
      overallStatus,
      laneHealth: this.getAll(),
    };
  }

  private recordLatency(lane: AgentLane, latencyMs: number): void {
    const samples = this.latencies.get(lane) || [];
    samples.push(latencyMs);
    if (samples.length > this.maxLatencySamples) {
      samples.shift();
    }
    this.latencies.set(lane, samples);
    const state = this.lanes.get(lane);
    if (state) {
      state.avgLatencyMs = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
    }
  }

  private recalculateStatus(lane: AgentLane): void {
    const state = this.lanes.get(lane);
    if (!state) return;

    const utilization = state.inFlight / state.maxInFlight;

    if (utilization >= 1.0) {
      state.status = 'overloaded';
    } else if (utilization >= 0.8) {
      state.status = 'busy';
    } else if (state.pending > state.maxInFlight * 2) {
      state.status = 'stalled';
    } else {
      state.status = 'healthy';
    }
  }

  close(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
  }
}

export const unifiedLaneState = UnifiedLaneState.getInstance();
