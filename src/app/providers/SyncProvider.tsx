/**
 * Sync Context — provides sync status to the app.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { syncEngine, SyncStatus } from '../../sync';

interface SyncContextValue {
  status: SyncStatus;
  pendingCount: number;
  flush: () => Promise<void>;
  retryFailed: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SyncStatus>(syncEngine.getStatus());
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    syncEngine.start();

    const unsub = syncEngine.subscribe((s, count) => {
      setStatus(s);
      setPendingCount(count);
    });

    return () => {
      unsub();
      syncEngine.stop();
    };
  }, []);

  const value: SyncContextValue = {
    status,
    pendingCount,
    flush: () => syncEngine.flush(),
    retryFailed: () => syncEngine.retryFailed(),
  };

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used within SyncProvider');
  return ctx;
}
