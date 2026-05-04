import State from "./State";
import { AgentChatResponse, AgentThreadInfo, ChatMessage, ChatMessageRole } from "../types";

export interface ChatSubscription {
	threadId: string;
	participants: string[];
	subsystem?: string;
	muted: boolean;
	createdAt: number;
	lastMessageAt: number;
	unreadCount: number;
}

export interface TeamChannel {
	teamId: string;
	name: string;
	subscriptions: string[];
	members: string[];
	createdAt: number;
}

export interface ChatDeliveryResult {
	success: boolean;
	messageId?: string;
	error?: string;
}

const MAX_MESSAGES_PER_THREAD = 100;
let chatHubInitialized = false;
let subscriptions = new Map<string, ChatSubscription>();
let teamChannels = new Map<string, TeamChannel>();
let threadInfoMap = new Map<string, AgentThreadInfo>();
let unreadBySubscription = new Map<string, number>();

function generateMessageId(): string {
	return `msg_${tick()}_${math.random(1000, 9999)}`;
}

function createThread(agentId: string, subsystem?: string): AgentThreadInfo {
	const threadId = `thread_${agentId}_${tick()}`;
	const info: AgentThreadInfo = {
		threadId,
		agentId,
		status: "active",
		messageCount: 0,
		createdAt: tick(),
		lastActivityAt: tick(),
	};
	threadInfoMap.set(threadId, info);

	State.setActiveThreadId(threadId);

	const subscription: ChatSubscription = {
		threadId,
		participants: [agentId],
		subsystem,
		muted: false,
		createdAt: tick(),
		lastMessageAt: tick(),
		unreadCount: 0,
	};
	subscriptions.set(threadId, subscription);

	return info;
}

function subscribeToThread(threadId: string, participantId: string): boolean {
	const sub = subscriptions.get(threadId);
	if (!sub) return false;

	if (!sub.participants.includes(participantId)) {
		sub.participants.push(participantId);
	}

	unreadBySubscription.set(threadId, unreadBySubscription.get(threadId) ?? 0);
	return true;
}

function unsubscribeFromThread(threadId: string, participantId: string): boolean {
	const sub = subscriptions.get(threadId);
	if (!sub) return false;

	const idx = sub.participants.indexOf(participantId);
	if (idx >= 0) {
		sub.participants.remove(idx);
		return true;
	}
	return false;
}

function sendMessage(
	threadId: string,
	role: ChatMessageRole,
	content: string,
	tokensIn?: number,
	tokensOut?: number,
): ChatDeliveryResult {
	const sub = subscriptions.get(threadId);
	if (!sub) {
		return { success: false, error: "Thread not found" };
	}

	if (sub.muted) {
		return { success: false, error: "Thread is muted" };
	}

	const message: ChatMessage = {
		id: generateMessageId(),
		role,
		content,
		timestamp: tick(),
		tokensIn,
		tokensOut,
	};

	State.addAgentChatMessage(threadId, message);
	sub.lastMessageAt = tick();

	const threadInfo = threadInfoMap.get(threadId);
	if (threadInfo) {
		threadInfo.messageCount += 1;
		threadInfo.lastActivityAt = tick();
	}

	for (const participant of sub.participants) {
		if (participant !== State.getActiveThreadId()) {
			const current = unreadBySubscription.get(threadId) ?? 0;
			unreadBySubscription.set(threadId, current + 1);
		}
	}

	return { success: true, messageId: message.id };
}

function getMessages(threadId: string, limit?: number): ChatMessage[] {
	const messages = State.getAgentChatMessages(threadId);
	const max = limit ?? MAX_MESSAGES_PER_THREAD;
	return messages.slice(-max);
}

function markAsRead(threadId: string): void {
	unreadBySubscription.set(threadId, 0);
	const sub = subscriptions.get(threadId);
	if (sub) {
		sub.unreadCount = 0;
	}
}

function getUnreadCount(threadId: string): number {
	return unreadBySubscription.get(threadId) ?? 0;
}

function muteThread(threadId: string, muted: boolean): boolean {
	const sub = subscriptions.get(threadId);
	if (!sub) return false;
	sub.muted = muted;
	return true;
}

function createTeamChannel(teamId: string, name: string, members: string[]): TeamChannel {
	const channel: TeamChannel = {
		teamId,
		name,
		subscriptions: [],
		members,
		createdAt: tick(),
	};
	teamChannels.set(teamId, channel);
	return channel;
}

function addThreadToTeam(teamId: string, threadId: string): boolean {
	const channel = teamChannels.get(teamId);
	if (!channel) return false;

	if (!channel.subscriptions.includes(threadId)) {
		channel.subscriptions.push(threadId);
	}
	return true;
}

function getTeamChannel(teamId: string): TeamChannel | undefined {
	return teamChannels.get(teamId);
}

function getThreadsForAgent(agentId: string): AgentThreadInfo[] {
	const result: AgentThreadInfo[] = [];
	threadInfoMap.forEach((info) => {
		if (info.agentId === agentId) {
			result.push(info);
		}
	});
	return result;
}

function getActiveSubscriptions(): ChatSubscription[] {
	const result: ChatSubscription[] = [];
	subscriptions.forEach((sub) => {
		if (!sub.muted) {
			result.push(sub);
		}
	});
	return result;
}

function getSubscription(threadId: string): ChatSubscription | undefined {
	return subscriptions.get(threadId);
}

function processAgentResponse(response: AgentChatResponse): ChatDeliveryResult {
	if (!response.success) {
		return { success: false, error: response.response };
	}

	const threadId = response.threadId;
	return sendMessage(threadId, "assistant", response.response, response.tokensIn, response.tokensOut);
}

function broadcastToTeam(teamId: string, role: ChatMessageRole, content: string): ChatDeliveryResult[] {
	const channel = teamChannels.get(teamId);
	if (!channel) return [];

	const results: ChatDeliveryResult[] = [];
	for (const threadId of channel.subscriptions) {
		results.push(sendMessage(threadId, role, content));
	}
	return results;
}

function clearOldThreads(maxAgeSeconds: number = 3600): number {
	let cleared = 0;
	const now = tick();
	const toRemove: string[] = [];

	threadInfoMap.forEach((info, threadId) => {
		if (now - info.lastActivityAt > maxAgeSeconds && info.status === "stopped") {
			toRemove.push(threadId);
		}
	});

	for (const threadId of toRemove) {
		threadInfoMap.delete(threadId);
		subscriptions.delete(threadId);
		unreadBySubscription.delete(threadId);
		cleared += 1;
	}

	return cleared;
}

function init(): void {
	if (chatHubInitialized) return;
	chatHubInitialized = true;
}

function shutdown(): void {
	subscriptions.clear();
	teamChannels.clear();
	threadInfoMap.clear();
	unreadBySubscription.clear();
	chatHubInitialized = false;
}

export = {
	init,
	shutdown,
	createThread,
	subscribeToThread,
	unsubscribeFromThread,
	sendMessage,
	getMessages,
	markAsRead,
	getUnreadCount,
	muteThread,
	createTeamChannel,
	addThreadToTeam,
	getTeamChannel,
	getThreadsForAgent,
	getActiveSubscriptions,
	getSubscription,
	processAgentResponse,
	broadcastToTeam,
	clearOldThreads,
};