import State from "./State";
import { AgentStatusType } from "../types";

export interface TaskEntry {
	id: string;
	title: string;
	description: string;
	status: "pending" | "in_progress" | "completed" | "failed";
	priority: "high" | "medium" | "low";
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

export interface TaskSummary {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
	failed: number;
	bySubsystem: Record<string, number>;
}

const MAX_PERSISTENT_TASKS = 200;
const taskHistory: TaskEntry[] = [];
const taskById = new Map<string, TaskEntry>();
let taskCounter = 0;

function generateTaskId(): string {
	taskCounter += 1;
	return `task_${taskCounter}_${tick()}`;
}

function addTask(
	title: string,
	description: string,
	options?: {
		priority?: "high" | "medium" | "low";
		subsystem?: string;
		tags?: string[];
		agentId?: string;
		threadId?: string;
	},
): TaskEntry {
	const task: TaskEntry = {
		id: generateTaskId(),
		title,
		description,
		status: "pending",
		priority: options?.priority ?? "medium",
		agentId: options?.agentId,
		threadId: options?.threadId,
		createdAt: tick(),
		subsystem: options?.subsystem,
		tags: options?.tags ?? [],
	};

	taskHistory.unshift(task);
	taskById.set(task.id, task);

	if (taskHistory.size() > MAX_PERSISTENT_TASKS) {
		const removed = taskHistory.pop();
		if (removed) {
			taskById.delete(removed.id);
		}
	}

	State.addActivity("info", "system", `Task created: ${title}`, task.id, {
		groupKey: "task-created",
	});

	return task;
}

function startTask(taskId: string): TaskEntry | undefined {
	const task = taskById.get(taskId);
	if (!task) return undefined;

	task.status = "in_progress";
	task.startedAt = tick();

	State.addActivity("info", "system", `Task started: ${task.title}`, task.id, {
		groupKey: "task-started",
	});

	return task;
}

function completeTask(taskId: string, result?: string): TaskEntry | undefined {
	const task = taskById.get(taskId);
	if (!task) return undefined;

	task.status = "completed";
	task.completedAt = tick();
	task.result = result;

	State.addActivity("success", "system", `Task completed: ${task.title}`, task.id, {
		groupKey: "task-completed",
	});

	return task;
}

function failTask(taskId: string, error: string): TaskEntry | undefined {
	const task = taskById.get(taskId);
	if (!task) return undefined;

	task.status = "failed";
	task.completedAt = tick();
	task.error = error;

	State.addActivity("error", "system", `Task failed: ${task.title}`, task.id, {
		groupKey: "task-failed",
	});

	return task;
}

function getTask(taskId: string): TaskEntry | undefined {
	return taskById.get(taskId);
}

function getTasks(filter?: {
	status?: TaskEntry["status"];
	subsystem?: string;
	agentId?: string;
	priority?: TaskEntry["priority"];
	limit?: number;
}): TaskEntry[] {
	let results = [...taskHistory];

	if (filter?.status) {
		results = results.filter((t) => t.status === filter.status);
	}
	if (filter?.subsystem) {
		results = results.filter((t) => t.subsystem === filter.subsystem);
	}
	if (filter?.agentId) {
		results = results.filter((t) => t.agentId === filter.agentId);
	}
	if (filter?.priority) {
		results = results.filter((t) => t.priority === filter.priority);
	}

	const limit = filter?.limit ?? 50;
	const result: TaskEntry[] = [];
	for (let i = 0; i < math.min(limit, results.size()); i++) {
		result.push(results[i]);
	}
	return result;
}

function getTaskSummary(): TaskSummary {
	const summary: TaskSummary = {
		total: taskHistory.size(),
		pending: 0,
		inProgress: 0,
		completed: 0,
		failed: 0,
		bySubsystem: {},
	};

	for (const task of taskHistory) {
		switch (task.status) {
			case "pending":
				summary.pending += 1;
				break;
			case "in_progress":
				summary.inProgress += 1;
				break;
			case "completed":
				summary.completed += 1;
				break;
			case "failed":
				summary.failed += 1;
				break;
		}

		if (task.subsystem) {
			summary.bySubsystem[task.subsystem] = (summary.bySubsystem[task.subsystem] ?? 0) + 1;
		}
	}

	return summary;
}

function getRecentTasks(limit: number = 10): TaskEntry[] {
	const result: TaskEntry[] = [];
	for (let i = 0; i < math.min(limit, taskHistory.size()); i++) {
		result.push(taskHistory[i]);
	}
	return result;
}

function getTasksBySubsystem(subsystem: string): TaskEntry[] {
	return taskHistory.filter((t) => t.subsystem === subsystem);
}

function getTasksByAgent(agentId: string): TaskEntry[] {
	return taskHistory.filter((t) => t.agentId === agentId);
}

function clearCompletedTasks(): number {
	let cleared = 0;
	const toRemove: TaskEntry[] = [];

	for (const task of taskHistory) {
		if (task.status === "completed") {
			toRemove.push(task);
		}
	}

	for (const task of toRemove) {
		const idx = taskHistory.indexOf(task);
		if (idx >= 0) {
			taskHistory.remove(idx);
			taskById.delete(task.id);
			cleared += 1;
		}
	}

	return cleared;
}

function cancelTask(taskId: string): boolean {
	const task = taskById.get(taskId);
	if (!task) return false;

	if (task.status === "pending") {
		task.status = "failed";
		task.completedAt = tick();
		task.error = "Cancelled by user";
		return true;
	}

	return false;
}

function restoreTasksFromConnection(threadId: string): TaskEntry[] {
	return taskHistory.filter(
		(t) => t.threadId === threadId && (t.status === "pending" || t.status === "in_progress"),
	);
}

export = {
	addTask,
	startTask,
	completeTask,
	failTask,
	getTask,
	getTasks,
	getTaskSummary,
	getRecentTasks,
	getTasksBySubsystem,
	getTasksByAgent,
	clearCompletedTasks,
	cancelTask,
	restoreTasksFromConnection,
};