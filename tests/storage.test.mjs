import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAlbum, makeId, validateAlbum, serializeAlbum,
  saveDraft, loadDraft, clearDraft, fileToImage,
} from '../dist/storage.js';

const images = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGN8cWkfAwMDAAyQAnrHgabUAAAAAElFTkSuQmCC',
  jpeg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD1aiiiuM7D/9k=',
  webp: 'UklGRjAAAABXRUJQVlA4ICQAAABQAQCdASoCAAEAAUAmJQBOgCgAAP75cr+vWlubhPyOd6VGAAA=',
};

function page(overrides = {}) {
  return { id: makeId(), image: null, imageName: '', date: '', note: '', fit: 'contain', ...overrides };
}

function albumWithImage(value) {
  return { ...createAlbum(), coverImage: value, coverImageName: '写真.jpg' };
}

test('new album has independent valid empty defaults', () => {
  const first = createAlbum();
  const second = createAlbum();
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.title, '思い出のアルバム');
  assert.equal(first.theme, 'linen');
  assert.equal(first.coverImage, null);
  assert.equal(first.backgroundImage, null);
  assert.equal(first.backgroundImageName, '');
  assert.equal(first.backgroundOpacity, 0.22);
  assert.deepEqual(first.pages, []);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.pages, second.pages);
  assert.deepEqual(validateAlbum(first), first);
});

test('older version-one backups normalize missing background fields without changing their content', () => {
  const previous = { ...createAlbum(), title: '以前のアルバム', pages: [page({ note: '  思い出をそのまま\n  ' })] };
  delete previous.backgroundImage;
  delete previous.backgroundImageName;
  delete previous.backgroundOpacity;
  const normalized = validateAlbum(previous);
  assert.deepEqual(normalized, { ...previous, backgroundImage: null, backgroundImageName: '', backgroundOpacity: 0.22 });
  assert.equal(Object.hasOwn(previous, 'backgroundImage'), false);
  assert.deepEqual(JSON.parse(serializeAlbum(previous)), normalized);
  const partial = { ...previous, backgroundImage: `data:image/png;base64,${images.png}` };
  assert.equal(validateAlbum(partial).backgroundImage, partial.backgroundImage);
  assert.equal(validateAlbum(partial).backgroundOpacity, 0.22);
});

test('background images use the same strict safe image and filename validation', () => {
  for (const [type, base64] of Object.entries(images)) {
    const album = { ...createAlbum(), backgroundImage: `data:image/${type};base64,${base64}`, backgroundImageName: '  背景の写真 🌿  ' };
    assert.equal(validateAlbum(album).backgroundImage, album.backgroundImage);
    assert.equal(validateAlbum(album).backgroundImageName, album.backgroundImageName);
  }
  for (const backgroundImage of [undefined, false, {}, 'https://example.com/bg.jpg', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:image/png;base64,YmFk', `data:image/jpeg;base64,${images.png}`]) {
    assert.throws(() => validateAlbum({ ...createAlbum(), backgroundImage }), /写真/);
  }
  for (const backgroundImageName of [undefined, null, 12, 'x'.repeat(261)]) {
    assert.throws(() => validateAlbum({ ...createAlbum(), backgroundImageName }), /背景の写真の名前/);
  }
});

test('background opacity is a finite number between zero and one, with strict own-data fields', () => {
  for (const value of [0, 0.22, 0.7, 1]) {
    assert.equal(validateAlbum({ ...createAlbum(), backgroundOpacity: value }).backgroundOpacity, value);
  }
  for (const value of [undefined, null, '0.22', true, NaN, Infinity, -Infinity, -0.01, 1.01]) {
    assert.throws(() => validateAlbum({ ...createAlbum(), backgroundOpacity: value }), /背景の濃さ/);
  }
  for (const key of ['backgroundImage', 'backgroundImageName', 'backgroundOpacity']) {
    const album = createAlbum();
    let invoked = false;
    Object.defineProperty(album, key, { get() { invoked = true; return undefined; } });
    assert.throws(() => validateAlbum(album), /背景/);
    assert.equal(invoked, false);
  }
});

test('validation preserves all title and note text and makes safe copies', () => {
  const album = { ...createAlbum(), title: '  夏の思い出 🌻  ', subtitle: '家族と\nいっしょに', pages: [page({ note: '  第一日\n「楽しかった！」\n  ' })] };
  const result = validateAlbum(album);
  assert.equal(result.title, album.title);
  assert.equal(result.subtitle, album.subtitle);
  assert.equal(result.pages[0].note, album.pages[0].note);
  assert.notEqual(result, album);
  assert.notEqual(result.pages, album.pages);
  assert.notEqual(result.pages[0], album.pages[0]);
  assert.deepEqual(JSON.parse(serializeAlbum(album)), result);
});

test('validation ignores unknown keys and never copies prototype pollution keys', () => {
  const album = JSON.parse(JSON.stringify(createAlbum()).replace(/}$/, ',"__proto__":{"polluted":true},"extra":"ignore"}'));
  const result = validateAlbum(album);
  assert.equal(Object.hasOwn(result, '__proto__'), false);
  assert.equal(Object.hasOwn(result, 'extra'), false);
  assert.equal({}.polluted, undefined);
});

