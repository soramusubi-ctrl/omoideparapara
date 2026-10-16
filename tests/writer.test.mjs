import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlbumWriter } from '../dist/album-writer.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function album(id = 'album-a', title = 'First title') {
  return { id, title, theme: 'linen', pages: [{ id: 'page-a', note: 'First note', date: '2026-10-16' }] };
}

test('each save captures album and page edits immediately, including while queued', async () => {
  const firstStarted = deferred();
  const commitFirst = deferred();
  const stored = [];
  const writer = createAlbumWriter({ saveAlbum: async snapshot => {
    stored.push(snapshot);
    if (stored.length === 1) {
      firstStarted.resolve();
      await commitFirst.promise;
    }
    return { album: snapshot, revision: stored.length };
  } });
  const source = album();
  const first = writer.save(source);
  source.title = 'Second title';
  source.pages[0].note = 'Second note';
  await firstStarted.promise;
  const second = writer.save(source);
  source.title = 'Later unsaved title';
  source.pages[0].note = 'Later unsaved note';
  source.pages.push({ id: 'page-b', note: 'Later unsaved page' });

  assert.equal(stored[0].title, 'First title');
  assert.equal(stored[0].pages[0].note, 'First note');
  assert.equal(stored.length, 1, 'The second write must wait for the first commit.');
  commitFirst.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(stored.map(item => ({ title: item.title, notes: item.pages.map(page => page.note) })), [
    { title: 'First title', notes: ['First note'] },
    { title: 'Second title', notes: ['Second note'] },
  ]);
  assert.equal(source.title, 'Later unsaved title');
  assert.equal(source.pages.length, 2);
});

test('queued saves use the latest committed revision when their turn starts', async () => {
  const started = deferred();
  const commit = deferred();
  const expected = [];
  let revision = 0;
  const writer = createAlbumWriter({ saveAlbum: async (snapshot, { expectedRevision }) => {
    expected.push(expectedRevision);
    assert.equal(expectedRevision, revision);
    if (expected.length === 1) {
      started.resolve();
      await commit.promise;
    }
    return { album: snapshot, revision: ++revision };
  } });
  let saved = false;
  const first = writer.save(album()).then(result => { saved = true; return result; });
  const second = writer.save(album('album-a', 'Second title'));
  const third = writer.save(album('album-a', 'Third title'));
  await started.promise;
  assert.equal(saved, false, 'A request is not saved until storage commits it.');
  assert.deepEqual(expected, [0]);
  commit.resolve();
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(expected, [0, 1, 2]);
  assert.deepEqual(results.map(result => result.revision), [1, 2, 3]);
  assert.deepEqual(results.map(result => result.album.title), ['First title', 'Second title', 'Third title']);
});

test('album IDs retain independent revisions within the shared save queue', async () => {
  const started = deferred();
  const commit = deferred();
  const calls = [];
  const versions = new Map();
  let active = 0;
  const writer = createAlbumWriter({ saveAlbum: async (snapshot, { expectedRevision }) => {
    assert.equal(active++, 0, 'Writes for different albums must also be serialized.');
    calls.push([snapshot.id, expectedRevision]);
    assert.equal(expectedRevision, versions.get(snapshot.id) ?? 0);
    if (calls.length === 1) {
      started.resolve();
      await commit.promise;
    }
    const revision = expectedRevision + 1;
    versions.set(snapshot.id, revision);
    active -= 1;
    return { album: snapshot, revision };
  } });
  const requests = ['album-a', 'album-b', 'album-a', 'album-b'].map(id => writer.save(album(id)));
  await started.promise;
  assert.deepEqual(calls, [['album-a', 0]]);
  commit.resolve();
  await Promise.all(requests);
  assert.deepEqual(calls, [['album-a', 0], ['album-b', 0], ['album-a', 1], ['album-b', 1]]);
});

test('transaction failure preserves the last committed version and original error', async () => {
  const abort = new Error('Transaction aborted after its request completed');
  abort.name = 'AbortError';
  const expected = [];
  let request = 0;
  const writer = createAlbumWriter({ saveAlbum: async (snapshot, { expectedRevision }) => {
    expected.push(expectedRevision);
    request += 1;
    if (request === 2) throw abort;
    return { album: snapshot, revision: expectedRevision + 1 };
  } });
  await writer.save(album());
  let markedSaved = false;
  const failed = writer.save(album('album-a', 'Aborted edit')).then(result => { markedSaved = true; return result; });
  const retry = writer.save(album('album-a', 'Retry edit'));
  const fork = writer.save(album('new-album', 'Forked edit'));
  await assert.rejects(failed, error => error === abort);
  assert.equal(markedSaved, false);
  assert.equal((await retry).revision, 2);
  assert.equal((await fork).revision, 1);
  assert.deepEqual(expected, [0, 1, 1, 0]);
});

test('conflicts stay stale until explicitly seeded; a new album can still save', async () => {
  const conflict = new Error('Another tab saved this album');
  conflict.name = 'AlbumConflictError';
  conflict.actualRevision = 7;
  const calls = [];
  const writer = createAlbumWriter({ saveAlbum: async (snapshot, { expectedRevision }) => {
    calls.push([snapshot.id, expectedRevision]);
    if (snapshot.id === 'album-a' && expectedRevision !== 7) throw conflict;
    return { album: snapshot, revision: expectedRevision + 1 };
  } });
  writer.seed('album-a', 3);
  let markedSaved = false;
  const first = writer.save(album()).then(result => { markedSaved = true; return result; });
  const second = writer.save(album());
  const fork = writer.save(album('new-album'));
  await assert.rejects(first, error => error === conflict);
  await assert.rejects(second, error => error === conflict);
  assert.equal(markedSaved, false);
  assert.equal((await fork).revision, 1);
  writer.seed('album-a', 7);
  assert.equal((await writer.save(album())).revision, 8);
  assert.deepEqual(calls, [['album-a', 3], ['album-a', 3], ['new-album', 0], ['album-a', 7]]);
});

test('an explicitly loaded revision is used without trusting revision fields on an album', async () => {
  const calls = [];
  const results = [];
  const writer = createAlbumWriter({ saveAlbum: async (snapshot, { expectedRevision }) => {
    calls.push([snapshot.id, expectedRevision]);
    const result = { album: { ...snapshot, title: 'Committed title' }, revision: expectedRevision + 1 };
    results.push(result);
    return result;
  } });
  writer.seed('loaded-album', 12);
  const loaded = await writer.save({ ...album('loaded-album'), revision: 99 });
  const fresh = await writer.save({ ...album('fresh-album'), revision: 99 });
  assert.deepEqual(calls, [['loaded-album', 12], ['fresh-album', 0]]);
  assert.strictEqual(loaded, results[0]);
  assert.strictEqual(fresh, results[1]);
  assert.equal(loaded.album.title, 'Committed title');
});
