/**
 * Admin Page — waitlist management and user administration.
 *
 * Note: Frontend guard is UI-only. All operations are RLS-enforced server-side.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminService } from '../../services/adminService';
import type { WaitlistEntry } from '../../services/adminService';
import { useAuth } from '../../app/providers/AuthProvider';
import { format } from 'date-fns';

const adminKeys = {
  waitlist: (status?: string) => ['admin', 'waitlist', status] as const,
  users: () => ['admin', 'users'] as const,
};

export default function AdminPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'waitlist' | 'users'>('waitlist');
  const [statusFilter, setStatusFilter] = useState<'pending' | 'approved' | 'rejected' | undefined>('pending');

  const { data: waitlist, isLoading: wlLoading } = useQuery({
    queryKey: adminKeys.waitlist(statusFilter),
    queryFn: () => adminService.getWaitlist(statusFilter),
  });

  const { data: users, isLoading: usersLoading } = useQuery({
    queryKey: adminKeys.users(),
    queryFn: () => adminService.getAllUsers(),
    enabled: activeTab === 'users',
  });

  const approveMutation = useMutation({
    mutationFn: (waitlistId: string) => adminService.approveUser(waitlistId, user!.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });

  const rejectMutation = useMutation({
    mutationFn: (waitlistId: string) => adminService.rejectUser(waitlistId, user!.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });

  return (
    <div className="page admin-page">
      <h1>Admin</h1>

      <div className="tab-bar">
        <button
          className={`tab${activeTab === 'waitlist' ? ' tab-active' : ''}`}
          onClick={() => setActiveTab('waitlist')}
          type="button"
        >
          Waitlist
        </button>
        <button
          className={`tab${activeTab === 'users' ? ' tab-active' : ''}`}
          onClick={() => setActiveTab('users')}
          type="button"
        >
          Users
        </button>
      </div>

      {activeTab === 'waitlist' && (
        <div>
          <div className="filter-bar">
            {(['pending', 'approved', 'rejected'] as const).map((s) => (
              <button
                key={s}
                className={`filter-btn${statusFilter === s ? ' filter-active' : ''}`}
                onClick={() => setStatusFilter(s)}
                type="button"
              >
                {s}
              </button>
            ))}
            <button
              className={`filter-btn${!statusFilter ? ' filter-active' : ''}`}
              onClick={() => setStatusFilter(undefined)}
              type="button"
            >
              All
            </button>
          </div>

          {wlLoading ? (
            <div className="loading-spinner" />
          ) : !waitlist || waitlist.length === 0 ? (
            <div className="empty-state" style={{ padding: 'var(--space-2xl) 0' }}>
              <p className="empty-title">No {statusFilter ?? ''} applications</p>
            </div>
          ) : (
            <div className="waitlist-grid">
              {waitlist.map((entry: WaitlistEntry) => (
                <div key={entry.id} className="waitlist-card">
                  <div className="waitlist-card-header">
                    <span className="waitlist-email">{entry.email}</span>
                    <span className={`badge badge-${entry.status}`}>{entry.status}</span>
                  </div>
                  {entry.reason && (
                    <p className="waitlist-reason">"{entry.reason}"</p>
                  )}
                  <div className="waitlist-card-footer">
                    <span className="waitlist-date">
                      {format(new Date(entry.createdAt), 'MMM d, yyyy')}
                    </span>
                    {entry.status === 'pending' && (
                      <div className="waitlist-actions">
                        <button
                          className="btn-success btn-sm"
                          onClick={() => approveMutation.mutate(entry.id)}
                          disabled={approveMutation.isPending}
                          type="button"
                        >
                          Approve
                        </button>
                        <button
                          className="btn-danger btn-sm"
                          onClick={() => rejectMutation.mutate(entry.id)}
                          disabled={rejectMutation.isPending}
                          type="button"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'users' && (
        <div>
          {usersLoading ? (
            <div className="loading-spinner" />
          ) : !users || users.length === 0 ? (
            <div className="empty-state" style={{ padding: 'var(--space-2xl) 0' }}>
              <p className="empty-title">No users</p>
            </div>
          ) : (
            <div className="users-table-container">
              <table className="users-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.email}</td>
                      <td><span className={`badge badge-${u.role}`}>{u.role}</span></td>
                      <td><span className={`badge badge-${u.status}`}>{u.status}</span></td>
                      <td>{format(new Date(u.createdAt), 'MMM d, yyyy')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
