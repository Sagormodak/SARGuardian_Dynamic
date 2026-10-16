import type { User } from 'firebase/auth';
import { ProfileControl } from './ProfileControl';

type HeaderProps = {
  user: User | null;
  authState: 'idle' | 'loading' | 'ready' | 'error';
  onSignIn: () => void;
  onSignOut: () => void;
};

const navItems = ['Home', 'Cases', 'Method', 'Data', 'Archive'];

export function Header({ user, authState, onSignIn, onSignOut }: HeaderProps) {
  return (
    <header className="site-header">
      <a className="brand-lockup" href="/" aria-label="SARGuardian home">
        <span className="brand-mark" aria-hidden="true"><span className="brand-mountain" /><span className="brand-water" /></span>
        <span className="brand-copy">
          <strong><b>SAR</b>Guardian</strong>
          <small>EARTH IN SIGHT</small>
        </span>
      </a>

      <nav className="main-nav" aria-label="Main navigation">
        {navItems.map((item, index) => (
          <button className={index === 0 ? 'nav-link is-current' : 'nav-link'} type="button" key={item}>{item}</button>
        ))}
      </nav>

      <div className="header-actions">
        <button className="icon-button search-button" type="button" aria-label="Search">⌕</button>
        {user ? (
          <ProfileControl user={user} onSignOut={onSignOut} />
        ) : (
          <button className="sign-in-button" onClick={onSignIn} type="button" disabled={authState === 'loading'}>
            <span className="google-mark" aria-hidden="true">G</span>
            {authState === 'loading' ? 'Signing in...' : 'Sign in with Google'}
          </button>
        )}
      </div>
    </header>
  );
}
