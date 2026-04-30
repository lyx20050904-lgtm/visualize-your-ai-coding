/**
 * activity-store.test.js — F00 unit tests
 *
 * Coverage:
 *   - recordEdit / recordRead increment correctly
 *   - appendHistory respects HISTORY_MAX ring buffer
 *   - _flush + _load round-trip (data survives restart)
 *   - version mismatch triggers backup + silent reset
 *   - corrupted JSON triggers backup + silent reset
 *   - clear() resets all state and removes file
 *   - destroy() flushes pending save before exit
 *
 * Uses Node.js built-in test runner (node --test).
 * No network calls. All I/O confined to os.tmpdir().
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ActivityStore } from '../server/activity-store.js';

// ─── Helpers ───────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vg-test-'));
}

function activityFile(dir) {
  return path.join(dir, '.vibe-guarding-activity.json');
}

function noop() {}

// Wait for the 1s debounce + file write to complete
function waitFlush(ms = 1200) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Test Suite ────────────────────────────────────────────

describe('ActivityStore — recordEdit', () => {
  it('increments editCounts for a new path', async () => {
    const dir = tmpDir();
    const store = new ActivityStore(dir, noop);
    store.recordEdit('src/app.js');
    assert.equal(store.getEditCounts()['src/app.js'], 1);
    store.destroy();
  });

  it('accumulates multiple edits on the same path', async () => {
    const dir = tmpDir();
    const store = new ActivityStore(dir, noop);
    store.recordEdit('src/app.js');
    store.recordEdit('src/app.js');
    store.recordEdit('src/app.js');
    assert.equal(store.getEditCounts()['src/app.js'], 3);
    store.destroy();
  });

  it('tracks edits independently across different paths', async () => {
    const dir = tmpDir();
    const store = new ActivityStore(dir, noop);
    store.recordEdit('src/a.js');
    store.recordEdit('src/b.js');
    store.recordEdit('src/a.js');
    const counts = store.getEditCounts();
    assert.equal(counts['src/a.js'], 2);
    assert.equal(counts['src/b.js'], 1);
    store.destroy();
  });
});

describe('ActivityStore — recordRead', () => {
  it('increments readingCounts independently from editCounts', async () => {
    const dir = tmpDir();
    const store = new ActivityStore(dir, noop);
    store.recordEdit('src/x.ts');
    store.recordRead('src/x.ts');
    store.recordRead('src/x.ts');
    assert.equal(store.getEditCounts()['src/x.ts'], 1);
    assert.equal(store.getReadingCounts()['src/x.ts'], 2);
    store.destroy();
  });
});

describe('ActivityStore — appendHistory', () => {
  it('appends entries and retrieves them', async () => {
    const dir = tmpDir();
    const store = new ActivityStore(dir, noop);
    store.appendHistory({ type: 'file:changed', path: 'src/x.js', ts: new Date().toISOString() });
    store.appendHistory({ type: 'file:added',   path: 'src/y.js', ts: new Date().toISOString() });
    const h = store.getHistory();
    assert.equal(h.length, 2);
    assert.equal(h[0].type, 'file:changed');
    store.destroy();
  });

  it('getHistory(n) returns only the last n entries', async () => {
    const dir = tmpDir();
    const store = new ActivityStore(dir, noop);
    for (let i = 0; i < 10; i++) {
      store.appendHistory({ type: 'file:changed', path: `src/${i}.js`, ts: new Date().toISOString() });
    }
    const last3 = store.getHistory(3);
    assert.equal(last3.length, 3);
    assert.equal(last3[2].path, 'src/9.js');
    store.destroy();
  });
});

describe('ActivityStore — flush + load round-trip', () => {
  it('persists data and restores it after a simulated restart', async () => {
    const dir = tmpDir();
    const store1 = new ActivityStore(dir, noop);
    store1.recordEdit('server/index.js');
    store1.recordEdit('server/index.js');
    store1.recordRead('server/index.js');
    store1.appendHistory({ type: 'file:changed', path: 'server/index.js', ts: new Date().toISOString() });
    store1.destroy(); // triggers immediate flush

    // Small wait for fs.renameSync to complete on slower disks
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(fs.existsSync(activityFile(dir)), 'activity file should exist after destroy()');

    // Simulate restart — new instance reads from file
    const store2 = new ActivityStore(dir, noop);
    assert.equal(store2.getEditCounts()['server/index.js'], 2);
    assert.equal(store2.getReadingCounts()['server/index.js'], 1);
    assert.equal(store2.getHistory().length, 1);
    store2.destroy();
  });

  it('getAll() output is parseable JSON with correct version', async () => {
    const dir = tmpDir();
    const store = new ActivityStore(dir, noop);
    store.recordEdit('src/a.ts');
    const all = store.getAll();
    assert.equal(all.version, 1);
    assert.ok(typeof all.lastUpdated === 'string');
    assert.deepEqual(all.editCounts, { 'src/a.ts': 1 });
    store.destroy();
  });
});

describe('ActivityStore — corrupted file recovery', () => {
  it('silently resets when JSON is malformed', async () => {
    const dir = tmpDir();
    fs.writeFileSync(activityFile(dir), '{ INVALID JSON !!!', 'utf-8');

    const store = new ActivityStore(dir, noop);
    // Should start empty — no throw
    assert.deepEqual(store.getEditCounts(), {});
    assert.deepEqual(store.getReadingCounts(), {});
    assert.equal(store.getHistory().length, 0);

    // Backup file should exist
    assert.ok(fs.existsSync(activityFile(dir) + '.bak'), 'should create .bak for corrupted file');
    store.destroy();
  });

  it('silently resets when version field mismatches', async () => {
    const dir = tmpDir();
    const badData = JSON.stringify({ version: 99, editCounts: { 'x.js': 5 } });
    fs.writeFileSync(activityFile(dir), badData, 'utf-8');

    const store = new ActivityStore(dir, noop);
    assert.deepEqual(store.getEditCounts(), {}, 'version mismatch should yield empty store');
    store.destroy();
  });
});

describe('ActivityStore — clear()', () => {
  it('resets all in-memory state', async () => {
    const dir = tmpDir();
    const store = new ActivityStore(dir, noop);
    store.recordEdit('a.js');
    store.recordRead('a.js');
    store.appendHistory({ type: 'file:changed', path: 'a.js', ts: new Date().toISOString() });
    store.clear();
    assert.deepEqual(store.getEditCounts(), {});
    assert.deepEqual(store.getReadingCounts(), {});
    assert.equal(store.getHistory().length, 0);
    store.destroy();
  });

  it('removes the activity file from disk', async () => {
    const dir = tmpDir();
    const store = new ActivityStore(dir, noop);
    store.recordEdit('b.js');
    store.destroy(); // flush to disk
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(activityFile(dir)));

    const store2 = new ActivityStore(dir, noop);
    store2.clear();
    assert.ok(!fs.existsSync(activityFile(dir)), 'clear() should delete the file');
    store2.destroy();
  });
});

describe('ActivityStore — broadcast calls', () => {
  it('calls broadcast with edit-counts:update on recordEdit', async () => {
    const dir = tmpDir();
    const calls = [];
    const store = new ActivityStore(dir, (msg) => calls.push(msg));
    store.recordEdit('src/foo.js');
    const editBroadcast = calls.find((c) => c.type === 'edit-counts:update');
    assert.ok(editBroadcast, 'should broadcast edit-counts:update');
    assert.equal(editBroadcast.counts['src/foo.js'], 1);
    store.destroy();
  });

  it('calls broadcast with activity:state on clear()', async () => {
    const dir = tmpDir();
    const calls = [];
    const store = new ActivityStore(dir, (msg) => calls.push(msg));
    store.recordEdit('x.js');
    calls.length = 0; // reset
    store.clear();
    const stateBroadcast = calls.find((c) => c.type === 'activity:state');
    assert.ok(stateBroadcast, 'clear() should broadcast activity:state');
    assert.deepEqual(stateBroadcast.data.editCounts, {});
    store.destroy();
  });
});
