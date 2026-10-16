import type { Engine } from '../data/engineData';
import { engines } from '../data/engineData';
import { EngineCard } from '../components/EngineCard';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { Hero } from '../components/Hero';

import type { User } from 'firebase/auth';

type HomeProps = {
  user: User | null;
  authState: 'idle' | 'loading' | 'ready' | 'error';
  authError: string | null;
  firebaseConfigured: boolean;
  missingFirebaseConfig: readonly string[];
  showAuthModal?: boolean;
  onCloseAuthModal?: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onSelectEngine: (engine: Engine) => void;
};

export function Home({ user, authState, authError, firebaseConfigured, missingFirebaseConfig, showAuthModal = false, onCloseAuthModal, onSignIn, onSignOut, onSelectEngine }: HomeProps) {
  return (
    <div className="home-page">
      <div className="environment-layer" aria-hidden="true" />
      <div className="ambient-vignette" aria-hidden="true" />
      <Header user={user} authState={authState} onSignIn={onSignIn} onSignOut={onSignOut} />
      <main className="home-main">
        {!firebaseConfigured && (
          <section className="setup-banner" role="status">
            Local auth setup required. Missing: {missingFirebaseConfig.join(', ')}.
          </section>
        )}
        <Hero />
        <section className="engine-section" aria-labelledby="engines-title">
          <h2 id="engines-title" className="sr-only">Surface change engines</h2>
          <div className="engine-grid">
            {engines.map((engine) => <EngineCard key={engine.name} engine={engine} onSelect={onSelectEngine} />)}
          </div>
        </section>
        {authState === 'error' && <section className="error-banner" role="alert">{authError}</section>}
      </main>
      {showAuthModal && !user && (
        <div className="auth-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
          <div className="auth-modal glass-panel">
            <button className="auth-modal-close" type="button" onClick={onCloseAuthModal} aria-label="Close authentication prompt">×</button>
            <div className="auth-modal-header">
              <span className="brand-mark" aria-hidden="true"><span className="brand-mountain" /><span className="brand-water" /></span>
              <span id="auth-modal-title">Continue to SARGuardian</span>
            </div>
            <p>Sign in with Google to unlock this investigation workspace.</p>
            <button className="sign-in-button large" onClick={onSignIn} type="button" disabled={authState === 'loading'}>
              <span className="google-mark" aria-hidden="true">G</span>
              {authState === 'loading' ? 'Signing in...' : 'Sign in with Google'}
            </button>
          </div>
        </div>
      )}
      <Footer />
    </div>
  );
}
