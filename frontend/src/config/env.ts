import { z } from 'zod';

/**
 * Build-time environment contract for the client.
 *
 * Vite inlines `import.meta.env.VITE_*` into the bundle at build time, so a
 * missing variable does not fail at deploy — it ships as `undefined` and
 * surfaces as a broken feature for real users. Parsing the whole set here, at
 * module load, converts that into an immediate and legible failure: the dev
 * server refuses to start and the production bundle throws on first import
 * rather than silently pointing at the wrong API.
 *
 * The previous code instead scattered `import.meta.env.VITE_API_URL ||
 * 'http://localhost:4000'` across six components. A production build that lost
 * the variable would quietly try to reach the developer's laptop.
 */

const firebaseSchema = z.object({
  VITE_FIREBASE_API_KEY: z.string().min(1),
  VITE_FIREBASE_AUTH_DOMAIN: z.string().min(1),
  VITE_FIREBASE_PROJECT_ID: z.string().min(1),
  VITE_FIREBASE_APP_ID: z.string().min(1),
  VITE_FIREBASE_MESSAGING_SENDER_ID: z.string().min(1),
  VITE_FIREBASE_STORAGE_BUCKET: z.string().min(1),
});

const envSchema = z.object({
  /**
   * Absolute origin of the Pulsara API, without a trailing slash. Used for both
   * REST calls and the WebSocket handshake, which must share an origin for the
   * credentialed CORS policy to hold.
   */
  VITE_API_URL: z
    .string()
    .url('must be an absolute URL, for example http://localhost:4000')
    .transform((value) => value.replace(/\/+$/, '')),
});

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
}

const parsed = envSchema.safeParse(import.meta.env);

if (!parsed.success) {
  throw new Error(
    `Pulsara client is misconfigured:\n${formatIssues(parsed.error)}\n\n` +
      `See frontend/.env.example for the full list of variables.`,
  );
}

export const env = parsed.data;

/**
 * Google sign-in is optional, so its configuration is parsed separately and a
 * partial or absent set simply disables the feature rather than breaking the
 * whole application. The UI reads `firebaseConfig === null` to decide whether
 * to render the Google button at all, instead of offering a control that is
 * guaranteed to fail.
 */
const firebaseParsed = firebaseSchema.safeParse(import.meta.env);

export const firebaseConfig = firebaseParsed.success
  ? {
      apiKey: firebaseParsed.data.VITE_FIREBASE_API_KEY,
      authDomain: firebaseParsed.data.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: firebaseParsed.data.VITE_FIREBASE_PROJECT_ID,
      appId: firebaseParsed.data.VITE_FIREBASE_APP_ID,
      messagingSenderId: firebaseParsed.data.VITE_FIREBASE_MESSAGING_SENDER_ID,
      storageBucket: firebaseParsed.data.VITE_FIREBASE_STORAGE_BUCKET,
    }
  : null;

export const isGoogleSignInEnabled = firebaseConfig !== null;
