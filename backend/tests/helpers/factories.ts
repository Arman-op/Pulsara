import type { Role, User } from '@prisma/client';
import request from 'supertest';
import { app } from '../../src/app';
import { REFRESH_TOKEN_COOKIE } from '../../src/config/constants';
import { prisma } from '../../src/db/prisma';
import { hashPassword } from '../../src/modules/auth/password';

/**
 * Fixtures are created through the same code paths production uses — argon2 for
 * passwords, the real login endpoint for sessions — so a test never proves
 * something works using a shortcut the application does not have.
 */

export const TEST_PASSWORD = 'correct horse battery staple';

let sequence = 0;

/** Unique per call, so a test can create several users without naming them. */
function nextEmail(): string {
  sequence += 1;
  return `user${sequence}@pulsara.test`;
}

export async function createUser(
  overrides: Partial<Pick<User, 'email' | 'name' | 'role' | 'isActive'>> & {
    password?: string | null;
  } = {},
): Promise<User> {
  const { password = TEST_PASSWORD, ...fields } = overrides;

  return prisma.user.create({
    data: {
      email: (fields.email ?? nextEmail()).toLowerCase(),
      name: fields.name ?? 'Test User',
      role: fields.role ?? 'VIEWER',
      isActive: fields.isActive ?? true,
      passwordHash: password === null ? null : await hashPassword(password),
    },
  });
}

export type Session = {
  user: User;
  accessToken: string;
  /** The raw `Set-Cookie` value, ready to be replayed on the next request. */
  refreshCookie: string;
};

/** Pulls one cookie out of a Set-Cookie header, which supertest gives as an array. */
export function readCookie(setCookie: string[] | undefined, name: string): string {
  const match = (setCookie ?? []).find((cookie) => cookie.startsWith(`${name}=`));
  if (!match) throw new Error(`Response did not set the ${name} cookie`);
  // Only the name=value pair is replayed; the attributes are for the browser.
  return match.split(';')[0] ?? '';
}

export async function signIn(user: User, password = TEST_PASSWORD): Promise<Session> {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email: user.email, password })
    .expect(200);

  return {
    user,
    accessToken: (response.body as { data: { accessToken: string } }).data.accessToken,
    refreshCookie: readCookie(
      response.headers['set-cookie'] as unknown as string[],
      REFRESH_TOKEN_COOKIE,
    ),
  };
}

/** Creates a user with the given role and returns an authenticated session. */
export async function signedInAs(role: Role): Promise<Session> {
  return signIn(await createUser({ role }));
}
