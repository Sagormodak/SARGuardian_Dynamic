import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';

type ProfileControlProps = {
  user: User;
  onSignOut: () => void;
};

export function ProfileControl({ user, onSignOut }: ProfileControlProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [user.photoURL]);

  const initials = (() => {
    const base = user.displayName ?? user.email ?? 'User';
    const parts = base.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'U';
    return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'U';
  })();

  return (
    <div className="profile-control" data-confirming-signout={menuOpen}>
      {user.photoURL && !imageFailed ? <img src={user.photoURL} alt="" className="profile-avatar" onError={() => setImageFailed(true)} /> : <span className="profile-avatar profile-fallback">{initials}</span>}
      <span className="profile-copy">
        <strong>{user.displayName ?? 'Signed-in user'}</strong>
      </span>
      <button className="profile-menu" type="button" onClick={() => setMenuOpen((current) => !current)} aria-label="Open account actions">
        <span aria-hidden="true">⌄</span>
      </button>
      {menuOpen && (
        <div className="signout-popover" role="menu" aria-label="Profile menu">
          <div className="profile-menu-item">
            <span>Name</span>
            <strong>{user.displayName ?? 'Signed-in user'}</strong>
          </div>
          <div className="profile-menu-item">
            <span>Email</span>
            <strong>{user.email ?? 'No email available'}</strong>
          </div>
          <button type="button" className="confirm-button" onClick={() => { setMenuOpen(false); onSignOut(); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}
