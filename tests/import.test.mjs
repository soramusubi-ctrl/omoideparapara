import test from 'node:test';
import assert from 'node:assert/strict';
import { readAlbumFile, decodeAlbumImages } from '../dist/album-import.js';
import { createAlbum, validateAlbum, makeId } from '../dist/storage.js';
import { MAX_PROJECT_BYTES } from '../dist/album-limits.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGN8cWkfAwMDAAyQAnrHgabUAAAAAElFTkSuQmCC';
const WEBP = 'data:image/webp;base64,UklGRjAAAABXRUJQVlA4ICQAAABQAQCdASoCAAEAAUAmJQBOgCgAAP75cr+vWlubhPyOd6VGAAA=';
const page = (overrides = {}) => ({ id: makeId(), image: null, imageName: '', date: '', note: '', fit: 'contain', frame: 'none', ...overrides });
const tick = () => new Promise(resolve => setImmediate(resolve));
const imageContexts = new WeakSet();

function fileText(text, overrides = {}) {
  return { name: '思い出.album.json', type: 'application/json', size: Buffer.byteLength(text), text: async () => text, ...overrides };
}

function imageGlobal(t, value) {
  if (!imageContexts.has(t)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'Image');
    imageContexts.add(t);
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, 'Image', previous);
      else delete globalThis.Image;
    });
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value });
}

function stubImages(t, behavior = {}) {
  const instances = [];
  class TestImage {
    constructor() {
      this.naturalWidth = behavior.width ?? 2;
      this.naturalHeight = behavior.height ?? 1;
      this.decodeCalls = 0;
      instances.push(this);
    }
    set src(value) {
      this.source = value;
      if (!value) return;
      if (behavior.throwSource) throw new Error('cannot set source');
      queueMicrotask(() => {
        if (behavior.fail?.(this)) this.onerror?.();
        else this.onload?.();
      });
    }
    decode() {
      this.decodeCalls += 1;
      return behavior.decode ? behavior.decode(this) : Promise.resolve();
    }
    removeAttribute(name) {
      assert.equal(name, 'src');
      this.released = true;
    }
  }
  imageGlobal(t, TestImage);
  return instances;
}

test('an editable file returns the normalized album itself with all feature choices intact', async () => {
  const album = {
    ...createAlbum(), title: '  思い出 📚  ', theme: 'plain', font: 'rounded', coverFrame: 'polaroid',
    coverImage: PNG, coverImageName: '表紙.png', backgroundImage: WEBP, backgroundImageName: '背景.webp', backgroundOpacity: 0,
    pages: [page({ image: PNG, imageName: '写真.png', date: '2024-02-29', note: '  大切な日\nそのまま  ', frame: 'rounded' })],
  };
  const before = JSON.stringify(album);
  const result = await readAlbumFile(fileText(before));
  assert.deepEqual(result, validateAlbum(album));
  assert.equal(result.id, album.id);
  assert.equal(Object.hasOwn(result, 'album'), false);
  assert.equal(JSON.stringify(album), before);
});

test('legacy v1 fields and a leading UTF-8 BOM are normalized without losing text', async () => {
  const album = { ...createAlbum(), pages: [page({ note: '  記録\n  ' })] };
  for (const key of ['font', 'coverFrame', 'backgroundImage', 'backgroundImageName', 'backgroundOpacity']) delete album[key];
  delete album.pages[0].frame;
  const result = await readAlbumFile(fileText('\uFEFF' + JSON.stringify(album)));
  assert.equal(result.font, 'serif');
  assert.equal(result.coverFrame, 'none');
  assert.equal(result.pages[0].frame, 'none');
  assert.equal(result.backgroundImage, null);
  assert.equal(result.pages[0].note, album.pages[0].note);
});

test('valid JSON content is accepted with empty, octet-stream, or misleading MIME and filename', async () => {
  const album = createAlbum();
  for (const type of ['', 'application/octet-stream', 'application/json', 'text/plain', 'application/pdf', 'image/png']) {
    const blob = new Blob([JSON.stringify(album)], { type });
    Object.defineProperty(blob, 'name', { value: type === 'image/png' ? 'renamed.png' : 'backup.dat' });
    assert.deepEqual(await readAlbumFile(blob), album);
  }
});

test('oversized and empty files are rejected before any body or header read', async () => {
  let reads = 0;
  const file = { name: 'huge.album.json', text() { reads += 1; throw new Error('must not read'); }, slice() { reads += 1; throw new Error('must not read'); } };
  await assert.rejects(readAlbumFile({ ...file, size: MAX_PROJECT_BYTES + 1 }), /200MiB/);
  await assert.rejects(readAlbumFile({ ...file, size: 0 }), /空/);
  assert.equal(reads, 0);
  const album = createAlbum();
  assert.deepEqual(await readAlbumFile(fileText(JSON.stringify(album), { size: MAX_PROJECT_BYTES })), album);
});

test('invalid file objects and disk read errors produce actionable Japanese explanations', async () => {
  for (const file of [null, undefined, {}, { size: 1 }, fileText('{}', { size: NaN }), fileText('{}', { size: -1 })]) {
    await assert.rejects(readAlbumFile(file), /ファイルを選んで/);
  }
  await assert.rejects(readAlbumFile(fileText('{}', { text: async () => { throw new Error('disk'); } })), /ダウンロード.*保管/);
});

