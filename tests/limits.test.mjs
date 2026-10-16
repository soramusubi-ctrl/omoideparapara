import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateProjectBytes, assertProjectBudget, MAX_PROJECT_BYTES } from '../dist/album-limits.js';
import { createAlbum } from '../dist/storage.js';

test('budget safely covers the exact UTF-8 backup including duplicate cover and background images', () => {
  const album = createAlbum();
  album.title = '旅の📚アルバム';
  album.coverImage = 'data:image/jpeg;base64,' + 'abcd'.repeat(8 * 1024);
  album.backgroundImage = album.coverImage;
  album.backgroundImageName = '旅の背景📸.jpeg';
  album.backgroundOpacity = 0.35;
  album.pages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), image: album.coverImage, imageName: '写真📸.jpeg', date: '2026-10-15', note: 'あ'.repeat(300), fit: 'contain' }));
  const exact = Buffer.byteLength(JSON.stringify(album, null, 2));
  assert.ok(estimateProjectBytes(album) > exact);
  assert.ok(estimateProjectBytes(album) - exact < 512 * 1024);
  assert.equal(estimateProjectBytes(album) - estimateProjectBytes({ ...album, backgroundImage: null }), album.backgroundImage.length - 2);
  assertProjectBudget(album);
});

test('editing all notes cannot consume the reserved photo budget', () => {
  const album = createAlbum();
  album.pages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), image: 'data:image/jpeg;base64,abcd', imageName: '', date: '', note: '', fit: 'contain' }));
  const before = estimateProjectBytes(album);
  album.pages.forEach((page) => { page.note = '📸'.repeat(300); page.imageName = '📷'.repeat(260); });
  album.title = '📚'.repeat(120);
  album.subtitle = '📕'.repeat(180);
  assert.equal(estimateProjectBytes(album), before);
  assert.ok(estimateProjectBytes(album) > Buffer.byteLength(JSON.stringify(album, null, 2)));
});

test('optional background fields preserve the previous image budget and reserve', () => {
  const album = createAlbum();
  delete album.backgroundImage;
  delete album.backgroundImageName;
  delete album.backgroundOpacity;
  const before = estimateProjectBytes(album);
  assert.equal(estimateProjectBytes({ ...album, backgroundImage: undefined }), before);
  assert.equal(estimateProjectBytes({ ...album, backgroundImage: null, backgroundImageName: '', backgroundOpacity: 0 }), before);

  album.id = '\u0000'.repeat(128);
  album.title = '\u0000'.repeat(120);
  album.subtitle = '\u0000'.repeat(180);
  album.coverImageName = '\u0000'.repeat(260);
  album.backgroundImageName = '\u0000'.repeat(260);
  album.backgroundOpacity = 1;
  album.pages = Array.from({ length: 100 }, (_, i) => ({ id: '\u0000'.repeat(125) + String(i).padStart(3, '0'), image: null, imageName: '\u0000'.repeat(260), date: '2026-10-15', note: '\u0000'.repeat(300), fit: 'contain' }));
  assert.equal(estimateProjectBytes(album), before);
  assert.ok(estimateProjectBytes(album) > Buffer.byteLength(JSON.stringify(album, null, 2)));
});

test('large backgrounds contribute their bytes without a large UTF-8 metadata allocation', (t) => {
  const album = createAlbum();
  const before = estimateProjectBytes(album);
  const image = 'data:image/jpeg;base64,' + 'a'.repeat(8 * 1024 * 1024);
  album.backgroundImage = image;
  album.backgroundImageName = '大きな背景.jpeg';
  album.backgroundOpacity = 0.5;
  const encode = TextEncoder.prototype.encode;
  let encodedMetadata = false;
  t.mock.method(TextEncoder.prototype, 'encode', function (value) {
    encodedMetadata = true;
    assert.ok(value.length < 16 * 1024, 'the UTF-8 metadata copy must exclude image strings');
    assert.ok(value.includes('大きな背景.jpeg'));
    return encode.call(this, value);
  });
  assert.equal(estimateProjectBytes(album), before + image.length - 2);
  assert.ok(encodedMetadata);
});

test('adding a background can cross capacity without changing the accepted album', () => {
  const album = createAlbum();
  const image = 'data:image/jpeg;base64,' + 'a'.repeat(2 * 1024 * 1024);
  album.pages = Array.from({ length: 99 }, (_, i) => ({ id: String(i), image, imageName: '', date: '', note: '', fit: 'contain' }));
  const before = estimateProjectBytes(album);
  assert.ok(before < MAX_PROJECT_BYTES);
  assertProjectBudget(album);
  const candidate = { ...album, backgroundImage: image, backgroundImageName: '背景.jpeg', backgroundOpacity: 0.35 };
  assert.ok(estimateProjectBytes(candidate) > MAX_PROJECT_BYTES);
  assert.throws(() => assertProjectBudget(candidate), /200MB/);
  assert.equal(estimateProjectBytes(album), before);
  assert.ok(album.backgroundImage == null);
  assert.equal(album.pages.length, 99);
});

test('oversize additions are detectable before changing the saved album', () => {
  const album = createAlbum();
  const image = 'data:image/jpeg;base64,' + 'a'.repeat(4 * 1024 * 1024);
  const candidate = { ...album, coverImage: image, pages: Array.from({ length: 51 }, (_, i) => ({ id: String(i), image, imageName: '', date: '', note: '', fit: 'contain' })) };
  assert.ok(estimateProjectBytes(candidate) > MAX_PROJECT_BYTES);
  assert.throws(() => assertProjectBudget(candidate), /200MB/);
  assert.equal(album.pages.length, 0);
  assert.equal(album.coverImage, null);
});
