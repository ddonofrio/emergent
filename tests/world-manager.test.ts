import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { WorldManager } from '../server/world-manager';
import { Store } from '../server/store';
import { Engine } from '../src/core/engine';
import { island } from '../src/universes/first-shore';

function record(path: string) {
  const engine = new Engine(island), store = new Store(path, island.manifest);
  store.record(engine.frame(), engine.state()); store.close();
}

function legacyRecord(path: string) {
  const engine = new Engine(island), db = new DatabaseSync(path);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE frames (tick INTEGER PRIMARY KEY, data BLOB NOT NULL);
    CREATE TABLE checkpoints (tick INTEGER PRIMARY KEY, data BLOB NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY, tick INTEGER NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);`);
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('clock', 'lockstep-v1');
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('module', JSON.stringify(island.manifest));
  db.prepare('INSERT INTO frames VALUES (?, ?)').run(0, deflateSync(JSON.stringify(engine.frame())));
  db.prepare('INSERT INTO checkpoints VALUES (?, ?)').run(0, deflateSync(JSON.stringify(engine.state())));
  db.close();
}

test('read-only archive playback supports recordings without the current metrics table', () => {
  const engine = new Engine(island);
  const root = resolve('.tmp'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'world-archive-')), path = join(directory, 'archive.sqlite');
  try {
    const archive = new DatabaseSync(path);
    archive.exec(`CREATE TABLE frames (tick INTEGER PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE checkpoints (tick INTEGER PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY, tick INTEGER NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);`);
    archive.prepare('INSERT INTO frames VALUES (?, ?)').run(0, deflateSync(JSON.stringify(engine.frame())));
    archive.prepare('INSERT INTO checkpoints VALUES (?, ?)').run(0, deflateSync(JSON.stringify(engine.state())));
    archive.close();
    const store = new Store(path, island.manifest, { readOnly: true });
    assert.equal(store.metricsAt(0), undefined);
    assert.equal(store.stateAt(0).tick, 0);
    store.close();
  } finally {
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('world manager moves active and legacy recordings into self-contained world directories', async () => {
  const root = resolve('.tmp'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'world-manager-'));
  try {
    const activePath = join(directory, 'first-shore.sqlite'); record(activePath);
    const legacyDirectory = join(directory, 'worlds', 'Manual Tuning'); mkdirSync(legacyDirectory, { recursive: true });
    record(join(legacyDirectory, 'first-shore.sqlite'));
    writeFileSync(join(legacyDirectory, 'save.json'), JSON.stringify({ name: 'Manual Tuning', savedAt: '2026-10-28T13:03:32Z', seed: 731, module: 'first-shore' }));

    const manager = await WorldManager.open(directory, [{ id: 'first-shore', name: 'First Shore', seed: 731 }]);
    const worlds = await manager.list('first-shore');
    assert.equal(worlds.length, 2);
    assert.equal(worlds.filter(world => world.active).length, 1);
    assert.deepEqual(new Set(worlds.map(world => world.name)), new Set(['First Shore', 'Manual Tuning']));
    assert.equal(existsSync(activePath), false);
    assert.equal(existsSync(legacyDirectory), false);
    for (const world of manager.worlds('first-shore')) {
      assert.match(basename(world.directory), /^[0-9a-f-]{36}$/);
      assert.equal(existsSync(join(world.directory, 'world.json')), true);
      assert.equal(existsSync(manager.recordingPath(world)), true);
      const metadata = JSON.parse(readFileSync(join(world.directory, 'world.json'), 'utf8')) as { id: string; name: string; seed: number };
      assert.equal(metadata.id, world.id);
      assert.equal(metadata.name, world.name);
      assert.equal(metadata.seed, world.seed);
    }
  } finally {
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('world manager creates, renames, activates and reloads UUID worlds with immutable seeds', async () => {
  const root = resolve('.tmp'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'world-catalog-'));
  try {
    const universes = [{ id: 'first-shore', name: 'First Shore', seed: 731 }];
    const manager = await WorldManager.open(directory, universes);
    const created = await manager.create('first-shore', 'Second Shore', -42);
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.seed, -42);
    assert.equal(existsSync(join(created.directory, 'world.json')), true);
    assert.equal((await manager.list('first-shore')).find(world => world.id === created.id)?.hasRecording, false);
    assert.equal((await manager.list('first-shore')).find(world => world.id === created.id)?.resumable, false);

    record(manager.recordingPath(created));
    assert.equal((await manager.list('first-shore')).find(world => world.id === created.id)?.resumable, true);
    await manager.rename('first-shore', created.id, 'Second Shore Revised');
    await manager.activate('first-shore', created.id);
    assert.equal(manager.activeWorld('first-shore').name, 'Second Shore Revised');
    assert.equal(manager.activeWorld('first-shore').seed, -42);
    await assert.rejects(() => manager.create('first-shore', 'second shore revised', 1), /unique/);
    await assert.rejects(() => manager.create('first-shore', 'Invalid', 2 ** 31), /Seed/);
    await assert.rejects(() => manager.delete('first-shore', created.id), /current world/);

    const reopened = await WorldManager.open(directory, universes);
    assert.equal(reopened.activeWorld('first-shore').id, created.id);
    assert.equal(reopened.activeWorld('first-shore').seed, -42);
    assert.equal((await reopened.list('first-shore')).find(world => world.id === created.id)?.latestTick, 0);
    const previous = reopened.worlds('first-shore').find(world => world.id !== created.id)!;
    await reopened.delete('first-shore', previous.id);
    assert.equal(existsSync(previous.directory), false);
    assert.equal(reopened.worlds('first-shore').some(world => world.id === previous.id), false);

    const legacy = await reopened.create('first-shore', 'Legacy Shore', island.manifest.seed);
    legacyRecord(reopened.recordingPath(legacy));
    assert.equal((await reopened.list('first-shore')).find(world => world.id === legacy.id)?.resumable, false);
    await reopened.makeResumable('first-shore', legacy.id, island.manifest);
    assert.equal((await reopened.list('first-shore')).find(world => world.id === legacy.id)?.resumable, true);
    const upgraded = new Store(reopened.recordingPath(legacy), island.manifest); upgraded.close();
  } finally {
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