test('PDF and image exports are recognized by bytes and never parsed as editable backups', async () => {
  for (const [bytes, message] of [[Buffer.from('%PDF-1.7\n'), /PDF.*復元できません/], [Buffer.from(PNG.split(',')[1], 'base64'), /PNG.*復元できません/]]) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    Object.defineProperty(blob, 'name', { value: 'unknown.dat' });
    Object.defineProperty(blob, 'text', { value: async () => { assert.fail('Binary exports must not read their entire body.'); } });
    await assert.rejects(readAlbumFile(blob), message);
  }
  await assert.rejects(readAlbumFile(fileText('%PDF-1.7\n', { name: 'export.pdf', type: '' })), /PDF.*復元できません/);
  await assert.rejects(readAlbumFile(fileText('binary image', { name: 'export.PNG', type: '' })), /PNG.*復元できません/);
});

test('malformed JSON asks the user to keep the failed file and choose editable data', async () => {
  for (const text of ['{', ' ', 'not JSON']) {
    await assert.rejects(readAlbumFile(fileText(text)), /JSON.*削除・上書きせず.*保管.*\.album\.json/);
  }
});

test('metadata, image containers, external URLs and dates retain strict validation', async () => {
  const original = createAlbum();
  for (const [album, message] of [
    [{ ...original, schemaVersion: 99 }, /バージョン/],
    [{ ...original, coverImage: 'https://example.com/photo.png' }, /写真/],
    [{ ...original, backgroundImage: 'data:image/png;base64,YmFk' }, /写真/],
    [{ ...original, pages: [page({ date: '2026-02-30' })] }, /日付/],
  ]) {
    await assert.rejects(readAlbumFile(fileText(JSON.stringify(album))), message);
  }
  assert.equal(original.coverImage, null);
  assert.deepEqual(original.pages, []);
});

test('image-free imports need no image API, while images cannot silently skip browser decoding', async t => {
  imageGlobal(t, undefined);
  const progress = [];
  assert.equal(await decodeAlbumImages(createAlbum(), { onProgress: value => progress.push(value) }), undefined);
  assert.deepEqual(progress, [{ current: 0, total: 0 }]);
  await assert.rejects(decodeAlbumImages({ ...createAlbum(), coverImage: PNG }), /ブラウザー/);
});

test('cover, hidden background and page images decode once per distinct source and release resources', async t => {
  const instances = stubImages(t);
  const album = { ...createAlbum(), theme: 'plain', backgroundOpacity: 0, coverImage: PNG, backgroundImage: WEBP, pages: [page({ image: PNG }), page({ image: WEBP })] };
  const before = JSON.stringify(album);
  const progress = [];
  assert.equal(await decodeAlbumImages(album, { onProgress: value => progress.push(value) }), undefined);
  assert.deepEqual(instances.map(image => image.source), [PNG, WEBP]);
  assert.ok(instances.every(image => image.decodeCalls === 1 && image.released && image.onload === null && image.onerror === null));
  assert.deepEqual(progress, [{ current: 0, total: 2 }, { current: 1, total: 2 }, { current: 2, total: 2 }]);
  assert.equal(JSON.stringify(album), before);
});

test('import waits for the browser decode promise before reporting the image as complete', async t => {
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const instances = stubImages(t, { decode: () => ready });
  const progress = [];
  let completed = false;
  const pending = decodeAlbumImages({ ...createAlbum(), coverImage: PNG }, { onProgress: value => progress.push(value) }).then(() => { completed = true; });
  await tick();
  assert.equal(completed, false);
  assert.equal(instances[0].released, undefined);
  assert.deepEqual(progress, [{ current: 0, total: 1 }]);
  finish();
  await pending;
  assert.equal(instances[0].released, true);
  assert.deepEqual(progress.at(-1), { current: 1, total: 1 });
});

test('a failed image stops import before completion and does not mutate the candidate album', async t => {
  const instances = stubImages(t, { fail: image => image.source === WEBP });
  const album = { ...createAlbum(), coverImage: PNG, backgroundImage: WEBP, pages: [page({ image: PNG })] };
  const before = JSON.stringify(album);
  const progress = [];
  await assert.rejects(decodeAlbumImages(album, { onProgress: value => progress.push(value) }), /読み込めない画像.*保管/);
  assert.deepEqual(progress, [{ current: 0, total: 2 }, { current: 1, total: 2 }]);
  assert.ok(instances.every(image => image.released && image.onload === null && image.onerror === null));
  assert.equal(JSON.stringify(album), before);
});

test('decode rejection after onload and synchronous source errors both fail with cleanup', async t => {
  const instances = stubImages(t, { decode: () => Promise.reject(new Error('bad pixels')) });
  await assert.rejects(decodeAlbumImages({ ...createAlbum(), coverImage: PNG }), /読み込めない画像.*bad pixels/);
  assert.equal(instances[0].released, true);
  const throwing = stubImages(t, { throwSource: true });
  await assert.rejects(decodeAlbumImages({ ...createAlbum(), coverImage: PNG }), /読み込めない画像/);
  assert.equal(throwing[0].released, true);
});

test('zero, nonfinite and excessive image dimensions reject before pixel decoding', async t => {
  for (const [width, height] of [[0, 1], [2, 0], [NaN, 1], [Infinity, 1], [20000, 10000]]) {
    const instances = stubImages(t, { width, height });
    await assert.rejects(decodeAlbumImages({ ...createAlbum(), coverImage: PNG }), /画像サイズ/);
    assert.equal(instances[0].decodeCalls, 0);
    assert.equal(instances[0].released, true);
  }
});

test('direct decoder calls validate first and never load an external image URL', async t => {
  const instances = stubImages(t);
  await assert.rejects(decodeAlbumImages({ ...createAlbum(), coverImage: 'https://example.com/photo.jpg' }), /写真/);
  assert.equal(instances.length, 0);
});
