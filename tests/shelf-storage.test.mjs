import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createAlbum, validateAlbum } from '../dist/storage.js';
import {
  migrateLegacyDraft, listAlbums, loadSavedAlbum, saveAlbum, readLegacyDraft,
} from '../dist/shelf-storage.js';

const require = createRequire(import.meta.url);
let idb;
try { idb = require('fake-indexeddb'); } catch { /* Optional test-only dependency. */ }
const shelfTest = (name, callback) => test(name, { skip: !idb && 'Install fake-indexeddb outside the app, then include its node_modules in NODE_PATH.' }, callback);
const ALBUM = 'shelf:album:';
const SUMMARY = 'shelf:summary:';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGN8cWkfAwMDAAyQAnrHgabUAAAAAElFTkSuQmCC';
const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD1aiiiuM7D/9k=';

function fixture() {
  const previous = new Map(['indexedDB', 'IDBKeyRange'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const factory = new idb.IDBFactory();
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
  Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: idb.IDBKeyRange });
  async function connection() {
    return new Promise((resolve, reject) => {
      const request = factory.open('memory-album', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
  async function operation(mode, callback) {
    const database = await connection();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('drafts', mode);
        const request = callback(transaction.objectStore('drafts'));
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }
  return {
    factory, connection,
    get: key => operation('readonly', store => store.get(key)),
    put: (key, value) => operation('readwrite', store => store.put(value, key)),
    remove: key => operation('readwrite', store => store.delete(key)),
    keys: () => operation('readonly', store => store.getAllKeys()),
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

function summary(album, thumbnail = null) {
  return { id: album.id, title: album.title, subtitle: album.subtitle, theme: album.theme, coverStyle: album.coverStyle, pageCount: album.pages.length, createdAt: album.createdAt, updatedAt: album.updatedAt, thumbnail };
}

function photo(overrides = {}) {
  return { id: 'page-1', image: null, imageName: '', date: '', note: '', fit: 'contain', frame: 'none', ...overrides };
}

function expectCode(code) { return error => error instanceof Error && error.code === code; }

function mockGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  });
}

shelfTest('an untouched version-one database is empty and keeps the old current key absent', async () => {
  const db = fixture();
  try {
    assert.deepEqual(await migrateLegacyDraft(), { found: false, migrated: false, invalid: false });
    assert.equal(await readLegacyDraft(), null);
    assert.deepEqual(await listAlbums(), []);
    assert.equal(await loadSavedAlbum('missing'), null);
    assert.deepEqual(await db.keys(), []);
    const connection = await db.connection();
    assert.equal(connection.version, 1);
    assert.deepEqual([...connection.objectStoreNames], ['drafts']);
    connection.close();
  } finally { db.restore(); }
});

shelfTest('legacy current migrates once, normalizes old fields, and remains byte-for-byte recoverable', async () => {
  const db = fixture();
  try {
    const legacy = { ...createAlbum(), title: '  以前の一冊  ', coverImage: png, pages: [photo({ note: 'そのまま\n残したい 🌿', frame: 'corners' })] };
    delete legacy.font;
    delete legacy.backgroundImage;
    delete legacy.backgroundImageName;
    delete legacy.backgroundOpacity;
    delete legacy.coverFrame;
    delete legacy.coverStyle;
    await db.put('current', legacy);
    const original = JSON.stringify(await readLegacyDraft());
    assert.deepEqual(await migrateLegacyDraft(), { found: true, migrated: true, invalid: false, albumId: legacy.id });
    const expected = validateAlbum(legacy);
    assert.deepEqual(await loadSavedAlbum(legacy.id), { album: expected, revision: 1 });
    assert.deepEqual(await migrateLegacyDraft(), { found: true, migrated: false, invalid: false, albumId: legacy.id });
    assert.deepEqual(await listAlbums(), [summary(expected)]);
    assert.equal(JSON.stringify(await readLegacyDraft()), original);
    const edited = { ...expected, title: '本棚で更新した本' };
    await saveAlbum(edited, { expectedRevision: 1 });
    await migrateLegacyDraft();
    assert.deepEqual(await loadSavedAlbum(legacy.id), { album: edited, revision: 2 });
    assert.equal(JSON.stringify(await db.get('current')), original);
  } finally { db.restore(); }
});

shelfTest('concurrent legacy migrations copy only once and never overwrite an existing same-id record', async () => {
  const db = fixture();
  try {
    const legacy = createAlbum();
    await db.put('current', legacy);
    const results = await Promise.all([migrateLegacyDraft(), migrateLegacyDraft()]);
    assert.equal(results.filter(result => result.migrated).length, 1);
    assert.equal((await loadSavedAlbum(legacy.id)).revision, 1);
    const corrupt = { album: 'unreadable', revision: 'unknown' };
    await db.put(ALBUM + legacy.id, corrupt);
    assert.equal((await migrateLegacyDraft()).migrated, false);
    assert.deepEqual(await db.get(ALBUM + legacy.id), corrupt);
    assert.deepEqual(await db.get('current'), legacy);
  } finally { db.restore(); }
});

shelfTest('invalid legacy values stay untouched while new books can still save and list', async () => {
  for (const raw of [null, undefined, 'broken', { schemaVersion: 99 }, { ...createAlbum(), coverImage: 'javascript:alert(1)' }]) {
    const db = fixture();
    try {
      await db.put('current', raw);
      assert.deepEqual(await migrateLegacyDraft(), { found: true, migrated: false, invalid: true });
      const album = { ...createAlbum(), title: '新しく作る本' };
      await saveAlbum(album);
      assert.deepEqual(await listAlbums(), [summary(album)]);
      assert.deepEqual(await db.get('current'), raw);
      assert.deepEqual(await readLegacyDraft(), raw === undefined ? null : raw);
    } finally { db.restore(); }
  }
});

shelfTest('several independent books survive new connections and a fresh module load', async () => {
  const db = fixture();
  try {
    const albums = [
      { ...createAlbum(), id: 'morning', title: '朝の本', updatedAt: '2026-10-15T20:00:00+09:00', coverImage: png, pages: [photo({ image: png, note: '  最初の思い出\n  ' })] },
      { ...createAlbum(), id: 'noon', title: '昼の本', updatedAt: '2026-10-15T12:00:00.000Z', font: 'rounded', coverFrame: 'rounded' },
      { ...createAlbum(), id: '\uffff:last', title: '夜の本', updatedAt: '2026-10-15T13:00:00.000Z', backgroundImage: png },
    ];
    for (const album of albums) assert.deepEqual(await saveAlbum(album), { album, revision: 1 });
    const reloaded = await import(`../dist/shelf-storage.js?reload=${Date.now()}`);
    for (const album of albums) assert.deepEqual(await reloaded.loadSavedAlbum(album.id), { album, revision: 1 });
    assert.deepEqual((await reloaded.listAlbums()).map(item => item.id), ['\uffff:last', 'noon', 'morning']);
    assert.equal(await db.get('current'), undefined);
    assert.deepEqual((await db.keys()).sort(), albums.flatMap(album => [ALBUM + album.id, SUMMARY + album.id]).sort());
  } finally { db.restore(); }
});

shelfTest('both cover styles persist in saved albums and metadata summaries across CAS updates', async () => {
  const db = fixture();
  try {
    const classic = { ...createAlbum(), title: 'いつもの表紙', coverStyle: 'classic' };
    const scrapbook = { ...createAlbum(), title: 'スクラップ表紙', coverStyle: 'scrapbook', pages: [photo()] };
    await saveAlbum(classic);
    await saveAlbum(scrapbook);
    for (const album of [classic, scrapbook]) {
      assert.deepEqual(await loadSavedAlbum(album.id), { album, revision: 1 });
      assert.deepEqual(await db.get(SUMMARY + album.id), summary(album));
    }
    assert.deepEqual(new Set((await listAlbums()).map(item => item.coverStyle)), new Set(['classic', 'scrapbook']));
    const changed = { ...classic, coverStyle: 'scrapbook' };
    assert.deepEqual(await saveAlbum(changed, { expectedRevision: 1 }), { album: changed, revision: 2 });
    assert.equal((await listAlbums()).find(item => item.id === classic.id).coverStyle, 'scrapbook');
    assert.deepEqual(await db.get(SUMMARY + classic.id), summary(changed));
    assert.equal(await db.get('current'), undefined);
  } finally { db.restore(); }
});

shelfTest('legacy album and summary styles normalize to classic without rewriting raw records or breaking CAS', async () => {
  const db = fixture();
  try {
    const legacy = { ...createAlbum(), title: '  以前の表紙  ' };
    delete legacy.coverStyle;
    const oldSummary = summary(legacy);
    delete oldSummary.coverStyle;
    const oldRecord = { album: legacy, revision: 7 };
    await db.put('current', legacy);
    await db.put(ALBUM + legacy.id, oldRecord);
    await db.put(SUMMARY + legacy.id, oldSummary);
    assert.deepEqual(await listAlbums(), [{ ...oldSummary, coverStyle: 'classic' }]);
    const loaded = await loadSavedAlbum(legacy.id);
    assert.deepEqual(loaded, { album: { ...legacy, coverStyle: 'classic' }, revision: 7 });
    assert.deepEqual(await db.get(ALBUM + legacy.id), oldRecord);
    assert.deepEqual(await db.get(SUMMARY + legacy.id), oldSummary);
    assert.deepEqual(await db.get('current'), legacy);
    const changed = { ...loaded.album, coverStyle: 'scrapbook' };
    assert.deepEqual(await saveAlbum(changed, { expectedRevision: 7 }), { album: changed, revision: 8 });
    assert.deepEqual(await db.get(SUMMARY + legacy.id), summary(changed));
    assert.deepEqual(await db.get('current'), legacy);
    const connection = await db.connection();
    assert.equal(connection.version, 1);
    connection.close();
  } finally { db.restore(); }
});

shelfTest('listing reads only the summary prefix and never clones full saved albums with getAll', async t => {
  const db = fixture();
  try {
    const album = { ...createAlbum(), coverImage: png, backgroundImage: png, pages: [photo({ image: png })] };
    await saveAlbum(album);
    await db.put('unrelated-large-value', 'x'.repeat(1024 * 1024));
    const openCursor = idb.IDBObjectStore.prototype.openCursor;
    const seen = [];
    t.mock.method(idb.IDBObjectStore.prototype, 'getAll', () => { throw new Error('Full-store getAll is forbidden'); });
    t.mock.method(idb.IDBObjectStore.prototype, 'getAllKeys', () => { throw new Error('Full-store getAllKeys is forbidden'); });
    t.mock.method(idb.IDBObjectStore.prototype, 'openCursor', function (query, direction) {
      seen.push(query);
      if (typeof query === 'string') assert.equal(query, 'current');
      else {
        assert.equal(query.lower, SUMMARY);
        assert.equal(query.upper, 'shelf:summary;');
        assert.equal(query.upperOpen, true);
      }
      return openCursor.call(this, query, direction);
    });
    assert.deepEqual(await listAlbums(), [summary(album)]);
    assert.equal(seen.length, 2);
    const storedSummary = await db.get(SUMMARY + album.id);
    assert.deepEqual(Object.keys(storedSummary), ['id', 'title', 'subtitle', 'theme', 'coverStyle', 'pageCount', 'createdAt', 'updatedAt', 'thumbnail']);
    assert.equal(JSON.stringify(storedSummary).includes(png), false);
  } finally { db.restore(); }
});

shelfTest('cross-tab same-revision writers serialize CAS and only one update succeeds', async () => {
  const db = fixture();
  try {
    const album = createAlbum();
    await saveAlbum(album);
    const candidates = [{ ...album, title: 'タブA' }, { ...album, title: 'タブB' }];
    const results = await Promise.allSettled(candidates.map(candidate => saveAlbum(candidate, { expectedRevision: 1 })));
    const winner = results.find(result => result.status === 'fulfilled').value;
    const loser = results.find(result => result.status === 'rejected').reason;
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(winner.revision, 2);
    assert.equal(loser.code, 'ALBUM_CONFLICT');
    assert.equal(loser.actualRevision, 2);
    assert.deepEqual(await loadSavedAlbum(album.id), winner);
    assert.deepEqual(await db.get(SUMMARY + album.id), summary(winner.album));
    await assert.rejects(saveAlbum({ ...album, title: '古いタブ' }), expectCode('ALBUM_CONFLICT'));
    await assert.rejects(saveAlbum({ ...createAlbum(), id: 'never-saved' }, { expectedRevision: 2 }), expectCode('ALBUM_CONFLICT'));
  } finally { db.restore(); }
});

shelfTest('a failed summary request rolls back the album request that already succeeded', async t => {
  const db = fixture();
  try {
    const album = createAlbum();
    await saveAlbum(album);
    const put = idb.IDBObjectStore.prototype.put;
    let albumRequestSucceeded = false;
    t.mock.method(idb.IDBObjectStore.prototype, 'put', function (value, key) {
      if (key.startsWith(SUMMARY)) return this.add(value, key); // Existing summary causes a request error.
      const request = put.call(this, value, key);
      request.addEventListener('success', () => { albumRequestSucceeded = true; });
      return request;
    });
    await assert.rejects(saveAlbum({ ...album, title: 'この変更は戻る' }, { expectedRevision: 1 }), expectCode('ALBUM_STORAGE_ERROR'));
    assert.equal(albumRequestSucceeded, true);
    assert.deepEqual(await loadSavedAlbum(album.id), { album, revision: 1 });
    assert.deepEqual(await db.get(SUMMARY + album.id), summary(album));
  } finally { db.restore(); }
});

shelfTest('successful put requests followed by transaction abort never count as a successful save', async t => {
  const db = fixture();
  try {
    const album = createAlbum();
    await saveAlbum(album);
    const put = idb.IDBObjectStore.prototype.put;
    const successes = [];
    t.mock.method(idb.IDBObjectStore.prototype, 'put', function (value, key) {
      const request = put.call(this, value, key);
      const transaction = this.transaction;
      request.addEventListener('success', () => {
        successes.push(key);
        if (key.startsWith(SUMMARY)) transaction.abort();
      });
      return request;
    });
    await assert.rejects(saveAlbum({ ...album, title: 'コミット前に失敗' }, { expectedRevision: 1 }), expectCode('ALBUM_STORAGE_ERROR'));
    assert.deepEqual(successes, [ALBUM + album.id, SUMMARY + album.id]);
    assert.deepEqual(await loadSavedAlbum(album.id), { album, revision: 1 });
    assert.deepEqual(await db.get(SUMMARY + album.id), summary(album));
  } finally { db.restore(); }
});

shelfTest('quota failure during migration or a new save leaves legacy and both shelf records intact', async t => {
  const db = fixture();
  try {
    const legacy = createAlbum();
    await db.put('current', legacy);
    const put = idb.IDBObjectStore.prototype.put;
    t.mock.method(idb.IDBObjectStore.prototype, 'put', function (value, key) {
      if (key.startsWith(SUMMARY)) throw new DOMException('full', 'QuotaExceededError');
      return put.call(this, value, key);
    });
    await assert.rejects(migrateLegacyDraft(), expectCode('ALBUM_STORAGE_FULL'));
    assert.deepEqual(await db.get('current'), legacy);
    assert.equal(await db.get(ALBUM + legacy.id), undefined);
    assert.equal(await db.get(SUMMARY + legacy.id), undefined);
    const newAlbum = createAlbum();
    await assert.rejects(saveAlbum(newAlbum), expectCode('ALBUM_STORAGE_FULL'));
    assert.equal(await db.get(ALBUM + newAlbum.id), undefined);
    assert.equal(await db.get(SUMMARY + newAlbum.id), undefined);
    assert.deepEqual(await readLegacyDraft(), legacy);
  } finally { db.restore(); }
});

shelfTest('corrupt wrappers, orphan records and mismatched summaries cannot be overwritten', async () => {
  const candidate = createAlbum();
  const badPairs = [
    [{ album: candidate, revision: 0 }, summary(candidate)],
    [{ album: candidate, revision: '1' }, summary(candidate)],
    [{ album: null, revision: 1 }, summary(candidate)],
    [{ album: { ...candidate, id: 'wrong' }, revision: 1 }, summary(candidate)],
    [undefined, summary(candidate)],
    [{ album: candidate, revision: 1 }, undefined],
    [{ album: candidate, revision: 1 }, { ...summary(candidate), title: 'mismatch' }],
    [{ album: candidate, revision: 1 }, { ...summary(candidate), coverStyle: 'scrapbook' }],
    [{ album: candidate, revision: 1 }, { ...summary(candidate), coverStyle: 'invalid' }],
    [{ album: candidate, revision: 1 }, { ...summary(candidate), coverStyle: undefined }],
    [{ album: candidate, revision: 1 }, { ...summary(candidate), thumbnail: png }],
    [{ album: candidate, revision: 1 }, { ...summary(candidate), pageCount: 101 }],
  ];
  for (const [record, metadata] of badPairs) {
    const db = fixture();
    try {
      const legacy = { ...createAlbum(), title: '元の復旧用データ' };
      await db.put('current', legacy);
      if (record !== undefined) await db.put(ALBUM + candidate.id, record);
      if (metadata !== undefined) await db.put(SUMMARY + candidate.id, metadata);
      await assert.rejects(saveAlbum({ ...candidate, title: '上書き禁止' }, { expectedRevision: 1 }), expectCode('ALBUM_CORRUPT'));
      assert.deepEqual(await db.get(ALBUM + candidate.id), record);
      assert.deepEqual(await db.get(SUMMARY + candidate.id), metadata);
      assert.deepEqual(await db.get('current'), legacy);
    } finally { db.restore(); }
  }
});

shelfTest('stored undefined is corruption rather than absence, and malformed loads do not return empty albums', async () => {
  const db = fixture();
  try {
    const album = createAlbum();
    await db.put(ALBUM + album.id, undefined);
    await assert.rejects(loadSavedAlbum(album.id), expectCode('ALBUM_CORRUPT'));
    await assert.rejects(saveAlbum(album), expectCode('ALBUM_CORRUPT'));
    assert.equal(await loadSavedAlbum('absent'), null);
    for (const revision of [-1, NaN, Infinity, 1.5, '1']) {
      await assert.rejects(saveAlbum(createAlbum(), { expectedRevision: revision }), expectCode('ALBUM_INVALID'));
    }
    await assert.rejects(loadSavedAlbum(''), expectCode('ALBUM_INVALID'));
  } finally { db.restore(); }
});

function mockImages(t, { fail = false } = {}) {
  const canvases = [];
  const images = [];
  let decodes = 0;
  class ImageMock {
    constructor() { this.naturalWidth = 1240; this.naturalHeight = 1754; images.push(this); }
    set src(value) {
      this.url = value;
      if (value) {
        decodes += 1;
        queueMicrotask(() => fail ? this.onerror?.(new Error('decode failed')) : this.onload?.());
      }
    }
    get src() { return this.url; }
  }
  mockGlobal(t, 'Image', ImageMock);
  mockGlobal(t, 'document', {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0, height: 0,
        getContext: () => ({ fillStyle: '', fillRect() { assert.equal(this.fillStyle, '#ffffff'); }, drawImage(_image, x, y, width, height) { assert.deepEqual([x, y, width, height], [0, 0, 160, 226]); } }),
        toDataURL(type, quality) { assert.equal(type, 'image/jpeg'); assert.equal(quality, 0.78); return jpeg; },
      };
      canvases.push(canvas);
      return canvas;
    },
  });
  return { images, canvases, get decodes() { return decodes; } };
}

function commentedCover(comment) {
  const bytes = Buffer.from(jpeg.split(',')[1], 'base64');
  const text = Buffer.from(comment);
  const marker = Buffer.from([255, 254, (text.length + 2) >> 8, (text.length + 2) & 255]);
  return 'data:image/jpeg;base64,' + Buffer.concat([bytes.subarray(0, 2), marker, text, bytes.subarray(2)]).toString('base64');
}

shelfTest('optional browser thumbnails are small white-backed JPEGs, cached by cover and cleaned up', async t => {
  const db = fixture();
  try {
    const browser = mockImages(t);
    const first = { ...createAlbum(), coverImage: png };
    const second = { ...createAlbum(), coverImage: png };
    await saveAlbum(first);
    await saveAlbum(second);
    assert.equal(browser.decodes, 1);
    const summaries = await listAlbums();
    assert.equal(summaries.length, 2);
    assert.ok(summaries.every(item => item.thumbnail === jpeg));
    assert.ok(summaries.every(item => !JSON.stringify(item).includes(png)));
    assert.equal(browser.canvases[0].width, 0);
    assert.equal(browser.canvases[0].height, 0);
    assert.equal(browser.images[0].src, '');
    assert.equal(browser.images[0].onload, null);
  } finally { db.restore(); }
});

shelfTest('thumbnail decode failure never prevents saving the original cover', async t => {
  const db = fixture();
  try {
    const browser = mockImages(t, { fail: true });
    const album = { ...createAlbum(), coverImage: commentedCover('thumbnail-failure') };
    await saveAlbum(album);
    assert.deepEqual(await loadSavedAlbum(album.id), { album, revision: 1 });
    assert.equal((await listAlbums())[0].thumbnail, null);
    assert.equal(browser.images[0].src, '');
    assert.equal(browser.images[0].onerror, null);
  } finally { db.restore(); }
});

shelfTest('thumbnail cover cache is bounded rather than retaining every old full-size image', async t => {
  const db = fixture();
  try {
    const browser = mockImages(t);
    const covers = Array.from({ length: 9 }, (_, index) => commentedCover(`bounded-cache-${index}`));
    for (const coverImage of covers) await saveAlbum({ ...createAlbum(), coverImage });
    assert.equal(browser.decodes, 9);
    await saveAlbum({ ...createAlbum(), coverImage: covers[8] });
    assert.equal(browser.decodes, 9);
    await saveAlbum({ ...createAlbum(), coverImage: covers[0] });
    assert.equal(browser.decodes, 10);
  } finally { db.restore(); }
});

shelfTest('unavailable or denied IndexedDB reports an honest Japanese error', async t => {
  mockGlobal(t, 'indexedDB', undefined);
  await assert.rejects(listAlbums(), error => error.code === 'ALBUM_STORAGE_DENIED' && /保存を利用できません/.test(error.message));
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() { throw new DOMException('denied', 'SecurityError'); } } });
  await assert.rejects(readLegacyDraft(), error => error.code === 'ALBUM_STORAGE_DENIED' && /許可/.test(error.message));
});
