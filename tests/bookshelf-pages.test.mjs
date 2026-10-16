import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBookshelf } from '../dist/bookshelf.js';
import { createBookPage } from '../dist/book.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.hidden = true; this.disabled = false; this.attributes = {}; this.handlers = {}; this.textContent = ''; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  dispatch(type, detail = {}) { for (const handler of this.handlers[type] || []) handler({ target: this, ...detail }); }
  append(...nodes) { for (const node of nodes) { if (node.fragment) this.append(...node.children); else { this.children.push(node); node.parent = this; } } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  click() { this.dispatch('click'); }
  focus() { this.focused = true; }
}
function environment(ids, search = '') {
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  const win = new Element(); win.location = { search };
  const doc = new Element(); doc.defaultView = win; doc.visibilityState = 'visible';
  doc.getElementById = id => { if (!nodes[id]) throw new Error(`Unknown ID ${id}`); return nodes[id]; };
  doc.createElement = tag => new Element(tag);
  doc.createDocumentFragment = () => Object.assign(new Element(), { fragment: true });
  return { doc, win, nodes };
}
const shelfIds = ['shelf-grid','shelf-empty','shelf-loading','shelf-error','shelf-error-heading','shelf-error-text','shelf-storage-help','shelf-message','shelf-file','shelf-import','shelf-count','legacy-warning','shelf-retry','shelf-refresh','legacy-download'];
const bookIds = ['book-dialog','book-read','book-loading','book-error','book-error-text','book-retry','book-edit','book-title','book-subtitle','book-page-count'];
const summary = (id, title = id) => ({ id, title, subtitle: '', theme: 'linen', pageCount: 2, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', thumbnail: null });
const album = { id: 'existing', title: 'A little album', subtitle: 'Our memories', theme: 'linen', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', pages: [{ date: '2026-10-16', note: 'A special day' }] };
function descendants(element) { return element.children.flatMap(child => [child, ...descendants(child)]); }
function setupShelf(overrides = {}) {
  const env = environment(shelfIds);
  const downloads = [];
  const services = { migrateLegacyDraft: async () => ({ found: false, migrated: false, invalid: false }), listAlbums: async () => [], loadSavedAlbum: async () => { throw new Error('Listing must not read full albums'); }, saveAlbum: async () => { throw new Error('Unexpected save'); }, readLegacyDraft: async () => null, readAlbumFile: async () => structuredClone(album), decodeAlbumImages: async () => {}, makeId: () => 'fresh-id', serializeAlbum: value => JSON.stringify(value), sanitizeFilename: value => value, downloadBlob: (blob, name) => downloads.push({ blob, name }), ...overrides };
  return { ...env, downloads, services, controller: createBookshelf({ document: env.doc, window: env.win, services }) };
}

test('bookshelf reads summaries only and builds safe per-book links with literal titles', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const h = setupShelf({ listAlbums: async () => [summary('id /?"', hostile)] });
  await h.controller.reload();
  const elements = descendants(h.nodes['shelf-grid']);
  const heading = elements.find(node => node.tagName === 'H2');
  assert.equal(heading.textContent, hostile);
  assert.equal(elements.filter(node => node.tagName === 'IMG').length, 0);
  const links = elements.filter(node => node.tagName === 'A');
  assert.deepEqual(links.map(node => node.href), ['./book.html?album=id%20%2F%3F%22', './index.html?album=id%20%2F%3F%22']);
  assert.ok(links.every(node => node.target === '_blank' && node.rel === 'noopener'));
  assert.ok(elements.some(node => node.textContent === '写真 2ページ ＋ 表紙'));
  assert.ok(elements.some(node => node.tagName === 'TIME' && node.textContent.includes('2026年')));
  assert.equal(h.nodes['shelf-empty'].hidden, true);
  assert.equal(h.nodes['shelf-count'].textContent, '1冊のアルバム');
});

test('overlapping reloads ignore stale successful responses and stale errors', async () => {
  for (const oldFails of [false, true]) {
    const old = deferred(), recent = deferred(); let calls = 0;
    const h = setupShelf({ listAlbums: () => (++calls === 1 ? old.promise : recent.promise) });
    const first = h.controller.reload(); await tick();
    const second = h.controller.reload(); await tick();
    recent.resolve([summary('latest')]); await second;
    if (oldFails) old.reject(new Error('stale failure')); else old.resolve([summary('stale'), summary('old')]);
    await first;
    assert.equal(descendants(h.nodes['shelf-grid']).find(node => node.tagName === 'H2').textContent, 'latest');
    assert.equal(h.nodes['shelf-count'].textContent, '1冊のアルバム');
    assert.equal(h.nodes['shelf-error'].hidden, true);
    assert.equal(h.nodes['shelf-grid'].attributes['aria-busy'], 'false');
  }
});

test('storage failure never becomes an empty shelf; invalid legacy data remains downloadable', async () => {
  const raw = { album: { invalid: 'untouched original' }, revision: 7 };
  const h = setupShelf({ migrateLegacyDraft: async () => ({ found: true, migrated: false, invalid: true }), listAlbums: async () => { throw new Error('storage denied'); }, readLegacyDraft: async () => raw });
  await h.controller.reload();
  assert.equal(h.nodes['shelf-empty'].hidden, true);
  assert.equal(h.nodes['shelf-error'].hidden, false);
  assert.match(h.nodes['shelf-error-text'].textContent, /storage denied/);
  assert.equal(h.nodes['legacy-warning'].hidden, false);
  await h.controller.downloadLegacy();
  assert.deepEqual(JSON.parse(await h.downloads[0].blob.text()), raw);
  assert.equal(h.downloads[0].name, '復元できなかった旧データ.json');
  assert.equal(raw.revision, 7);
});

test('focus and visible-tab events reload shelf metadata', async () => {
  let lists = 0;
  const h = setupShelf({ listAlbums: async () => { lists += 1; return []; } });
  await h.controller.reload();
  h.win.dispatch('focus'); await tick();
  h.doc.visibilityState = 'hidden'; h.doc.dispatch('visibilitychange'); await tick();
  assert.equal(lists, 2);
  h.doc.visibilityState = 'visible'; h.doc.dispatch('visibilitychange'); await tick();
  assert.equal(lists, 3);
  assert.equal(h.nodes['shelf-empty'].hidden, false);
});

test('import decodes before saving a fresh ID and never replaces or mutates the imported album', async () => {
  const original = structuredClone(album);
  const calls = [];
  const h = setupShelf({ readAlbumFile: async file => { calls.push(['read', file]); return original; }, decodeAlbumImages: async () => { calls.push(['decode']); }, makeId: () => { calls.push(['id']); return 'brand-new'; }, saveAlbum: async (value, options) => { calls.push(['save', value, options]); }, listAlbums: async () => { calls.push(['list']); return [summary('brand-new')]; } });
  assert.equal(await h.controller.importFile('file'), true);
  assert.deepEqual(calls.map(call => call[0]), ['read','decode','id','save','list']);
  const saved = calls.find(call => call[0] === 'save');
  assert.equal(saved[1].id, 'brand-new');
  assert.deepEqual(saved[2], { expectedRevision: 0 });
  assert.deepEqual(saved[1].pages, album.pages);
  assert.deepEqual(original, album);
  assert.equal(h.nodes['shelf-import'].disabled, false);
  assert.match(h.nodes['shelf-message'].textContent, /新しい一冊/);
});

test('decode failure and duplicate import attempts cannot save a partial or duplicate book', async () => {
  const gate = deferred(); let reads = 0; let saves = 0;
  const h = setupShelf({ readAlbumFile: async () => { reads += 1; await gate.promise; return structuredClone(album); }, decodeAlbumImages: async () => { throw new Error('broken photo'); }, saveAlbum: async () => { saves += 1; } });
  const pending = h.controller.importFile('first'); await tick();
  assert.equal(await h.controller.importFile('second'), false);
  gate.resolve(); assert.equal(await pending, false);
  assert.equal(reads, 1); assert.equal(saves, 0);
  assert.match(h.nodes['shelf-error-text'].textContent, /broken photo/);
  assert.equal(h.nodes['shelf-import'].disabled, false);
});

test('card download loads one full album on demand without writes', async () => {
  const loaded = [];
  const h = setupShelf({ loadSavedAlbum: async id => { loaded.push(id); return { album, revision: 3 }; } });
  await h.controller.downloadAlbum('chosen');
  assert.deepEqual(loaded, ['chosen']);
  assert.deepEqual(JSON.parse(await h.downloads[0].blob.text()), album);
  assert.equal(h.downloads[0].name, 'A little album.album.json');
});

function setupBook(overrides = {}, search = '?album=chosen') {
  const env = environment(bookIds, search);
  const opens = []; let readerOptions;
  const services = { loadSavedAlbum: async () => ({ album: structuredClone(album), revision: 3 }), renderAlbumPage: () => {}, createAlbumReader: options => { readerOptions = options; return { open: async index => opens.push({ index, album: options.getAlbum() }) }; }, ...overrides };
  return { ...env, opens, get readerOptions() { return readerOptions; }, controller: createBookPage({ document: env.doc, window: env.win, services }) };
}

test('book page loads only the chosen album, automatically opens the reader, and never saves', async () => {
  const loaded = []; let writes = 0;
  const h = setupBook({ loadSavedAlbum: async id => { loaded.push(id); return { album, revision: 2 }; }, saveAlbum: () => { writes += 1; }, saveDraft: () => { writes += 1; } });
  await h.controller.load();
  assert.deepEqual(loaded, ['chosen']);
  assert.equal(h.opens.length, 1); assert.equal(h.opens[0].index, 0);
  assert.equal(h.nodes['book-title'].textContent, album.title);
  assert.equal(h.nodes['book-edit'].href, './index.html?album=chosen');
  assert.notEqual(h.opens[0].album, album);
  assert.notEqual(h.opens[0].album.pages[0], album.pages[0]);
  assert.equal(writes, 0);
  h.nodes['book-dialog'].open = false; h.nodes['book-dialog'].dispatch('close');
  assert.equal(h.nodes['book-read'].focused, true);
  h.nodes['book-read'].click(); await tick();
  assert.equal(h.opens.length, 2); assert.equal(writes, 0);
});

test('book page reports missing/error records, retries, and ignores an older load result', async () => {
  let available = false;
  const h = setupBook({ loadSavedAlbum: async () => available ? { album, revision: 1 } : null });
  await h.controller.load();
  assert.equal(h.nodes['book-error'].hidden, false);
  assert.match(h.nodes['book-error-text'].textContent, /見つかりません/);
  assert.equal(h.opens.length, 0);
  available = true; h.nodes['book-retry'].click(); await tick();
  assert.equal(h.nodes['book-error'].hidden, true); assert.equal(h.opens.length, 1);
  const old = deferred(), recent = deferred(); let calls = 0;
  const race = setupBook({ loadSavedAlbum: () => ++calls === 1 ? old.promise : recent.promise });
  const first = race.controller.load(), second = race.controller.load();
  recent.resolve({ album: { ...album, title: 'Latest book' }, revision: 2 }); await second;
  old.resolve({ album: { ...album, title: 'Old book' }, revision: 1 }); await first;
  assert.equal(race.nodes['book-title'].textContent, 'Latest book');
  assert.equal(race.opens.length, 1);
});

test('book pages explain missing IDs and denied storage without opening or writing', async () => {
  let loads = 0;
  const missing = setupBook({ loadSavedAlbum: async () => { loads += 1; return null; } }, '');
  await missing.controller.load();
  assert.equal(loads, 0);
  assert.match(missing.nodes['book-error-text'].textContent, /本が指定されていません/);
  assert.equal(missing.opens.length, 0);
  const denied = setupBook({ loadSavedAlbum: async () => { throw new Error('ブラウザの保存を利用できません'); } });
  await denied.controller.load();
  assert.equal(denied.opens.length, 0);
  assert.equal(denied.nodes['book-error'].hidden, false);
  assert.match(denied.nodes['book-error-text'].textContent, /保存を利用できません/);
  assert.equal(denied.nodes['book-retry'].disabled, false);
});

test('a failed import save preserves the old shelf and cannot announce success', async () => {
  const h = setupShelf({ listAlbums: async () => [summary('existing')], saveAlbum: async () => { throw new Error('保存容量が足りません'); } });
  await h.controller.reload();
  assert.equal(await h.controller.importFile('file'), false);
  assert.equal(descendants(h.nodes['shelf-grid']).find(node => node.tagName === 'H2').textContent, 'existing');
  assert.equal(h.nodes['shelf-count'].textContent, '1冊のアルバム');
  assert.equal(h.nodes['shelf-message'].hidden, true);
  assert.match(h.nodes['shelf-error-text'].textContent, /保存容量/);
});

test('static pages keep new-tab links safe and book module has no save dependencies', async () => {
  const shelfHtml = await readFile(new URL('../dist/bookshelf.html', import.meta.url), 'utf8');
  const bookHtml = await readFile(new URL('../dist/book.html', import.meta.url), 'utf8');
  const bookJs = await readFile(new URL('../dist/book.js', import.meta.url), 'utf8');
  for (const match of shelfHtml.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) assert.match(match[0], /rel="noopener"/);
  assert.match(shelfHtml, /href="\.\/index\.html\?new=1"/);
  for (const id of ['book-dialog','reader-title','reader-position','reader-left','reader-right','reader-turn-front','reader-turn-back']) assert.equal((bookHtml.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1);
  assert.doesNotMatch(bookJs, /\b(?:saveAlbum|saveDraft|listAlbums)\b/);
  assert.doesNotMatch(bookJs, /innerHTML\s*=/);
});
