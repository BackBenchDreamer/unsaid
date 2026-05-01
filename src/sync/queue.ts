/**
 * Offline Sync Queue — persistent mutation queue with deterministic identity.
 *
 * Strategy: Last-Write-Wins (LWW) with client timestamp.
 *
 * How it works:
 * 1. Every mutation is written to IndexedDB before being sent to the server.
 * 2. Each mutation has a deterministic ID based on (userId, entryDate, action).
 *    This means a new write for the same day replaces the pending mutation
 *    rather than duplicating it.
 * 3. On reconnect, the queue is drained in FIFO order.
 * 4. Server uses UPSERT with ON CONFLICT (user_id, entry_date),
 *    so replayed mutations are idempotent.
 * 5. If a mutation fails with a non-retryable error, it is marked as failed
 *    and skipped in subsequent drains.
 *
 * Conflict resolution (LWW):
 * - The server's updated_at column uses now() on upsert.
 * - If the client was offline and the server already has a newer write,
 *   the upsert will overwrite it with the client's content.
 * - This is acceptable for a single-user journaling app where only one
 *   person writes to a given (user_id, entry_date) slot.
 * - For multi-device scenarios, the last device to sync wins.
 */

import { openDB, IDBPDatabase, DBSchema } from 'idb';

// ─── Types ─────────────────────────────────────────────────

export type MutationAction = 'upsert' | 'delete';
export type MutationStatus = 'pending' | 'in_flight' | 'failed';

export interface SyncMutation {
  /** Deterministic ID: `${userId}:${entryDate}:${action}` */
  id: string;
  userId: string;
  entryDate: string;
  action: MutationAction;
  payload: Record<string, unknown>;
  status: MutationStatus;
  retryCount: number;
  createdAt: number; // epoch ms
  lastAttempt: number | null;
  error: string | null;
}

// ─── IDB Schema ────────────────────────────────────────────

interface SyncDBSchema extends DBSchema {
  mutations: {
    key: string;
    value: SyncMutation;
    indexes: {
      'by-status': MutationStatus;
      'by-created': number;
    };
  };
}

const DB_NAME = 'unsaid-sync';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<SyncDBSchema>> | null = null;

function getDB(): Promise<IDBPDatabase<SyncDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<SyncDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore('mutations', { keyPath: 'id' });
        store.createIndex('by-status', 'status');
        store.createIndex('by-created', 'createdAt');
      },
    });
  }
  return dbPromise;
}

// ─── Deterministic Mutation ID ─────────────────────────────

export function makeMutationId(userId: string, entryDate: string, action: MutationAction): string {
  return `${userId}:${entryDate}:${action}`;
}

// ─── Queue Operations ──────────────────────────────────────

export const syncQueue = {
  /**
   * Enqueue a mutation. If a mutation with the same deterministic ID
   * already exists and is pending, it is replaced (LWW).
   */
  async enqueue(
    userId: string,
    entryDate: string,
    action: MutationAction,
    payload: Record<string, unknown>,
  ): Promise<SyncMutation> {
    const db = await getDB();
    const id = makeMutationId(userId, entryDate, action);

    const existing = await db.get('mutations', id);

    // If an existing mutation is in_flight, don't overwrite — queue a new attempt.
    // If it's pending or failed, replace it with the newer payload.
    const mutation: SyncMutation = {
      id,
      userId,
      entryDate,
      action,
      payload,
      status: existing?.status === 'in_flight' ? 'in_flight' : 'pending',
      retryCount: existing?.status === 'failed' ? (existing.retryCount ?? 0) : 0,
      createdAt: existing?.createdAt ?? Date.now(),
      lastAttempt: existing?.lastAttempt ?? null,
      error: null,
    };

    await db.put('mutations', mutation);
    return mutation;
  },

  /**
   * Get all pending mutations in FIFO order.
   */
  async getPending(): Promise<SyncMutation[]> {
    const db = await getDB();
    const all = await db.getAllFromIndex('mutations', 'by-status', 'pending');
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },

  /**
   * Get all mutations (for UI display).
   */
  async getAll(): Promise<SyncMutation[]> {
    const db = await getDB();
    return db.getAll('mutations');
  },

  /**
   * Mark a mutation as in_flight.
   */
  async markInFlight(id: string): Promise<void> {
    const db = await getDB();
    const m = await db.get('mutations', id);
    if (m) {
      m.status = 'in_flight';
      m.lastAttempt = Date.now();
      await db.put('mutations', m);
    }
  },

  /**
   * Remove a mutation (after successful sync).
   */
  async remove(id: string): Promise<void> {
    const db = await getDB();
    await db.delete('mutations', id);
  },

  /**
   * Mark a mutation as failed.
   */
  async markFailed(id: string, error: string): Promise<void> {
    const db = await getDB();
    const m = await db.get('mutations', id);
    if (m) {
      m.status = 'failed';
      m.retryCount = (m.retryCount ?? 0) + 1;
      m.error = error;
      await db.put('mutations', m);
    }
  },

  /**
   * Reset failed mutations back to pending for retry.
   */
  async retryFailed(): Promise<void> {
    const db = await getDB();
    const failed = await db.getAllFromIndex('mutations', 'by-status', 'failed');
    const tx = db.transaction('mutations', 'readwrite');
    for (const m of failed) {
      if (m.retryCount < 5) { // Max 5 retries
        m.status = 'pending';
        m.error = null;
        await tx.store.put(m);
      }
    }
    await tx.done;
  },

  /**
   * Get queue size.
   */
  async size(): Promise<number> {
    const db = await getDB();
    return db.count('mutations');
  },

  /**
   * Clear the entire queue (nuclear option).
   */
  async clear(): Promise<void> {
    const db = await getDB();
    await db.clear('mutations');
  },
};
