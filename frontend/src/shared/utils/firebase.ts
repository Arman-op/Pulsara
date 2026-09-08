import { initializeApp, type FirebaseApp } from 'firebase/app';
import { GoogleAuthProvider, getAuth, type Auth } from 'firebase/auth';
import { firebaseConfig } from '../../config/env';

/**
 * Firebase client, initialised only when the deployment is configured for it.
 *
 * The configuration used to be a literal object in this file, committed to the
 * repository. A Firebase web API key is not a secret — it identifies the
 * project rather than authorising it — but hard-coding it still meant one
 * repository could only ever talk to one Firebase project, so a staging build
 * authenticated against production.
 *
 * Initialisation is lazy so that a deployment without Google sign-in never
 * loads the SDK's auth machinery, and never renders a button that cannot work.
 */

let cachedApp: FirebaseApp | null = null;

function getFirebaseApp(): FirebaseApp {
  if (!firebaseConfig) {
    throw new Error('Google sign-in is not configured for this deployment');
  }
  cachedApp ??= initializeApp(firebaseConfig);
  return cachedApp;
}

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseApp());
}

export function createGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  // Always show the account chooser. Silently reusing whichever Google session
  // the browser happens to hold is a surprising way to sign in to an
  // infrastructure console.
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
}
