/**
 * App Layout — shell for authenticated pages.
 * Applies the persisted theme on mount, provides nav, sync indicator,
 * theme toggle, and sign-out.
 */

import { useEffect } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '../providers/AuthProvider';
import { useSync } from '../providers/SyncProvider';
import { useSettings, useUpdateTheme } from '../../features/settings/hooks';

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function AppLayout() {
  const { signOut, isAdmin } = useAuth();
  const { status, pendingCount } = useSync();
  const { data: settings } = useSettings();
  const updateTheme = useUpdateTheme();

  // Apply theme from DB on mount and whenever it changes
  useEffect(() => {
    if (settings?.theme) {
      document.documentElement.dataset.theme = settings.theme;
    }
  }, [settings?.theme]);

  const currentTheme = settings?.theme ?? 'dark';

  const handleThemeToggle = () => {
    const next = currentTheme === 'dark' ? 'light' : 'dark';
    updateTheme.mutate(next);
  };

  const syncLabel =
    status === 'offline'
      ? 'Offline'
      : status === 'syncing'
        ? 'Syncing…'
        : status === 'error'
          ? 'Sync error'
          : 'Synced';

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="app-header-left">
          <NavLink to="/" className="app-logo">
            UnSaid
          </NavLink>
        </div>

        <nav className="app-nav" aria-label="Main navigation">
          <NavLink
            to="/"
            className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}
            end
          >
            Home
          </NavLink>
          <NavLink
            to="/journal"
            className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}
          >
            Write
          </NavLink>
          <NavLink
            to="/history"
            className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}
          >
            Journal
          </NavLink>
          <NavLink
            to="/insights"
            className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}
          >
            Insights
          </NavLink>
          {isAdmin && (
            <NavLink
              to="/admin"
              className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}
            >
              Admin
            </NavLink>
          )}
        </nav>

        <div className="app-header-right">
          {/* Sync dot */}
          <div
            className={`sync-indicator sync-${status}`}
            title={`${syncLabel}${pendingCount > 0 ? ` · ${pendingCount} pending` : ''}`}
            aria-label={syncLabel}
          >
            <span className="sync-dot" />
            {pendingCount > 0 && (
              <span className="sync-count" aria-live="polite">{pendingCount}</span>
            )}
          </div>

          {/* Theme toggle */}
          <button
            className="btn-icon"
            onClick={handleThemeToggle}
            type="button"
            title={`Switch to ${currentTheme === 'dark' ? 'light' : 'dark'} mode`}
            aria-label={`Switch to ${currentTheme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {currentTheme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>

          {/* Settings + sign out */}
          <NavLink
            to="/settings"
            className={({ isActive }) => isActive ? 'btn-icon btn-icon-active' : 'btn-icon'}
            title="Settings"
            aria-label="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </NavLink>

          <button
            className="btn-ghost btn-sm"
            onClick={signOut}
            type="button"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
