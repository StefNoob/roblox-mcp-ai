export type TeamTokenMode = 'standard' | 'light';

export type WriteTeamPolicy = {
  lane: string;
  maxInFlight: number;
  tokenMode: TeamTokenMode;
  weight: number;
};

export type WriteOrchestratorConfig = {
  maxConcurrency: number;
  defaultTeamId: string;
  teams: Record<string, WriteTeamPolicy>;
  laneWeights: Record<string, number>;
};

export type WriteOrchestratorConfigPatch = Partial<{
  maxConcurrency: number;
  defaultTeamId: string;
  teams: Record<string, Partial<WriteTeamPolicy>>;
  laneWeights: Record<string, number>;
}>;

export type WriteJobOptions = {
  priority?: number;
  resourceKey?: string | null;
  teamId?: string;
  agentId?: string;
  lane?: string;
};

type WriteJob<T> = {
  id: string;
  label: string;
  priority: number;
  resourceKey: string | null;
  teamId: string;
  lane: string;
  agentId: string | null;
  createdAt: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeLaneName(raw: string | undefined): string {
  if (typeof raw !== 'string') {
    return 'core';
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : 'core';
}

function normalizeWeight(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return 1;
  }
  return clampInt(raw, 1, 12);
}

function normalizePolicy(raw: Partial<WriteTeamPolicy> | undefined): WriteTeamPolicy {
  return {
    lane: normalizeLaneName(raw?.lane),
    maxInFlight: clampInt(typeof raw?.maxInFlight === 'number' ? raw.maxInFlight : 1, 1, 16),
    tokenMode: raw?.tokenMode === 'light' ? 'light' : 'standard',
    weight: normalizeWeight(raw?.weight),
  };
}

function normalizeConfig(input?: WriteOrchestratorConfigPatch | WriteOrchestratorConfig): WriteOrchestratorConfig {
  const defaults: WriteOrchestratorConfig = {
    maxConcurrency: 2,
    defaultTeamId: 'core',
    teams: {
      core: { lane: 'core', maxInFlight: 2, tokenMode: 'standard', weight: 3 },
      reviewer: { lane: 'reviewer', maxInFlight: 1, tokenMode: 'light', weight: 1 },
      qa: { lane: 'qa', maxInFlight: 1, tokenMode: 'light', weight: 1 },
      background: { lane: 'background', maxInFlight: 1, tokenMode: 'standard', weight: 1 },
    },
    laneWeights: {
      core: 3,
      reviewer: 1,
      qa: 1,
      background: 1,
    },
  };

  const maxConcurrency = clampInt(
    typeof input?.maxConcurrency === 'number' ? input.maxConcurrency : defaults.maxConcurrency,
    1,
    16,
  );
  const defaultTeamId = typeof input?.defaultTeamId === 'string' && input.defaultTeamId.trim().length > 0
    ? input.defaultTeamId.trim()
    : defaults.defaultTeamId;

  const teams: Record<string, WriteTeamPolicy> = {};
  for (const [teamId, policy] of Object.entries(defaults.teams)) {
    teams[teamId] = normalizePolicy(policy);
  }
  for (const [teamId, policy] of Object.entries(input?.teams || {})) {
    teams[teamId] = normalizePolicy({
      ...teams[teamId],
      ...policy,
    });
  }
  if (!teams[defaultTeamId]) {
    teams[defaultTeamId] = normalizePolicy(undefined);
  }

  const laneWeights: Record<string, number> = {};
  for (const [lane, weight] of Object.entries(defaults.laneWeights)) {
    laneWeights[normalizeLaneName(lane)] = normalizeWeight(weight);
  }
  for (const [lane, weight] of Object.entries(input?.laneWeights || {})) {
    laneWeights[normalizeLaneName(lane)] = normalizeWeight(weight);
  }
  for (const policy of Object.values(teams)) {
    if (!laneWeights[policy.lane]) {
      laneWeights[policy.lane] = normalizeWeight(policy.weight);
    }
  }

  return {
    maxConcurrency,
    defaultTeamId,
    teams,
    laneWeights,
  };
}

export class WriteOrchestrator {
  private config: WriteOrchestratorConfig;
  private pendingByLane: Map<string, Array<WriteJob<unknown>>> = new Map();
  private inFlightJobs: Map<string, WriteJob<unknown>> = new Map();
  private lockedResources: Set<string> = new Set();
  private teamInFlight: Map<string, number> = new Map();
  private sequence = 0;
  private laneCursor = 0;
  private completedWrites = 0;
  private failedWrites = 0;
  private cancelledWrites = 0;
  private scheduleQueued = false;

  constructor(config?: WriteOrchestratorConfigPatch | WriteOrchestratorConfig) {
    this.config = normalizeConfig(config);
  }

  configure(patch: WriteOrchestratorConfigPatch) {
    this.config = normalizeConfig({
      ...this.config,
      ...patch,
      teams: {
        ...this.config.teams,
        ...(patch.teams || {}),
      },
      laneWeights: {
        ...this.config.laneWeights,
        ...(patch.laneWeights || {}),
      },
    });
    this.schedule();
    return this.getConfig();
  }

  getConfig(): WriteOrchestratorConfig {
    return JSON.parse(JSON.stringify(this.config)) as WriteOrchestratorConfig;
  }

  enqueue<T>(label: string, run: () => Promise<T>, options?: WriteJobOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const teamId = this.resolveTeamId(options?.teamId);
      const policy = this.config.teams[teamId];
      const lane = normalizeLaneName(options?.lane || policy?.lane);
      const queue = this.pendingByLane.get(lane) || [];
      const job: WriteJob<T> = {
        id: `wq_${++this.sequence}`,
        label,
        priority: typeof options?.priority === 'number' ? options.priority : 0,
        resourceKey: typeof options?.resourceKey === 'string' && options.resourceKey.length > 0 ? options.resourceKey : null,
        teamId,
        lane,
        agentId: typeof options?.agentId === 'string' && options.agentId.length > 0 ? options.agentId : null,
        createdAt: Date.now(),
        run,
        resolve,
        reject,
      };
      queue.push(job as WriteJob<unknown>);
      this.pendingByLane.set(lane, queue);
      this.schedule();
    });
  }

  cancelPending(predicate: (job: { label: string; teamId: string; lane: string; id: string }) => boolean) {
    let cancelled = 0;
    for (const [lane, queue] of this.pendingByLane.entries()) {
      const nextQueue: Array<WriteJob<unknown>> = [];
      for (const job of queue) {
        if (predicate({ label: job.label, teamId: job.teamId, lane: job.lane, id: job.id })) {
          cancelled += 1;
          this.cancelledWrites += 1;
          job.reject(new Error(`Write job cancelled: ${job.label}`));
          continue;
        }
        nextQueue.push(job);
      }
      if (nextQueue.length > 0) {
        this.pendingByLane.set(lane, nextQueue);
      } else {
        this.pendingByLane.delete(lane);
      }
    }
    return { cancelled };
  }

  getStats() {
    const now = Date.now();
    const inFlightItems = [...this.inFlightJobs.values()].map((job) => ({
      id: job.id,
      label: job.label,
      priority: job.priority,
      teamId: job.teamId,
      lane: job.lane,
      resourceKey: job.resourceKey,
      ageMs: now - job.createdAt,
    }));
    const pendingItems = [...this.pendingByLane.values()]
      .flat()
      .map((job) => ({
        id: job.id,
        label: job.label,
        priority: job.priority,
        teamId: job.teamId,
        lane: job.lane,
        resourceKey: job.resourceKey,
        ageMs: now - job.createdAt,
      }))
      .sort((a, b) => {
        if (a.priority === b.priority) {
          return a.ageMs - b.ageMs;
        }
        return b.priority - a.priority;
      });

    const pendingByLane: Record<string, number> = {};
    for (const [lane, queue] of this.pendingByLane.entries()) {
      pendingByLane[lane] = queue.length;
    }

    const teamStats: Record<string, { inFlight: number; pending: number; tokenMode: TeamTokenMode; maxInFlight: number }> = {};
    for (const [teamId, policy] of Object.entries(this.config.teams)) {
      teamStats[teamId] = {
        inFlight: this.teamInFlight.get(teamId) || 0,
        pending: pendingItems.filter((item) => item.teamId === teamId).length,
        tokenMode: policy.tokenMode,
        maxInFlight: policy.maxInFlight,
      };
    }

    return {
      inFlight: inFlightItems[0] || null,
      inFlightItems,
      pending: pendingItems.length,
      pendingItems,
      pendingByLane,
      maxConcurrency: this.config.maxConcurrency,
      laneWeights: this.config.laneWeights,
      defaultTeamId: this.config.defaultTeamId,
      teamStats,
      completedWrites: this.completedWrites,
      failedWrites: this.failedWrites,
      cancelledWrites: this.cancelledWrites,
    };
  }

  private resolveTeamId(raw?: string) {
    if (raw && this.config.teams[raw]) {
      return raw;
    }
    return this.config.defaultTeamId;
  }

  private laneSequence() {
    const sequence: string[] = [];
    for (const [lane, weight] of Object.entries(this.config.laneWeights)) {
      for (let i = 0; i < weight; i += 1) {
        sequence.push(lane);
      }
    }
    if (sequence.length === 0) {
      sequence.push('core');
    }
    return sequence;
  }

  private canRunJob(job: WriteJob<unknown>) {
    if (job.resourceKey && this.lockedResources.has(job.resourceKey)) {
      return false;
    }
    const policy = this.config.teams[job.teamId] || this.config.teams[this.config.defaultTeamId];
    const limit = clampInt(policy?.maxInFlight ?? 1, 1, 16);
    const used = this.teamInFlight.get(job.teamId) || 0;
    return used < limit;
  }

  private pickNextJob(): WriteJob<unknown> | null {
    const sequence = this.laneSequence();
    const start = this.laneCursor % sequence.length;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      const idx = (start + offset) % sequence.length;
      const lane = sequence[idx];
      const queue = this.pendingByLane.get(lane);
      if (!queue || queue.length === 0) {
        continue;
      }
      let bestIndex = -1;
      for (let i = 0; i < queue.length; i += 1) {
        const candidate = queue[i];
        if (!this.canRunJob(candidate)) {
          continue;
        }
        if (bestIndex < 0) {
          bestIndex = i;
          continue;
        }
        const best = queue[bestIndex];
        if (
          candidate.priority > best.priority ||
          (candidate.priority === best.priority && candidate.createdAt < best.createdAt)
        ) {
          bestIndex = i;
        }
      }
      if (bestIndex >= 0) {
        const [job] = queue.splice(bestIndex, 1);
        if (queue.length === 0) {
          this.pendingByLane.delete(lane);
        }
        this.laneCursor = (idx + 1) % sequence.length;
        return job;
      }
    }
    return null;
  }

  private startJob(job: WriteJob<unknown>) {
    this.inFlightJobs.set(job.id, job);
    this.teamInFlight.set(job.teamId, (this.teamInFlight.get(job.teamId) || 0) + 1);
    if (job.resourceKey) {
      this.lockedResources.add(job.resourceKey);
    }

    Promise.resolve()
      .then(() => job.run())
      .then((result) => {
        this.completedWrites += 1;
        job.resolve(result);
      })
      .catch((error) => {
        this.failedWrites += 1;
        job.reject(error);
      })
      .finally(() => {
        this.inFlightJobs.delete(job.id);
        const nextInFlight = Math.max(0, (this.teamInFlight.get(job.teamId) || 1) - 1);
        if (nextInFlight === 0) {
          this.teamInFlight.delete(job.teamId);
        } else {
          this.teamInFlight.set(job.teamId, nextInFlight);
        }
        if (job.resourceKey) {
          this.lockedResources.delete(job.resourceKey);
        }
        this.schedule();
      });
  }

  private pump() {
    while (this.inFlightJobs.size < this.config.maxConcurrency) {
      const next = this.pickNextJob();
      if (!next) {
        break;
      }
      this.startJob(next);
    }
  }

  private schedule() {
    if (this.scheduleQueued) {
      return;
    }
    this.scheduleQueued = true;
    queueMicrotask(() => {
      this.scheduleQueued = false;
      this.pump();
    });
  }
}