test('validation rejects inherited fields and getters without invoking them', () => {
  const inherited = Object.create(createAlbum());
  assert.throws(() => validateAlbum(inherited), /アルバム/);
  const album = createAlbum();
  let invoked = false;
  Object.defineProperty(album, 'title', { get() { invoked = true; return 'x'; } });
  assert.throws(() => validateAlbum(album), /タイトル/);
  assert.equal(invoked, false);
  const sparse = { ...createAlbum(), pages: new Array(1) };
  assert.throws(() => validateAlbum(sparse), /ページ/);
});

test('validation enforces exact schema, allowed options, text limits and page count', () => {
  for (const change of [
    { schemaVersion: 2 }, { theme: 'unknown' }, { coverFit: 'stretch' },
    { title: 'x'.repeat(121) }, { subtitle: 'x'.repeat(181) },
    { pages: [page({ note: 'x'.repeat(301) })] }, { pages: [page({ fit: 'stretch' })] },
    { pages: Array.from({ length: 101 }, () => page()) }, { id: '' }, { pages: null },
  ]) assert.throws(() => validateAlbum({ ...createAlbum(), ...change }), /アルバムの形式/);
  const album = { ...createAlbum(), title: '🌻'.repeat(120), pages: Array.from({ length: 100 }, () => page()) };
  assert.equal(validateAlbum(album).pages.length, 100);
  assert.throws(() => validateAlbum({ ...createAlbum(), pages: [page({ id: 'same' }), page({ id: 'same' })] }), /重複/);
});

test('dates reject rollover and malformed values and accept real leap days', () => {
  for (const date of ['2025-02-29', '2024-02-30', '2024-13-01', '2024-00-01', '2024-01-00', '2024-4-01', null]) {
    assert.throws(() => validateAlbum({ ...createAlbum(), pages: [page({ date })] }), /日付/);
  }
  for (const date of ['', '2024-02-29', '2000-02-29', '2025-12-31']) {
    assert.equal(validateAlbum({ ...createAlbum(), pages: [page({ date })] }).pages[0].date, date);
  }
  for (const createdAt of ['2024-02-30T00:00:00.000Z', '2024-01-01T24:00:00Z', 'not a date']) {
    assert.throws(() => validateAlbum({ ...createAlbum(), createdAt }), /作成日時/);
  }
});

test('valid JPEG, PNG and WebP data URLs pass without changing the bytes', () => {
  for (const [type, base64] of Object.entries(images)) {
    const dataUrl = `data:image/${type};base64,${base64}`;
    assert.equal(validateAlbum(albumWithImage(dataUrl)).coverImage, dataUrl);
  }
});

