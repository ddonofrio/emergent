import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_COOKIE_NAME, AdminAccess } from '../server/admin-access';

test('administrator access accepts only the configured key and expires sessions', () => {
  const key = 'test-only-password-not-for-production';
  const access = new AdminAccess(createHash('sha256').update(key).digest('hex'));
  assert.equal(access.login('wrong key', 1000), undefined);
  const token = access.login(key, 1000);
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

test('missing configuration and placeholders never grant access', () => {
  const access = new AdminAccess('');
  for (const candidate of ['', 'set your own password', 'set your password here', undefined]) assert.equal(access.login(candidate), undefined);
});

test('a published verifier is not a login credential and restart invalidates sessions', () => {
  const key = 'another-test-only-password';
  const verifier = createHash('sha256').update(key).digest('hex');
  const first = new AdminAccess(verifier);
  assert.equal(first.login(verifier), undefined);
  const token = first.login(key)!;
  assert.ok(token);
  assert.equal(new AdminAccess(verifier).isAuthorized(`${ADMIN_COOKIE_NAME}=${token}`), false);
});
