import TaskHistory from "../TaskHistory";

function createTask(requestData: Record<string, unknown>) {
	const title = (requestData.title as string) ?? "Untitled Task";
	const description = (requestData.description as string) ?? "";
	const priority = requestData.priority as "high" | "medium" | "low" | undefined;
	const subsystem = requestData.subsystem as string | undefined;
	const tags = requestData.tags as string[] | undefined;
	const agentId = requestData.agentId as string | undefined;
	const threadId = requestData.threadId as string | undefined;

	const task = TaskHistory.addTask(title, description, {
		priority,
		subsystem,
		tags,
		agentId,
		threadId,
	});

	return {
		success: true,
		task,
		timestamp: tick(),
	};
}

function startTask(requestData: Record<string, unknown>) {
	const taskId = requestData.taskId as string;

	if (!taskId) {
		return { success: false, error: "taskId is required" };
	}

	const task = TaskHistory.startTask(taskId);
	if (!task) {
		return { success: false, error: "Task not found" };
	}

	return {
		success: true,
		task,
		timestamp: tick(),
	};
}

function completeTask(requestData: Record<string, unknown>) {
	const taskId = requestData.taskId as string;
	const result = requestData.result as string | undefined;

	if (!taskId) {
		return { success: false, error: "taskId is required" };
	}

	const task = TaskHistory.completeTask(taskId, result);
	if (!task) {
		return { success: false, error: "Task not found" };
	}

	return {
		success: true,
		task,
		timestamp: tick(),
	};
}

function failTask(requestData: Record<string, unknown>) {
	const taskId = requestData.taskId as string;
	const error = (requestData.error as string) ?? "Unknown error";

	if (!taskId) {
		return { success: false, error: "taskId is required" };
	}

	const task = TaskHistory.failTask(taskId, error);
	if (!task) {
		return { success: false, error: "Task not found" };
	}

	return {
		success: true,
		task,
		timestamp: tick(),
	};
}

function getTask(requestData: Record<string, unknown>) {
	const taskId = requestData.taskId as string;

	if (!taskId) {
		return { success: false, error: "taskId is required" };
	}

	const task = TaskHistory.getTask(taskId);
	if (!task) {
		return { success: false, error: "Task not found" };
	}

	return {
		success: true,
		task,
		timestamp: tick(),
	};
}

function getTasks(requestData: Record<string, unknown>) {
	const filter = {
		status: requestData.status as "pending" | "in_progress" | "completed" | "failed" | undefined,
		subsystem: requestData.subsystem as string | undefined,
		agentId: requestData.agentId as string | undefined,
		priority: requestData.priority as "high" | "medium" | "low" | undefined,
		limit: requestData.limit as number | undefined,
	};

	const tasks = TaskHistory.getTasks(filter);

	return {
		tasks,
		count: tasks.size(),
		timestamp: tick(),
	};
}

function getTaskSummary(_requestData: Record<string, unknown>) {
	const summary = TaskHistory.getTaskSummary();

	return {
		...summary,
		timestamp: tick(),
	};
}

function getRecentTasks(requestData: Record<string, unknown>) {
	const limit = (requestData.limit as number) ?? 10;

	const tasks = TaskHistory.getRecentTasks(limit);

	return {
		tasks,
		count: tasks.size(),
		timestamp: tick(),
	};
}

function getTasksBySubsystem(requestData: Record<string, unknown>) {
	const subsystem = requestData.subsystem as string;

	if (!subsystem) {
		return { success: false, error: "subsystem is required" };
	}

	const tasks = TaskHistory.getTasksBySubsystem(subsystem);

	return {
		tasks,
		count: tasks.size(),
		timestamp: tick(),
	};
}

function getTasksByAgent(requestData: Record<string, unknown>) {
	const agentId = requestData.agentId as string;

	if (!agentId) {
		return { success: false, error: "agentId is required" };
	}

	const tasks = TaskHistory.getTasksByAgent(agentId);

	return {
		tasks,
		count: tasks.size(),
		timestamp: tick(),
	};
}

function clearCompletedTasks(_requestData: Record<string, unknown>) {
	const cleared = TaskHistory.clearCompletedTasks();

	return {
		success: true,
		cleared,
		timestamp: tick(),
	};
}

function cancelTask(requestData: Record<string, unknown>) {
	const taskId = requestData.taskId as string;

	if (!taskId) {
		return { success: false, error: "taskId is required" };
	}

	const success = TaskHistory.cancelTask(taskId);

	return {
		success,
		timestamp: tick(),
	};
}

export = {
	createTask,
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
};