import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveDataDirectory } from './config';

// Set your own password through private deployment configuration, never source code.
export function loadAdminVerifier(): string | undefined {
  try {
    const record = JSON.parse(readFileSync(resolve(resolveDataDirectory(process.env.DATA_DIR), 'admin-access.json'), 'utf8'));
    return record.version === 1 && typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256) ? record.sha256 : undefined;
  } catch { return undefined; }
}
export const ADMIN_COOKIE_NAME = 'emergent_admin';

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

function equalSecret(candidate: string, expected: string) {
  const candidateBytes = createHash('sha256').update(candidate).digest();
  const expectedBytes = Buffer.from(expected, 'hex');
  return expectedBytes.length === candidateBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

export class AdminAccess {
  private sessions = new Map<string, number>();

  constructor(private readonly verifier = loadAdminVerifier()) {}

  login(candidate: unknown, now = Date.now()) {
    if (typeof candidate !== 'string' || !candidate || candidate.length > 1024 || !this.verifier || !equalSecret(candidate, this.verifier)) return undefined;
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