test('URLs, SVG, malformed base64, wrong MIME and broken image containers fail', () => {
  const invalidImages = [
    'javascript:alert(1)', 'https://example.com/photo.jpg', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/png;base64,', 'data:image/png;base64,aaaa=', 'data:image/png;base64,a===',
    'data:image/png;base64,AAAA AA==', 'data:image/png;base64,AB==',
    `data:image/jpeg;base64,${images.png}`, 'data:image/png;base64,PHN2Zz48L3N2Zz4=',
    'data:image/jpeg;base64,/9j/wAAICAABAAEA/9oAAv/Z',
    `data:image/jpeg;base64,${Buffer.from(images.jpeg, 'base64').subarray(0, -2).toString('base64')}`,
    `data:image/png;base64,${Buffer.from(images.png, 'base64').subarray(0, -4).toString('base64')}`,
  ];
  for (const image of invalidImages) assert.throws(() => validateAlbum(albumWithImage(image)), /写真/);
  const bytes = Buffer.from(images.webp, 'base64');
  bytes[4] = 0;
  assert.throws(() => validateAlbum(albumWithImage(`data:image/webp;base64,${bytes.toString('base64')}`)), /写真/);
});

function installFakeIndexedDB(options = {}) {
  const oldDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const state = { closed: 0, value: options.value, deleted: false, written: false };
  const database = {
    close() { state.closed += 1; },
    transaction() {
      const transaction = {
        error: null,
        objectStore() {
          function operation(kind, value) {
            const request = { result: kind === 'get' ? state.value : undefined };
            queueMicrotask(() => {
              request.onsuccess?.();
              if (options.abort) {
                transaction.error = options.abort;
                transaction.onabort?.();
              } else {
                if (kind === 'put') { state.value = value; state.written = true; }
                if (kind === 'delete') { state.value = undefined; state.deleted = true; }
                transaction.oncomplete?.();
              }
            });
            return request;
          }
          return { get: () => operation('get'), put: (value) => operation('put', value), delete: () => operation('delete') };
        },
      };
      return transaction;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open() {
        const request = {};
        queueMicrotask(() => {
          if (options.openError) {
            request.error = options.openError;
            request.onerror?.();
          } else {
            request.result = database;
            if (options.blocked) request.onblocked?.();
            request.onsuccess?.();
          }
        });
        return request;
      },
    },
  });
  return {
    state,
    restore() {
      if (oldDescriptor) Object.defineProperty(globalThis, 'indexedDB', oldDescriptor);
      else delete globalThis.indexedDB;
    },
  };
}

test('print-friendly white theme preserves its background through JSON and draft roundtrips', async () => {
  const album = {
    ...createAlbum(),
    theme: 'plain',
    backgroundImage: `data:image/png;base64,${images.png}`,
    backgroundImageName: '背景 🌿.png',
    backgroundOpacity: 0.63,
  };
  assert.deepEqual(JSON.parse(serializeAlbum(album)), album);
  const fake = installFakeIndexedDB();
  try {
    assert.deepEqual(await saveDraft(album), album);
    assert.deepEqual(await loadDraft(), album);
    assert.equal(fake.state.value.backgroundOpacity, 0.63);
  } finally { fake.restore(); }
});

test('legacy draft records gain background defaults when loaded and saved', async () => {
  const legacy = createAlbum();
  delete legacy.backgroundImage;
  delete legacy.backgroundImageName;
  delete legacy.backgroundOpacity;
  const fake = installFakeIndexedDB({ value: legacy });
  try {
    const loaded = await loadDraft();
    assert.equal(loaded.schemaVersion, 1);
    assert.equal(loaded.backgroundImage, null);
    assert.equal(loaded.backgroundImageName, '');
    assert.equal(loaded.backgroundOpacity, 0.22);
    await saveDraft(loaded);
    assert.deepEqual(fake.state.value, loaded);
  } finally { fake.restore(); }
});

test('draft absence, successful commit, load and clear use one current record', async () => {
  const fake = installFakeIndexedDB();
  try {
    assert.equal(await loadDraft(), null);
    const album = createAlbum();
    assert.deepEqual(await saveDraft(album), album);
    assert.equal(fake.state.written, true);
    assert.deepEqual(await loadDraft(), album);
    await clearDraft();
    assert.equal(fake.state.deleted, true);
    assert.equal(await loadDraft(), null);
    assert.equal(fake.state.closed, 5);
  } finally { fake.restore(); }
});

