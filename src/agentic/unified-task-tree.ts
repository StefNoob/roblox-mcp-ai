import { v4 as uuidv4 } from 'uuid';
import type { AgentTier } from './unified-agent-manager.js';

export type TaskStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface TaskProgress {
  current: number;
  total: number;
}

export interface TaskError {
  code: string;
  message: string;
  retryable: boolean;
  timestamp: number;
}

export interface TaskResult {
  type: 'success' | 'partial' | 'rolled_back';
  artifacts: string[];
  tokensUsed: { in: number; out: number };
}

export interface UnifiedTask {
  taskId: string;
  title: string;
  description: string;
  agentId?: string;
  threadId?: string;
  goalId: string;
  tier: AgentTier;
  lane: string;
  status: TaskStatus;
  priority: 'high' | 'medium' | 'low';
  progress: TaskProgress;
  dependencies: string[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
  subsystem?: string;
  tags: string[];
}

export interface TaskSummary {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  cancelled: number;
  bySubsystem: Record<string, number>;
  byTier: Record<AgentTier, number>;
}

export interface TaskEvent {
  type: 'task_queued' | 'task_started' | 'task_progress' | 'task_completed' | 'task_failed' | 'task_cancelled' | 'task_paused';
  taskId: string;
  goalId: string;
  agentId?: string;
  progress?: TaskProgress;
  result?: TaskResult;
  error?: TaskError;
  timestamp: number;
}

export type TaskCallback = (event: TaskEvent) => void;

export interface CreateTaskParams {
  goalId: string;
  title: string;
  description: string;
  agentId?: string;
  teamId?: string;
  tier?: AgentTier;
  lane?: string;
  dependencies?: string[];
  priority?: 'high' | 'medium' | 'low';
  subsystem?: string;
  tags?: string[];
}

export interface SyncResult {
  synced: number;
  added: number;
  updated: number;
  removed: number;
  conflicts: string[];
}

interface PluginTaskEntry {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  priority: 'high' | 'medium' | 'low';
  agentId?: string;
  threadId?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  subsystem?: string;
  tags: string[];
  result?: string;
  error?: string;
}

export class UnifiedTaskTree {
  private static instance: UnifiedTaskTree;
  private tasks: Map<string, UnifiedTask> = new Map();
  private goals: Map<string, Set<string>> = new Map();
  private callbacks: Map<string, TaskCallback[]> = new Map();
  private globalCallbacks: TaskCallback[] = [];
  private taskCounter = 0;

  private constructor() {}

  static getInstance(): UnifiedTaskTree {
    if (!UnifiedTaskTree.instance) {
      UnifiedTaskTree.instance = new UnifiedTaskTree();
    }
    return UnifiedTaskTree.instance;
  }

