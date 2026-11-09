import assert from 'node:assert/strict';
import test from 'node:test';
import { interfaceRoutePath, parseInterfaceRoute } from '../src/interface-routing';

test('observer and administrator routes share the same content paths', () => {
  assert.deepEqual(parseInterfaceRoute('/'), { mode: 'observer', contentPath: '/' });
  assert.deepEqual(parseInterfaceRoute('/universes/first-shore'), { mode: 'observer', contentPath: '/universes/first-shore' });
  assert.deepEqual(parseInterfaceRoute('/admin'), { mode: 'admin', contentPath: '/' });
  assert.deepEqual(parseInterfaceRoute('/admin/'), { mode: 'admin', contentPath: '/' });
  assert.deepEqual(parseInterfaceRoute('/admin/universes/first-shore'), { mode: 'admin', contentPath: '/universes/first-shore' });
});

test('interface links preserve their observer or administrator scope', () => {
  assert.equal(interfaceRoutePath('observer', '/'), '/');
  assert.equal(interfaceRoutePath('observer', '/universes/first-shore'), '/universes/first-shore');
  assert.equal(interfaceRoutePath('admin', '/'), '/admin/');
  assert.equal(interfaceRoutePath('admin', '/universes/first-shore'), '/admin/universes/first-shore');
});
