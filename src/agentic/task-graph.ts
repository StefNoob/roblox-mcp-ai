import { v4 as uuidv4 } from 'uuid';

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

export interface AITask {
  taskId: string;
  goalId: string;
  description: string;
  agentId: string;
  teamId: string;
  lane: string;
  status: TaskStatus;
  progress: TaskProgress;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: TaskResult;
  errors: TaskError[];
  dependencies: string[];
  priority: number;
}

export type TaskEventType =
  | 'task_queued'
  | 'task_started'
  | 'task_progress'
  | 'task_completed'
  | 'task_failed'
  | 'task_cancelled';

export interface TaskEvent {
  type: TaskEventType;
  taskId: string;
  goalId: string;
  agentId: string;
  progress?: TaskProgress;
  result?: TaskResult;
  error?: TaskError;
  timestamp: number;
}

export type TaskCallback = (event: TaskEvent) => void;

export class TaskGraph {
  private tasks: Map<string, AITask> = new Map();
  private goals: Map<string, Set<string>> = new Map();
  private callbacks: Map<string, TaskCallback[]> = new Map();
  private globalCallbacks: TaskCallback[] = [];

  createTask(params: {
    goalId: string;
    description: string;
    agentId: string;
    teamId: string;
    lane: string;
    dependencies?: string[];
    priority?: number;
  }): AITask {
    const task: AITask = {
      taskId: `task_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
      goalId: params.goalId,
      description: params.description,
      agentId: params.agentId,
      teamId: params.teamId,
      lane: params.lane,
      status: 'queued',
      progress: { current: 0, total: 0 },
      createdAt: Date.now(),
      errors: [],
      dependencies: params.dependencies ?? [],
      priority: params.priority ?? 0,
    };
    this.tasks.set(task.taskId, task);
    if (!this.goals.has(params.goalId)) {
      this.goals.set(params.goalId, new Set());
    }
    this.goals.get(params.goalId)!.add(task.taskId);
    this.emit({ type: 'task_queued', taskId: task.taskId, goalId: task.goalId, agentId: task.agentId, timestamp: task.createdAt });
    return task;
  }

  getTask(taskId: string): AITask | undefined {
    return this.tasks.get(taskId);
  }

  getTasksByGoal(goalId: string): AITask[] {
    const taskIds = this.goals.get(goalId);
    if (!taskIds) return [];
    return [...taskIds].map(id => this.tasks.get(id)).filter(Boolean) as AITask[];
  }

  getTasksByAgent(agentId: string): AITask[] {
    return [...this.tasks.values()].filter(t => t.agentId === agentId);
  }

  getTasksByStatus(status: TaskStatus): AITask[] {
    return [...this.tasks.values()].filter(t => t.status === status);
  }

  getPendingTasks(): AITask[] {
    return [...this.tasks.values()]
      .filter(t => t.status === 'queued')
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.createdAt - b.createdAt;
      });
  }

  startTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'queued') return false;
    if (!this.dependenciesMet(taskId)) return false;
    task.status = 'running';
    task.startedAt = Date.now();
    this.emit({ type: 'task_started', taskId: task.taskId, goalId: task.goalId, agentId: task.agentId, timestamp: task.startedAt });
    return true;
  }

  updateProgress(taskId: string, current: number, total: number): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    task.progress = { current, total };
    this.emit({ type: 'task_progress', taskId, goalId: task.goalId, agentId: task.agentId, progress: task.progress, timestamp: Date.now() });
    return true;
  }

  completeTask(taskId: string, result: TaskResult): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    task.status = 'completed';
    task.completedAt = Date.now();
    task.result = result;
    task.progress = { current: task.progress.total, total: task.progress.total };
    this.emit({ type: 'task_completed', taskId, goalId: task.goalId, agentId: task.agentId, result, timestamp: task.completedAt });
    this.tryStartDependents(task.goalId);
    return true;
  }

  failTask(taskId: string, error: TaskError): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    task.status = 'failed';
    task.completedAt = Date.now();
    task.errors.push(error);
    this.emit({ type: 'task_failed', taskId, goalId: task.goalId, agentId: task.agentId, error, timestamp: task.completedAt });
    return true;
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'completed' || task.status === 'failed') return false;
    task.status = 'cancelled';
    task.completedAt = Date.now();
    this.emit({ type: 'task_cancelled', taskId, goalId: task.goalId, agentId: task.agentId, timestamp: task.completedAt });
    return true;
  }

  pauseTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    task.status = 'paused';
    this.emit({ type: 'task_cancelled', taskId, goalId: task.goalId, agentId: task.agentId, timestamp: Date.now() });
    return true;
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

  onEvent(callback: TaskCallback): () => void {
    this.globalCallbacks.push(callback);
    return () => {
      const idx = this.globalCallbacks.indexOf(callback);
      if (idx >= 0) this.globalCallbacks.splice(idx, 1);
    };
  }

  onEventForTask(taskId: string, callback: TaskCallback): () => void {
    const existing = this.callbacks.get(taskId) || [];
    existing.push(callback);
    this.callbacks.set(taskId, existing);
    return () => {
      const cbs = this.callbacks.get(taskId) || [];
      this.callbacks.set(taskId, cbs.filter(cb => cb !== callback));
    };
  }

  private emit(event: TaskEvent) {
    const cbs = this.callbacks.get(event.taskId) || [];
    for (const cb of cbs) {
      try { cb(event); } catch { /* ignore */ }
    }
    for (const cb of this.globalCallbacks) {
      try { cb(event); } catch { /* ignore */ }
    }
  }

  getStats() {
    const all = [...this.tasks.values()];
    return {
      total: all.length,
      queued: all.filter(t => t.status === 'queued').length,
      running: all.filter(t => t.status === 'running').length,
      paused: all.filter(t => t.status === 'paused').length,
      completed: all.filter(t => t.status === 'completed').length,
      failed: all.filter(t => t.status === 'failed').length,
      cancelled: all.filter(t => t.status === 'cancelled').length,
    };
  }
}
