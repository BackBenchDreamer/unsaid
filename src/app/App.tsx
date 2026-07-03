/**
 * Application entry point.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './providers/AuthProvider';
import { SyncProvider } from './providers/SyncProvider';
import { AppRouter } from './router';
import { queryClient } from './queryClient';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SyncProvider>
          <AppRouter />
        </SyncProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
