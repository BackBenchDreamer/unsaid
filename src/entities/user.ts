/**
 * User / Profile domain entity.
 *
 * Invariants:
 *  - Role is never trusted from the client; always read from DB via RLS.
 *  - Status governs access: only 'approved' users can use the app.
 *  - Invite-only: new sign-ups land in 'pending' status until approved.
 */

export const USER_ROLES = ['user', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface AppUser {
  readonly id: string;
  readonly email: string;
  role: UserRole;
  status: UserStatus;
  displayName: string | null;
  readonly createdAt: string;
}

/** DB row from the profiles table. */
export interface ProfileRow {
  id: string;
  email: string;
  role: string;
  status: string;
  display_name: string | null;
  created_at: string;
}

export function userFromRow(row: ProfileRow): AppUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role as UserRole,
    status: row.status as UserStatus,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}
