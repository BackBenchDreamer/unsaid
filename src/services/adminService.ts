/**
 * Admin Service — waitlist management, user approval/rejection.
 *
 * All admin operations are protected by RLS (role='admin' check on server).
 * The client never decides who is admin.
 */

import { supabase } from './supabaseClient';
import { AppUser, userFromRow, ProfileRow } from '../entities/user';
import { unwrap, ServiceError } from './errors';

export interface WaitlistEntry {
  id: string;
  email: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

interface WaitlistRow {
  id: string;
  email: string;
  reason: string | null;
  status: string;
  reviewed_by: string | null;
  created_at: string;
  reviewed_at: string | null;
}

function waitlistFromRow(row: WaitlistRow): WaitlistEntry {
  return {
    id: row.id,
    email: row.email,
    reason: row.reason,
    status: row.status as WaitlistEntry['status'],
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

export const adminService = {
  /**
   * Get all waitlist entries, optionally filtered by status.
   */
  async getWaitlist(status?: 'pending' | 'approved' | 'rejected'): Promise<WaitlistEntry[]> {
    let query = supabase
      .from('waitlist')
      .select('*')
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const result = await query;
    const rows = unwrap(result) as WaitlistRow[];
    return rows.map(waitlistFromRow);
  },

  /**
   * Approve a waitlist entry.
   * This updates both the waitlist row and the user's profile status.
   */
  async approveUser(waitlistId: string, adminId: string): Promise<void> {
    // Update waitlist entry.
    const { error: wlError } = await supabase
      .from('waitlist')
      .update({
        status: 'approved',
        reviewed_by: adminId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', waitlistId);

    if (wlError) throw new ServiceError(wlError.message, wlError.code ?? 'DB_ERROR');

    // Get the waitlist email to find the profile.
    const { data: wl } = await supabase
      .from('waitlist')
      .select('email')
      .eq('id', waitlistId)
      .single();

    if (wl) {
      // Update the corresponding profile status.
      const { error: profError } = await supabase
        .from('profiles')
        .update({ status: 'approved' })
        .eq('email', wl.email);

      if (profError) throw new ServiceError(profError.message, profError.code ?? 'DB_ERROR');
    }
  },

  /**
   * Reject a waitlist entry.
   */
  async rejectUser(waitlistId: string, adminId: string): Promise<void> {
    const { error: wlError } = await supabase
      .from('waitlist')
      .update({
        status: 'rejected',
        reviewed_by: adminId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', waitlistId);

    if (wlError) throw new ServiceError(wlError.message, wlError.code ?? 'DB_ERROR');

    const { data: wl } = await supabase
      .from('waitlist')
      .select('email')
      .eq('id', waitlistId)
      .single();

    if (wl) {
      const { error: profError } = await supabase
        .from('profiles')
        .update({ status: 'rejected' })
        .eq('email', wl.email);

      if (profError) throw new ServiceError(profError.message, profError.code ?? 'DB_ERROR');
    }
  },

  /**
   * Get all users (admin view).
   */
  async getAllUsers(): Promise<AppUser[]> {
    const result = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });

    const rows = unwrap(result) as ProfileRow[];
    return rows.map(userFromRow);
  },

  /**
   * Submit a waitlist application (public — used during signup).
   */
  async submitWaitlistApplication(email: string, reason?: string): Promise<void> {
    const { error } = await supabase
      .from('waitlist')
      .insert({ email, reason: reason ?? null });

    if (error) {
      if (error.code === '23505') {
        throw new ServiceError('Already on the waitlist', 'DUPLICATE');
      }
      throw new ServiceError(error.message, error.code ?? 'DB_ERROR');
    }
  },
};
