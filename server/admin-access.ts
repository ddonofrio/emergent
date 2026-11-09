import { randomBytes, timingSafeEqual } from 'node:crypto';

export const ADMIN_ACCESS_KEY = "+¡`'p0o9o";
export const ADMIN_COOKIE_NAME = 'emergent_admin';

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

function equalSecret(candidate: string, expected: string) {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

export class AdminAccess {
  private sessions = new Map<string, number>();

  login(candidate: unknown, now = Date.now()) {
    if (typeof candidate !== 'string' || !equalSecret(candidate, ADMIN_ACCESS_KEY)) return undefined;
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, now + SESSION_LIFETIME_MS);
    return token;
  }

  isAuthorized(cookieHeader: string | undefined, now = Date.now()) {
    const token = this.cookieValue(cookieHeader);
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (!expires || expires <= now) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  sessionCookie(token: string, secure: boolean) {
    return `${ADMIN_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_LIFETIME_MS / 1000}${secure ? '; Secure' : ''}`;
  }

  private cookieValue(header: string | undefined) {
    for (const part of header?.split(';') ?? []) {
      const [name, ...value] = part.trim().split('=');
      if (name === ADMIN_COOKIE_NAME) return value.join('=');
    }
    return undefined;
  }
}