  createTask(params: CreateTaskParams): UnifiedTask {
    const taskId = `task_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const now = Date.now();
    const task: UnifiedTask = {
      taskId,
      goalId: params.goalId,
      title: params.title,
      description: params.description,
      agentId: params.agentId,
      tier: params.tier || 'junior',
      lane: params.lane || 'core',
      status: 'queued',
      priority: params.priority || 'medium',
      progress: { current: 0, total: 0 },
      dependencies: params.dependencies || [],
      createdAt: now,
      subsystem: params.subsystem,
      tags: params.tags || [],
    };

    this.tasks.set(taskId, task);
    if (!this.goals.has(params.goalId)) {
      this.goals.set(params.goalId, new Set());
    }
    this.goals.get(params.goalId)!.add(taskId);
    this.emit({ type: 'task_queued', taskId, goalId: task.goalId, agentId: task.agentId, timestamp: task.createdAt });
    return task;
  }

  getTask(taskId: string): UnifiedTask | undefined {
    return this.tasks.get(taskId);
  }

  getTasksByGoal(goalId: string): UnifiedTask[] {
    const taskIds = this.goals.get(goalId);
    if (!taskIds) return [];
    return [...taskIds].map(id => this.tasks.get(id)).filter(Boolean) as UnifiedTask[];
  }

  getTasksByAgent(agentId: string): UnifiedTask[] {
    return [...this.tasks.values()].filter(t => t.agentId === agentId);
  }

  getTasksByStatus(status: TaskStatus): UnifiedTask[] {
    return [...this.tasks.values()].filter(t => t.status === status);
  }

  getPendingTasks(): UnifiedTask[] {
    return [...this.tasks.values()]
      .filter(t => t.status === 'queued')
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority === 'high' ? 1 : -1;
        return a.createdAt - b.createdAt;
      });
  }

  startTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'queued') return false;
    if (!this.dependenciesMet(taskId)) return false;
    task.status = 'running';
    task.startedAt = Date.now();
    this.emit({ type: 'task_started', taskId, goalId: task.goalId, agentId: task.agentId, timestamp: task.startedAt! });
    return true;
  }

  updateProgress(taskId: string, current: number, total: number): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    task.progress = { current, total };
    this.emit({ type: 'task_progress', taskId, goalId: task.goalId, agentId: task.agentId, progress: task.progress, timestamp: Date.now() });
    return true;
  }

  completeTask(taskId: string, result?: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    task.status = 'completed';
    task.completedAt = Date.now();
    task.result = result;
    task.progress = { current: task.progress.total, total: task.progress.total };
    this.emit({ type: 'task_completed', taskId, goalId: task.goalId, agentId: task.agentId, timestamp: task.completedAt! });
    this.tryStartDependents(task.goalId);
    return true;
  }

  failTask(taskId: string, error: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    task.status = 'failed';
    task.completedAt = Date.now();
    task.error = error;
    this.emit({ type: 'task_failed', taskId, goalId: task.goalId, agentId: task.agentId, error: { code: 'FAILED', message: error, retryable: false, timestamp: task.completedAt! }, timestamp: task.completedAt! });
    return true;
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'completed' || task.status === 'failed') return false;
    task.status = 'cancelled';
    task.completedAt = Date.now();
    this.emit({ type: 'task_cancelled', taskId, goalId: task.goalId, agentId: task.agentId, timestamp: task.completedAt! });
    return true;
  }

  pauseTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    task.status = 'paused';
    this.emit({ type: 'task_paused', taskId, goalId: task.goalId, agentId: task.agentId, timestamp: Date.now() });
    return true;
  }

  getTasksBySubsystem(subsystem: string): UnifiedTask[] {
    return [...this.tasks.values()].filter(t => t.subsystem === subsystem);
  }

  getTaskSummary(): TaskSummary {
    const summary: TaskSummary = {
      total: this.tasks.size,
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      bySubsystem: {},
      byTier: { orchestrator: 0, senior: 0, junior: 0, observer: 0 },
    };

    for (const task of this.tasks.values()) {
      switch (task.status) {
        case 'queued': summary.pending += 1; break;
        case 'running': summary.inProgress += 1; break;
        case 'completed': summary.completed += 1; break;
        case 'failed': summary.failed += 1; break;
        case 'cancelled': summary.cancelled += 1; break;
      }
      if (task.subsystem) {
        summary.bySubsystem[task.subsystem] = (summary.bySubsystem[task.subsystem] ?? 0) + 1;
      }
      summary.byTier[task.tier] += 1;
    }

    return summary;
  }

  syncWithPlugin(pluginTasks: PluginTaskEntry[]): SyncResult {
    const result: SyncResult = { synced: 0, added: 0, updated: 0, removed: 0, conflicts: [] };

    for (const pTask of pluginTasks) {
      const existing = this.tasks.get(pTask.id);
      if (!existing) {
        const serverTask = this.createTask({
          goalId: pTask.subsystem || 'plugin-sync',
          title: pTask.title,
          description: pTask.description,
          agentId: pTask.agentId,
          tier: 'junior',
          priority: pTask.priority,
          subsystem: pTask.subsystem,
          tags: pTask.tags,
        });
        if (pTask.status === 'in_progress') {
          serverTask.status = 'running';
          serverTask.startedAt = pTask.startedAt;
        } else if (pTask.status === 'completed') {
          serverTask.status = 'completed';
          serverTask.completedAt = pTask.completedAt;
          serverTask.result = pTask.result;
        } else if (pTask.status === 'failed') {
          serverTask.status = 'failed';
          serverTask.completedAt = pTask.completedAt;
          serverTask.error = pTask.error;
        }
        result.added++;
      } else {
        if (pTask.status === 'completed' && existing.status === 'running') {
          this.completeTask(pTask.id, pTask.result);
          result.updated++;
        } else if (pTask.status === 'failed' && existing.status === 'running') {
          this.failTask(pTask.id, pTask.error || 'Unknown error');
          result.updated++;
        } else if (pTask.status === 'in_progress' && existing.status === 'queued') {
          this.startTask(pTask.id);
          result.updated++;
        }
      }
      result.synced++;
    }

    return result;
  }

  onEvent(callback: TaskCallback): () => void {
    this.globalCallbacks.push(callback);
    return () => {
      const idx = this.globalCallbacks.indexOf(callback);
      if (idx >= 0) this.globalCallbacks.splice(idx, 1);
    };
  }

  private dependenciesMet(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep || dep.status !== 'completed') return false;
    }
    return true;
  }

  private tryStartDependents(goalId: string): void {
    const tasks = this.getTasksByGoal(goalId);
    for (const task of tasks) {
      if (task.status === 'queued' && this.dependenciesMet(task.taskId)) {
        this.startTask(task.taskId);
      }
    }
  }

  private emit(event: TaskEvent): void {
    const cbs = this.callbacks.get(event.taskId) || [];
    for (const cb of cbs) {
      try { cb(event); } catch { /* ignore */ }
    }
    for (const cb of this.globalCallbacks) {
      try { cb(event); } catch { /* ignore */ }
    }
  }
}

export const unifiedTaskTree = UnifiedTaskTree.getInstance();
