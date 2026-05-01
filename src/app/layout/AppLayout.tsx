/**
 * App Layout — shell for authenticated pages.
 * Contains navigation, sync indicator, and outlet for child routes.
 */

import React from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '../providers/AuthProvider';
import { useSync } from '../providers/SyncProvider';

export function AppLayout() {
  const { user, signOut, isAdmin } = useAuth();
  const { status, pendingCount } = useSync();

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="app-header-left">
          <NavLink to="/" className="app-logo">
            UnSaid
          </NavLink>
        </div>

        <nav className="app-nav">
          <NavLink to="/" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'} end>
            Dashboard
          </NavLink>
          <NavLink to="/journal" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Write
          </NavLink>
          <NavLink to="/history" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            History
          </NavLink>
          {isAdmin && (
            <NavLink to="/admin" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              Admin
            </NavLink>
          )}
        </nav>

        <div className="app-header-right">
          {/* Sync indicator */}
          <div className={`sync-indicator sync-${status}`} title={`Sync: ${status}${pendingCount > 0 ? ` (${pendingCount} pending)` : ''}`}>
            <span className="sync-dot" />
            {pendingCount > 0 && <span className="sync-count">{pendingCount}</span>}
          </div>

          <div className="user-info">
            <span className="user-email">{user?.displayName ?? user?.email}</span>
            <button className="btn-ghost btn-sm" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
