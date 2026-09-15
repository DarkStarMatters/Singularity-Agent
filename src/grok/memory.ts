/**
 * Short conversational memory, per conversation.
 *
 * A bot that answers "and on base?" needs the previous turn. A bot that
 * remembers a week of a busy group needs a database and a privacy policy, and
 * this has neither — so history is deliberately small, in-memory, and forgotten
 * on restart.
 *
 * Two independent limits, because they fail differently: `maxTurns` bounds the
 * prompt sent to xAI (cost, and the model losing the thread), while `ttlMs`
 * bounds how long a stale conversation keeps occupying memory in a process that
 * may sit in a hundred groups.
 */
import type { ChatMessage } from './client.js';

export interface MemoryOptions {
  /** Messages retained per conversation, oldest dropped first. */
  maxTurns?: number;
  /** A conversation untouched for this long is dropped entirely. */
  ttlMs?: number;
  /** Conversations tracked at once, least-recently-used evicted. */
  maxConversations?: number;
}

interface Entry {
  messages: ChatMessage[];
  touchedAt: number;
}

export class ConversationMemory {
  private readonly entries = new Map<string, Entry>();
  private readonly maxTurns: number;
  private readonly ttlMs: number;
  private readonly maxConversations: number;

  constructor(options: MemoryOptions = {}) {
    this.maxTurns = options.maxTurns ?? 12;
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1_000;
    this.maxConversations = options.maxConversations ?? 500;
  }

  get(key: string, now = Date.now()): ChatMessage[] {
    const entry = this.entries.get(key);
    if (!entry) return [];

    if (now - entry.touchedAt > this.ttlMs) {
      this.entries.delete(key);
      return [];
    }
    return entry.messages;
  }

  append(key: string, messages: ChatMessage[], now = Date.now()): void {
    const existing = this.get(key, now);
    const combined = [...existing, ...messages];

    this.entries.delete(key);
    this.entries.set(key, { messages: this.trim(combined), touchedAt: now });

    this.evict(now);
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Drops the oldest turns, but never leaves a `tool` message at the front:
   * a tool result whose assistant tool-call turn has been trimmed away is a
   * dangling reference, and xAI rejects the whole request for it.
   */
  private trim(messages: ChatMessage[]): ChatMessage[] {
    if (messages.length <= this.maxTurns) return messages;

    let start = messages.length - this.maxTurns;
    while (start < messages.length && messages[start]!.role === 'tool') start++;

    return messages.slice(start);
  }

  /** Map iteration is insertion-ordered, and `append` re-inserts on write. */
  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.touchedAt > this.ttlMs) this.entries.delete(key);
    }

    while (this.entries.size > this.maxConversations) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
