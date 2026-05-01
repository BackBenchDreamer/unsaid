/**
 * Waitlist Page — shown to users with 'pending' status.
 */

import React from 'react';
import { useAuth } from '../../app/providers/AuthProvider';
import { APP_NAME } from '../../shared/constants';

export default function WaitlistPage() {
  const { user, signOut } = useAuth();

  return (
    <div className="auth-page">
      <div className="auth-container">
        <div className="auth-brand">
          <h1 className="auth-logo">{APP_NAME}</h1>
        </div>

        <div className="auth-message">
          <div className="auth-icon">⏳</div>
          <h2>You're on the waitlist</h2>
          <p>
            Thanks for signing up, <strong>{user?.email}</strong>.
            Your account is being reviewed. We'll let you know when you're in.
          </p>
          <p className="auth-subtle">
            This is an invite-only space to keep things intimate and meaningful.
          </p>
        </div>

        <button className="btn-ghost" onClick={signOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
