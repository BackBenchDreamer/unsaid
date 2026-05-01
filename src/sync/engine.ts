/**
 * Sync Engine — drains the mutation queue and pushes to Supabase.
 *
 * Listens for:
 * - online/offline events
 * - explicit flush requests
 * - periodic polling
 *
 * Each mutation is processed idempotently via UPSERT.
 */

import { syncQueue, SyncMutation } from './queue';
import { journalService } from '../services/journalService';
import { EntryUpsertPayload } from '../entities/entry';

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

type SyncListener = (status: SyncStatus, pendingCount: number) => void;

class SyncEngine {
  private status: SyncStatus = 'idle';
  private listeners: Set<SyncListener> = new Set();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isSyncing = false;

  /**
   * Start the sync engine — listen for online/offline, start periodic drain.
   */
  start(): void {
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);

    if (!navigator.onLine) {
      this.setStatus('offline');
    }

    // Poll every 30 seconds while online.
    this.intervalId = setInterval(() => {
      if (navigator.onLine) {
        this.flush();
      }
    }, 30_000);
  }

  /**
   * Stop the sync engine.
   */
  stop(): void {
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Subscribe to sync status changes.
   */
  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Get current status.
   */
  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * Enqueue a journal entry mutation and attempt immediate flush.
   */
  async enqueueEntry(userId: string, payload: EntryUpsertPayload): Promise<void> {
    await syncQueue.enqueue(userId, payload.entryDate, 'upsert', {
      content: payload.content,
      mood: payload.mood,
      tags: payload.tags,
    });
    this.notifyListeners();

    // Try immediate flush if online.
    if (navigator.onLine) {
      this.flush();
    }
  }

  /**
   * Enqueue a delete mutation.
   */
  async enqueueDelete(userId: string, entryDate: string, entryId: string): Promise<void> {
    await syncQueue.enqueue(userId, entryDate, 'delete', { entryId });
    this.notifyListeners();

    if (navigator.onLine) {
      this.flush();
    }
  }

  /**
   * Drain the queue — process all pending mutations in order.
   */
  async flush(): Promise<void> {
    if (this.isSyncing || !navigator.onLine) return;

    this.isSyncing = true;
    this.setStatus('syncing');

    try {
      const pending = await syncQueue.getPending();
      let hadErrors = false;

      for (const mutation of pending) {
        try {
          await this.processMutation(mutation);
          await syncQueue.remove(mutation.id);
        } catch (err) {
          hadErrors = true;
          const msg = err instanceof Error ? err.message : 'Unknown error';
          await syncQueue.markFailed(mutation.id, msg);
        }
      }

      this.setStatus(hadErrors ? 'error' : 'idle');
    } catch {
      this.setStatus('error');
    } finally {
      this.isSyncing = false;
      this.notifyListeners();
    }
  }

  /**
   * Retry all failed mutations.
   */
  async retryFailed(): Promise<void> {
    await syncQueue.retryFailed();
    this.flush();
  }

  // ─── Private ───────────────────────────────────────────

  private async processMutation(mutation: SyncMutation): Promise<void> {
    await syncQueue.markInFlight(mutation.id);

    switch (mutation.action) {
      case 'upsert': {
        const payload: EntryUpsertPayload = {
          entryDate: mutation.entryDate,
          content: mutation.payload.content as string,
          mood: mutation.payload.mood as EntryUpsertPayload['mood'],
          tags: mutation.payload.tags as string[],
        };
        await journalService.upsertEntry(mutation.userId, payload);
        break;
      }
      case 'delete': {
        const entryId = mutation.payload.entryId as string;
        await journalService.deleteEntry(entryId);
        break;
      }
      default:
        throw new Error(`Unknown mutation action: ${mutation.action}`);
    }
  }

  private handleOnline = (): void => {
    this.setStatus('idle');
    this.flush();
  };

  private handleOffline = (): void => {
    this.setStatus('offline');
  };

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.notifyListeners();
  }

  private async notifyListeners(): Promise<void> {
    const count = await syncQueue.size();
    this.listeners.forEach((l) => l(this.status, count));
  }
}

export const syncEngine = new SyncEngine();
