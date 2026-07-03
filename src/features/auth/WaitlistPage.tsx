/**
 * Waitlist Page — shown to users with 'pending' status.
 * Warm, personal copy with a subtle pulse animation.
 */

import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../app/providers/AuthProvider';
import { APP_NAME } from '../../shared/constants';

export default function WaitlistPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="auth-page">
      <div className="auth-container">
        <div className="auth-brand">
          <h1 className="auth-logo">{APP_NAME}</h1>
        </div>

        <div className="auth-message">
          <div className="auth-icon-wrap auth-icon-pulse" style={{ fontSize: '1.5rem' }}>
            ⏳
          </div>
          <h2>You're on the list</h2>
          <p>
            Thanks for signing up{user?.email ? `, ${user.email}` : ''}.
            This is a small, intentional space — we'll let you know once your account is ready.
          </p>
          <p className="auth-subtle">
            Sit with your thoughts in the meantime.
          </p>
        </div>

        <button className="btn-ghost" onClick={handleSignOut} type="button">
          Sign out
        </button>
      </div>
    </div>
  );
}
