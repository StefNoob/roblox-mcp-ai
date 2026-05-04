import { v4 as uuidv4 } from 'uuid';
import type { ChatMessage } from '../agents/types.js';

export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'error';

export interface AgentThreadInfo {
  threadId: string;
  agentId: string;
  status: 'active' | 'paused' | 'stopped';
  messageCount: number;
  createdAt: number;
  lastActivityAt: number;
}

export interface ChatDeliveryResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface UnifiedChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  timestamp: number;
  tokensIn?: number;
  tokensOut?: number;
  toolCallId?: string;
  toolName?: string;
}

export interface ThreadSubscription {
  threadId: string;
  participants: string[];
  muted: boolean;
  createdAt: number;
  lastMessageAt: number;
  unreadCount: number;
}

export class UnifiedChatBridge {
  private static instance: UnifiedChatBridge;
  private threads: Map<string, AgentThreadInfo> = new Map();
  private messages: Map<string, UnifiedChatMessage[]> = new Map();
  private subscriptions: Map<string, ThreadSubscription> = new Map();
  private globalCallbacks: Array<(message: UnifiedChatMessage, threadId: string) => void> = [];

  private constructor() {}

  static getInstance(): UnifiedChatBridge {
    if (!UnifiedChatBridge.instance) {
      UnifiedChatBridge.instance = new UnifiedChatBridge();
    }
    return UnifiedChatBridge.instance;
  }

  createThread(agentId: string, subsystem?: string): AgentThreadInfo {
    const threadId = `thread_${agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const info: AgentThreadInfo = {
      threadId,
      agentId,
      status: 'active',
      messageCount: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    this.threads.set(threadId, info);

    const subscription: ThreadSubscription = {
      threadId,
      participants: [agentId],
      muted: false,
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      unreadCount: 0,
    };
    this.subscriptions.set(threadId, subscription);

    this.messages.set(threadId, []);

    return info;
  }

  getThread(threadId: string): AgentThreadInfo | undefined {
    return this.threads.get(threadId);
  }

  getAllThreads(): AgentThreadInfo[] {
    return [...this.threads.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  getThreadsByAgent(agentId: string): AgentThreadInfo[] {
    return this.getAllThreads().filter(t => t.agentId === agentId);
  }

  subscribeToThread(threadId: string, participantId: string): boolean {
    const sub = this.subscriptions.get(threadId);
    if (!sub) return false;
    if (!sub.participants.includes(participantId)) {
      sub.participants.push(participantId);
    }
    return true;
  }

  unsubscribeFromThread(threadId: string, participantId: string): boolean {
    const sub = this.subscriptions.get(threadId);
    if (!sub) return false;
    const idx = sub.participants.indexOf(participantId);
    if (idx >= 0) {
      sub.participants.splice(idx, 1);
      return true;
    }
    return false;
  }

  sendMessage(
    threadId: string,
    role: ChatMessageRole,
    content: string,
    tokensIn?: number,
    tokensOut?: number,
  ): UnifiedChatMessage | null {
    const thread = this.threads.get(threadId);
    if (!thread) return null;

    const sub = this.subscriptions.get(threadId);
    if (sub?.muted) return null;

    const message: UnifiedChatMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role,
      content,
      timestamp: Date.now(),
      tokensIn,
      tokensOut,
    };

    const threadMessages = this.messages.get(threadId) || [];
    threadMessages.push(message);
    if (threadMessages.length > 100) {
      threadMessages.shift();
    }
    this.messages.set(threadId, threadMessages);

    thread.messageCount += 1;
    thread.lastActivityAt = Date.now();

    if (sub) {
      sub.lastMessageAt = Date.now();
    }

    for (const cb of this.globalCallbacks) {
      try { cb(message, threadId); } catch { /* ignore */ }
    }

    return message;
  }

  getMessages(threadId: string, limit?: number): UnifiedChatMessage[] {
    const messages = this.messages.get(threadId) || [];
    const max = limit ?? 100;
    return messages.slice(-max);
  }

  markAsRead(threadId: string, participantId?: string): void {
    const sub = this.subscriptions.get(threadId);
    if (sub) {
      sub.unreadCount = 0;
    }
  }

  getUnreadCount(threadId: string): number {
    const sub = this.subscriptions.get(threadId);
    return sub?.unreadCount ?? 0;
  }

  muteThread(threadId: string, muted: boolean): boolean {
    const sub = this.subscriptions.get(threadId);
    if (!sub) return false;
    sub.muted = muted;
    return true;
  }

  getSubscription(threadId: string): ThreadSubscription | undefined {
    return this.subscriptions.get(threadId);
  }

  onMessage(callback: (message: UnifiedChatMessage, threadId: string) => void): () => void {
    this.globalCallbacks.push(callback);
    return () => {
      const idx = this.globalCallbacks.indexOf(callback);
      if (idx >= 0) this.globalCallbacks.splice(idx, 1);
    };
  }

  clearOldThreads(maxAgeMs: number = 3600000): number {
    const now = Date.now();
    let cleared = 0;
    const toRemove: string[] = [];

    this.threads.forEach((info, threadId) => {
      if (now - info.lastActivityAt > maxAgeMs && info.status === 'stopped') {
        toRemove.push(threadId);
      }
    });

    for (const threadId of toRemove) {
      this.threads.delete(threadId);
      this.subscriptions.delete(threadId);
      this.messages.delete(threadId);
      cleared += 1;
    }

    return cleared;
  }

  getStats() {
    let totalMessages = 0;
    for (const msgs of this.messages.values()) {
      totalMessages += msgs.length;
    }
    return {
      totalThreads: this.threads.size,
      totalMessages,
      totalSubscriptions: this.subscriptions.size,
    };
  }
}

export const unifiedChatBridge = UnifiedChatBridge.getInstance();
