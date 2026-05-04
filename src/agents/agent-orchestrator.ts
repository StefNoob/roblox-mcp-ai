import {
  type AgentLane,
  type LaneConfig,
  type TeamProfile,
  type OrchestratorConfig,
} from './types.js';

const DEFAULT_LANE_CONFIG: Record<AgentLane, LaneConfig> = {
  core: { maxInFlight: 3, weight: 3, tokenMode: 'standard', priority: 100 },
  reviewer: { maxInFlight: 2, weight: 1, tokenMode: 'standard', priority: 80 },
  qa: { maxInFlight: 2, weight: 1, tokenMode: 'light', priority: 60 },
  background: { maxInFlight: 1, weight: 1, tokenMode: 'light', priority: 40 },
};

export class AgentOrchestrator {
  private config: OrchestratorConfig;
  private laneQueues: Map<AgentLane, string[]> = new Map();
  private laneInflight: Map<AgentLane, Set<string>> = new Map();

  constructor(config?: Partial<OrchestratorConfig>) {
    this.config = {
      maxConcurrency: config?.maxConcurrency ?? 4,
      defaultTeamId: config?.defaultTeamId ?? 'core',
      laneWeights: config?.laneWeights ?? { core: 3, reviewer: 1, qa: 1, background: 1 },
      teams: config?.teams ?? DEFAULT_LANE_CONFIG,
    };
    for (const lane of ['core', 'reviewer', 'qa', 'background'] as AgentLane[]) {
      this.laneQueues.set(lane, []);
      this.laneInflight.set(lane, new Set());
    }
  }

  configure(patch: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  getConfig(): OrchestratorConfig {
    return { ...this.config };
  }

  getProfile(): TeamProfile {
    return {
      maxConcurrency: this.config.maxConcurrency,
      defaultTeamId: this.config.defaultTeamId,
      laneWeights: { ...this.config.laneWeights },
      teams: { ...this.config.teams },
    };
  }

  canSchedule(lane: AgentLane): boolean {
    const config = this.config.teams[lane];
    if (!config) return false;
    const inFlight = this.laneInflight.get(lane)?.size ?? 0;
    return inFlight < config.maxInFlight;
  }

  getAvailableCapacity(lane: AgentLane): number {
    const config = this.config.teams[lane];
    if (!config) return 0;
    const inFlight = this.laneInflight.get(lane)?.size ?? 0;
    return Math.max(0, config.maxInFlight - inFlight);
  }

  getTotalAvailableSlots(): number {
    let total = 0;
    for (const lane of ['core', 'reviewer', 'qa', 'background'] as AgentLane[]) {
      total += this.getAvailableCapacity(lane);
    }
    return total;
  }

  enqueue(lane: AgentLane, agentId: string): void {
    const queue = this.laneQueues.get(lane);
    if (!queue) return;
    if (!queue.includes(agentId)) {
      queue.push(agentId);
    }
  }

  dequeue(lane: AgentLane): string | undefined {
    const queue = this.laneQueues.get(lane);
    return queue?.shift();
  }

  acquire(lane: AgentLane, agentId: string): boolean {
    if (!this.canSchedule(lane)) return false;
    this.laneInflight.get(lane)?.add(agentId);
    const queue = this.laneQueues.get(lane);
    if (queue) {
      const idx = queue.indexOf(agentId);
      if (idx >= 0) queue.splice(idx, 1);
    }
    return true;
  }

  release(lane: AgentLane, agentId: string): void {
    this.laneInflight.get(lane)?.delete(agentId);
  }

  getQueueSize(lane: AgentLane): number {
    return this.laneQueues.get(lane)?.length ?? 0;
  }

  getInFlightCount(lane: AgentLane): number {
    return this.laneInflight.get(lane)?.size ?? 0;
  }

  getStats() {
    return {
      maxConcurrency: this.config.maxConcurrency,
      defaultTeamId: this.config.defaultTeamId,
      lanes: (['core', 'reviewer', 'qa', 'background'] as AgentLane[]).map(lane => ({
        lane,
        config: this.config.teams[lane],
        inFlight: this.getInFlightCount(lane),
        queue: this.getQueueSize(lane),
        available: this.getAvailableCapacity(lane),
      })),
      totalInFlight: [...this.laneInflight.values()].reduce((sum, s) => sum + s.size, 0),
      totalQueue: [...this.laneQueues.values()].reduce((sum, q) => sum + q.length, 0),
    };
  }

  buildPreset(preset: 'balanced' | 'throughput' | 'tokenSaver'): void {
    switch (preset) {
      case 'throughput':
        this.config.maxConcurrency = 6;
        this.config.laneWeights = { core: 5, reviewer: 1, qa: 1, background: 1 };
        this.config.teams = {
          core: { maxInFlight: 5, weight: 5, tokenMode: 'standard', priority: 100 },
          reviewer: { maxInFlight: 1, weight: 1, tokenMode: 'standard', priority: 80 },
          qa: { maxInFlight: 1, weight: 1, tokenMode: 'light', priority: 60 },
          background: { maxInFlight: 1, weight: 1, tokenMode: 'light', priority: 40 },
        };
        break;
      case 'tokenSaver':
        this.config.maxConcurrency = 3;
        this.config.laneWeights = { core: 2, reviewer: 2, qa: 2, background: 1 };
        this.config.teams = {
          core: { maxInFlight: 1, weight: 2, tokenMode: 'light', priority: 100 },
          reviewer: { maxInFlight: 2, weight: 2, tokenMode: 'light', priority: 80 },
          qa: { maxInFlight: 2, weight: 2, tokenMode: 'light', priority: 60 },
          background: { maxInFlight: 1, weight: 1, tokenMode: 'light', priority: 40 },
        };
        break;
      default:
        this.config.maxConcurrency = 4;
        this.config.laneWeights = { core: 3, reviewer: 1, qa: 1, background: 1 };
        this.config.teams = { ...DEFAULT_LANE_CONFIG };
    }
  }

  fromPluginSettings(settings: {
    parallelAgents?: number;
    teamPreset?: 'balanced' | 'throughput' | 'tokenSaver';
    reviewerLightMode?: boolean;
    qaLightMode?: boolean;
    useLightModel?: boolean;
  }): void {
    this.config.maxConcurrency = settings.parallelAgents ?? 4;
    this.buildPreset(settings.teamPreset ?? 'balanced');
    if (settings.reviewerLightMode) {
      this.config.teams.reviewer.tokenMode = 'light';
    }
    if (settings.qaLightMode) {
      this.config.teams.qa.tokenMode = 'light';
    }
    if (settings.useLightModel) {
      this.config.teams.core.tokenMode = 'light';
      this.config.teams.background.tokenMode = 'light';
    }
  }
}

export const agentOrchestrator = new AgentOrchestrator();