test('request success followed by quota rollback rejects save and closes connection', async () => {
  const fake = installFakeIndexedDB({ abort: new DOMException('full', 'QuotaExceededError') });
  try {
    await assert.rejects(saveDraft(createAlbum()), /保存容量/);
    assert.equal(fake.state.written, false);
    assert.equal(fake.state.closed, 1);
  } finally { fake.restore(); }
});

test('denied IDB, blocked connections and corrupted drafts never masquerade as an empty draft', async () => {
  for (const options of [
    { openError: new DOMException('denied', 'SecurityError') },
    { blocked: true },
    { value: { broken: true } },
  ]) {
    const fake = installFakeIndexedDB(options);
    try {
      await assert.rejects(loadDraft(), /保存|タブ|読み込めません/);
      if (options.blocked) assert.equal(fake.state.closed, 1);
    } finally { fake.restore(); }
  }
});

test('unavailable IndexedDB gives an explicit error', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  try { await assert.rejects(loadDraft(), /保存を利用できません/); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
    else delete globalThis.indexedDB;
  }
});

test('photo intake rejects empty, oversized, SVG and disguised non-image files', async () => {
  await assert.rejects(fileToImage(null), /ファイル/);
  await assert.rejects(fileToImage(new Blob()), /ファイル/);
  const oversized = new Blob(['x'], { type: 'image/jpeg' });
  Object.defineProperty(oversized, 'size', { value: 30 * 1024 * 1024 + 1 });
  await assert.rejects(fileToImage(oversized), /30MB/);
  await assert.rejects(fileToImage(new Blob(['<svg/>'], { type: 'image/svg+xml' })), /形式/);
  await assert.rejects(fileToImage(new Blob(['<svg/>'], { type: 'image/png' })), /読み込めません/);
});

test('photo conversion honors orientation, bounds size, uses white JPEG and disposes resources', async () => {
  const names = ['createImageBitmap', 'document', 'FileReader'];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const calls = [];
  let closed = 0;
  let drawError = false;
  const canvases = [];
  const mockGlobals = {
    createImageBitmap: async (_file, options) => {
      assert.deepEqual(options, { imageOrientation: 'from-image' });
      return { width: 4000, height: 2000, close() { closed += 1; } };
    },
    document: {
      createElement(name) {
        assert.equal(name, 'canvas');
        const context = {
          fillRect(...arguments_) { calls.push(['fill', this.fillStyle, ...arguments_]); },
          drawImage(_source, ...arguments_) {
            if (drawError) throw new Error('draw failure');
            calls.push(['draw', ...arguments_]);
          },
        };
        const canvas = {
          getContext: () => context,
          toBlob(callback, type, quality) {
            assert.equal(type, 'image/jpeg');
            assert.equal(quality, 0.92);
            callback(new Blob([Buffer.from(images.jpeg, 'base64')], { type }));
          },
        };
        canvases.push(canvas);
        return canvas;
      },
    },
    FileReader: class {
      readAsDataURL(blob) {
        blob.arrayBuffer().then((bytes) => {
          this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;
          this.onload();
        });
      }
    },
  };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: mockGlobals[name] });
  try {
    const file = new Blob([Buffer.from(images.png, 'base64')], { type: 'image/png' });
    Object.defineProperty(file, 'name', { value: '家族.png' });
    const result = await fileToImage(file);
    assert.equal(result.name, '家族.png');
    assert.equal(result.width, 2400);
    assert.equal(result.height, 1200);
    assert.equal(result.dataUrl, `data:image/jpeg;base64,${images.jpeg}`);
    assert.deepEqual(calls, [['fill', '#ffffff', 0, 0, 2400, 1200], ['draw', 0, 0, 2400, 1200]]);
    assert.equal(closed, 1);
    assert.equal(canvases[0].width, 0);
    assert.equal(canvases[0].height, 0);
    drawError = true;
    await assert.rejects(fileToImage(file), /読み込めません/);
    assert.equal(closed, 2);
    assert.equal(canvases[1].width, 0);
  } finally {
    for (const name of names) {
      const original = originals.get(name);
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    }
  }
});
