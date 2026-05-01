/**
 * Application router.
 */

import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './providers/AuthProvider';
import { AppLayout } from './layout/AppLayout';

// Lazy-loaded feature pages.
const LoginPage = lazy(() => import('../features/auth/LoginPage'));
const WaitlistPage = lazy(() => import('../features/auth/WaitlistPage'));
const JournalPage = lazy(() => import('../features/journal/JournalPage'));
const DashboardPage = lazy(() => import('../features/dashboard/DashboardPage'));
const HistoryPage = lazy(() => import('../features/journal/HistoryPage'));
const AdminPage = lazy(() => import('../features/admin/AdminPage'));

function LoadingFallback() {
  return (
    <div className="loading-screen">
      <div className="loading-spinner" />
      <p>Loading...</p>
    </div>
  );
}

/**
 * Route guard — requires authentication and approved status.
 */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isApproved, isPending, isLoading } = useAuth();

  if (isLoading) return <LoadingFallback />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (isPending) return <Navigate to="/waitlist" replace />;
  if (!isApproved) return <Navigate to="/login" replace />;

  return <>{children}</>;
}

/**
 * Route guard — requires admin role (checked server-side, but UI hides routes).
 */
function AdminRoute({ children }: { children: React.ReactNode }) {
  const { isAdmin, isLoading } = useAuth();

  if (isLoading) return <LoadingFallback />;
  if (!isAdmin) return <Navigate to="/" replace />;

  return <>{children}</>;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/waitlist" element={<WaitlistPage />} />

          {/* Protected routes */}
          <Route element={<AppLayout />}>
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <DashboardPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/journal"
              element={
                <ProtectedRoute>
                  <JournalPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/journal/:date"
              element={
                <ProtectedRoute>
                  <JournalPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/history"
              element={
                <ProtectedRoute>
                  <HistoryPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin"
              element={
                <AdminRoute>
                  <AdminPage />
                </AdminRoute>
              }
            />
          </Route>

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
