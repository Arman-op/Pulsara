import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { env, isFirebaseConfigured } from '../../config/env';
import { logger } from '../../lib/logger';

/**
 * Firebase Admin, used solely to verify Google sign-in ID tokens.
 *
 * The previous implementation called `initializeApp({ projectId: 'pulsara-devops-dash' })`
 * with the project baked into source and no credential at all. Without a
 * credential the Admin SDK falls back to Application Default Credentials, which
 * exist on Google infrastructure and nowhere else, so token verification worked
 * on a developer's machine only by accident and would have failed in any real
 * deployment.
 *
 * Initialisation is lazy: a deployment that does not use federated sign-in
 * should not pay for, or fail on, an SDK it never calls.
 */

let cachedApp: App | null = null;

function getFirebaseApp(): App {
  if (cachedApp) return cachedApp;

  if (!isFirebaseConfigured) {
    throw new Error('Firebase credentials are not configured');
  }

  const existing = getApps()[0];
  cachedApp =
    existing ??
    initializeApp({
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY,
      }),
      projectId: env.FIREBASE_PROJECT_ID,
    });

  logger.info({ projectId: env.FIREBASE_PROJECT_ID }, 'Firebase Admin initialised');
  return cachedApp;
}

/**
 * Verifies a Google ID token and returns its decoded claims.
 *
 * `checkRevoked` is enabled so that disabling an account in the identity
 * provider takes effect immediately, rather than at the token's natural expiry.
 */
export async function verifyFirebaseIdToken(idToken: string): Promise<DecodedIdToken> {
  return getAuth(getFirebaseApp()).verifyIdToken(idToken, true);
}
