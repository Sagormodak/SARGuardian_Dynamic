import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import type { Engine } from './data/engineData';
import { Home } from './pages/Home';
import { LandslidePage } from '../landslide/ui/LandslidePage';
import { auth, firebaseConfigured, googleProvider, missingFirebaseConfig } from './firebase';
import { isLandslideDisplacementRoute, isLandslideResultsRoute, isLandslideRoute, LANDSLIDE_DISPLACEMENT_PATH, LANDSLIDE_PATH, LANDSLIDE_RESULTS_PATH, navigatePath, normalizePathname } from './routing';

function App() {
  const [pathname, setPathname] = useState(() => normalizePathname(window.location.pathname));
  const pathnameRef = useRef(pathname);
  const [user, setUser] = useState<User | null>(null);
  const [authState, setAuthState] = useState<'idle' | 'loading' | 'ready' | 'error'>('loading');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<string | null>(null);

  const navigateTo = useCallback((nextPath: string) => {
    const normalizedPath = navigatePath(nextPath, window.location.pathname, window.history.pushState.bind(window.history));
    pathnameRef.current = normalizedPath;
    setPathname(normalizedPath);
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const nextPath = normalizePathname(window.location.pathname);
      pathnameRef.current = nextPath;
      setPathname(nextPath);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (!auth) {
      setAuthState('idle');
      return undefined;
    }

    return onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthState(currentUser ? 'ready' : 'idle');
      setAuthError(null);
      const currentPath = pathnameRef.current;
      if (!currentUser && isLandslideRoute(currentPath)) {
        setPendingRoute(currentPath);
        setAuthModalOpen(true);
        navigateTo('/');
      }
    }, (error) => {
      setAuthError(error.message);
      setAuthState('error');
    });
  }, [navigateTo]);

  const handleSignIn = async () => {
    if (!auth || !googleProvider) {
      setAuthError('Firebase is not configured for this local environment.');
      setAuthState('error');
      return;
    }

    setAuthState('loading');
    try {
      await signInWithPopup(auth, googleProvider);
      setAuthState('ready');
      setAuthError(null);
      setAuthModalOpen(false);
      if (pendingRoute) {
        navigateTo(pendingRoute);
        setPendingRoute(null);
      }
    } catch (error: unknown) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed');
      setAuthState('error');
    }
  };

  const handleSignOut = async () => {
    if (!auth) return;
    try {
      await signOut(auth);
      setPendingRoute(null);
      setAuthModalOpen(false);
      if (pathname === '/landslide' || pathname.startsWith('/landslide/')) {
        navigateTo('/');
      }
    } catch (error: unknown) {
      setAuthError(error instanceof Error ? error.message : 'Sign out failed');
    }
  };

  const handleSelectEngine = (engine: Engine) => {
    if (!user) {
      if (engine.name === 'Landslide') {
        setPendingRoute('/landslide');
      } else {
        setPendingRoute(null);
      }
      setAuthModalOpen(true);
      return;
    }

    if (engine.name === 'Landslide') {
      navigateTo('/landslide');
      return;
    }

    setAuthModalOpen(false);
  };

  if (isLandslideRoute(pathname)) {
    if (!user) {
      return (
        <Home
          user={user}
          authState={authState}
          authError={authError}
          firebaseConfigured={firebaseConfigured}
          missingFirebaseConfig={missingFirebaseConfig}
          showAuthModal={true}
          onCloseAuthModal={() => { setAuthModalOpen(false); setPendingRoute(null); }}
          onSignIn={handleSignIn}
          onSignOut={handleSignOut}
          onSelectEngine={handleSelectEngine}
        />
      );
    }

    return (
      <LandslidePage
        key={user.uid}
        user={user}
        onHome={() => navigateTo('/')}
        isResultsPage={isLandslideResultsRoute(pathname)}
        isDisplacementPage={isLandslideDisplacementRoute(pathname)}
        onDisplacements={() => navigateTo(LANDSLIDE_DISPLACEMENT_PATH)}
        onResults={() => navigateTo(LANDSLIDE_RESULTS_PATH)}
        onBackToMap={() => navigateTo(LANDSLIDE_PATH)}
        onSignOut={handleSignOut}
      />
    );
  }

  return (
    <Home
      user={user}
      authState={authState}
      authError={authError}
      firebaseConfigured={firebaseConfigured}
      missingFirebaseConfig={missingFirebaseConfig}
      showAuthModal={authModalOpen}
      onCloseAuthModal={() => { setAuthModalOpen(false); setPendingRoute(null); }}
      onSignIn={handleSignIn}
      onSignOut={handleSignOut}
      onSelectEngine={handleSelectEngine}
    />
  );
}

export default App;
