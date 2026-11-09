import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_ACCESS_KEY, ADMIN_COOKIE_NAME, AdminAccess } from '../server/admin-access';

test('administrator access accepts only the configured key and expires sessions', () => {
  const access = new AdminAccess();
  assert.equal(access.login('wrong key', 1000), undefined);
  const token = access.login(ADMIN_ACCESS_KEY, 1000);
  assert.ok(token);
  assert.equal(access.isAuthorized(`${ADMIN_COOKIE_NAME}=${token}`, 1001), true);
  assert.equal(access.isAuthorized(`another=value; ${ADMIN_COOKIE_NAME}=${token}; final=value`, 1001), true);
  assert.equal(access.isAuthorized(`${ADMIN_COOKIE_NAME}=${token}`, 1000 + 12 * 60 * 60 * 1000), false);
});

test('administrator cookies are HTTP-only and secure when served over HTTPS', () => {
  const cookie = new AdminAccess().sessionCookie('token', true);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
});
