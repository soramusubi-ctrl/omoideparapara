import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlbumReader } from '../dist/album-reader.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.attributes = new Map();
    this.handlers = new Map();
    const classes = new Set();
    this.classList = { toggle(name, force) { if (force) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) };
  }
  addEventListener(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
  }
  dispatch(type, detail = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...detail };
    for (const handler of this.handlers.get(type) || []) handler(event);
    return event;
  }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key); }
  closest(selector) { return selector === '[data-reader-action]' && this.dataset.readerAction ? this : null; }
  focus() { this.focused = true; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { left: 100, right: 900, top: 100, bottom: 700, width: 800, height: 600 }; }
}

class FakeCanvas extends FakeElement {
  constructor(id) { super(id); this.width = 1; this.height = 1; this.content = null; }
  set width(value) { this._width = value; this.content = null; }
  get width() { return this._width; }
  set height(value) { this._height = value; this.content = null; }
  get height() { return this._height; }
  getContext() {
    const canvas = this;
    return {
      fillStyle: '',
      fillRect() { canvas.content = { blank: true, color: this.fillStyle }; },
      drawImage(source) { canvas.content = source.content ? { ...source.content } : null; },
    };
  }
}

function harness({ spread = true, reduced = false, animated = false, queuedClose = false, render } = {}) {
  const ids = ['reader-title', 'reader-position', 'reader-loading', 'reader-error', 'reader-stage', 'reader-book', 'reader-left', 'reader-right', 'reader-turn', 'reader-turn-front', 'reader-turn-back'];
  const elements = Object.fromEntries(ids.map(id => [id, id === 'reader-left' || id === 'reader-right' || id.startsWith('reader-turn-') ? new FakeCanvas(id) : new FakeElement(id)]));
  const buttons = Object.fromEntries(['close', 'previous', 'next', 'first', 'last'].map(action => {
    const button = new FakeElement(action);
    button.dataset.readerAction = action;
    return [action, button];
  }));
  const win = new FakeElement('window');
  const media = new FakeElement('media'); media.matches = spread;
  const motion = new FakeElement('motion'); motion.matches = reduced;
  win.matchMedia = query => query.includes('min-width') ? media : motion;
  const trigger = new FakeElement('opener');
  const canvases = [];
  const doc = { defaultView: win, activeElement: trigger, createElement(tag) { assert.equal(tag, 'canvas'); const canvas = new FakeCanvas(); canvases.push(canvas); return canvas; } };
  for (const element of [...Object.values(elements), ...Object.values(buttons), trigger]) element.ownerDocument = doc;
  const dialog = new FakeElement('dialog'); dialog.ownerDocument = doc; dialog.open = false;
  dialog.querySelector = selector => selector.startsWith('#') ? elements[selector.slice(1)] : buttons[selector.match(/="([a-z]+)"/)[1]];
  dialog.showModal = () => { dialog.open = true; };
  const closeEvents = [];
  dialog.close = () => { dialog.open = false; if (queuedClose) closeEvents.push(() => dialog.dispatch('close')); else dialog.dispatch('close'); };
  const animations = [];
  if (animated) elements['reader-turn'].animate = (frames, options) => {
    const finished = deferred();
    const animation = { frames, options, finished: finished.promise, canceled: false, finish: () => finished.resolve(), cancel() { this.canceled = true; finished.reject(new Error('canceled')); } };
    animations.push(animation);
    return animation;
  };
  let source = { title: 'Opening album', subtitle: 'A small subtitle', theme: 'linen', coverImage: null, pages: Array.from({ length: 8 }, (_, index) => ({ date: '2026-10-16', note: `note ${index + 1}` })) };
  let reads = 0;
  const calls = [];
  const errors = [];
  const renderPage = async (canvas, snapshot, index) => {
    calls.push(index);
    if (render) await render(canvas, snapshot, index);
    canvas.content = { index, title: snapshot.title, note: index ? snapshot.pages[index - 1].note : null };
  };
  const reader = createAlbumReader({ dialog, getAlbum() { reads += 1; return source; }, renderPage, onError: error => errors.push(error) });
  return {
    ...reader, dialog, elements, buttons, win, media, motion, animations, canvases, calls, errors, trigger,
    get source() { return source; }, set source(value) { source = value; }, get reads() { return reads; },
    click(action) { dialog.dispatch('click', { target: buttons[action] }); },
    key(key) { return dialog.dispatch('keydown', { key }); },
    flushClose() { closeEvents.splice(0).forEach(dispatch => dispatch()); },
    resize(value) { media.matches = value; win.dispatch('resize'); },
    visible() { return [elements['reader-left'].hidden ? 'hidden' : elements['reader-left'].content?.index ?? null, elements['reader-right'].content?.index ?? null]; },
  };
}

test('desktop cover/spreads, boundaries, keyboard and a bounded current/next cache', async () => {
  const h = harness();
  h.source.pages = Array.from({ length: 100 }, (_, i) => ({ note: String(i) }));
  await h.open(); await tick();
  assert.deepEqual(h.visible(), [null, 0]);
  assert.equal(h.elements['reader-book'].dataset.cover, 'true');
  assert.equal(h.buttons.previous.disabled, true);
  assert.equal(h.buttons.first.disabled, true);
  assert.equal(h.elements['reader-left'].getAttribute('aria-label'), '余白のページ');
  assert.match(h.elements['reader-right'].getAttribute('aria-label'), /Opening album。A small subtitle/);
  assert.deepEqual(h.calls.sort((a, b) => a - b), [0, 1, 2]);
  assert.equal(h.canvases.length, 3);
  h.key('ArrowRight'); await tick();
  assert.deepEqual(h.visible(), [1, 2]);
  assert.match(h.elements['reader-position'].textContent, /1–2ページ/);
  h.key('End'); await tick();
  assert.deepEqual(h.visible(), [99, 100]);
  assert.equal(h.buttons.next.disabled, true);
  assert.equal(h.buttons.last.disabled, true);
  const before = h.calls.length;
  h.click('next'); h.key('ArrowRight'); await tick();
  assert.equal(h.calls.length, before);
  h.key('Home'); await tick();
  assert.deepEqual(h.visible(), [null, 0]);
  h.key('ArrowLeft'); await tick();
  assert.deepEqual(h.visible(), [null, 0]);
  assert.ok(new Set(h.calls).size < 12, 'Reading a few views must not render all 101 pages.');
  assert.equal(h.reads, 1);
});

test('selected page, final blank, responsive layout and a fixed snapshot', async () => {
  const h = harness();
  h.source.pages = h.source.pages.slice(0, 5);
  const original = JSON.stringify(h.source);
  await h.open(4); await tick();
  assert.deepEqual(h.visible(), [3, 4]);
  assert.match(h.elements['reader-right'].getAttribute('aria-label'), /写真ページ 4。日付 2026-10-16。note 4/);
  h.source.title = 'Edited outside reader';
  h.source.pages[3].note = 'new note';
  h.resize(false); await tick();
  assert.deepEqual(h.visible(), ['hidden', 4]);
  assert.equal(h.elements['reader-right'].content.title, 'Opening album');
  assert.equal(h.elements['reader-right'].content.note, 'note 4');
  h.resize(true); await tick();
  assert.deepEqual(h.visible(), [3, 4]);
  h.click('last'); await tick();
  assert.deepEqual(h.visible(), [5, null]);
  assert.equal(h.elements['reader-right'].dataset.blank, 'true');
  assert.equal(h.elements['reader-right'].content.color, '#F8F4EC');
  assert.equal(h.reads, 1);
  h.close(); assert.equal(h.trigger.focused, true);
  await h.open(4); await tick();
  assert.equal(h.elements['reader-right'].content.title, 'Edited outside reader');
  assert.equal(h.elements['reader-right'].content.note, 'new note');
  assert.notEqual(JSON.stringify(h.source), original);
  const stable = JSON.stringify(h.source);
  h.click('first'); await tick(); h.close();
  assert.equal(JSON.stringify(h.source), stable, 'Reader navigation must not modify its source.');
});

test('closing and reopening while rendering discards stale snapshots and errors', async () => {
  const firstRender = deferred();
  let old = true;
  const h = harness({ render: async (_canvas, snapshot) => { if (old && snapshot.title === 'Opening album') await firstRender.promise; } });
  const opening = h.open(0);
  await tick();
  assert.equal(h.buttons.next.disabled, true);
  h.close();
  old = false;
  h.source = { ...h.source, title: 'Fresh snapshot' };
  await h.open(3); await tick();
  assert.deepEqual(h.visible(), [3, 4]);
  firstRender.reject(new Error('old render failed'));
  await opening; await tick();
  assert.deepEqual(h.visible(), [3, 4]);
  assert.equal(h.elements['reader-title'].textContent, 'Fresh snapshot');
  assert.equal(h.elements['reader-right'].content.title, 'Fresh snapshot');
  assert.equal(h.errors.length, 0);
  assert.equal(h.buttons.next.disabled, false);
});

test('resize during an unfinished initial render commits only the newest layout', async () => {
  const gate = deferred();
  const h = harness({ render: async (_canvas, _snapshot, index) => { if (index === 3 || index === 4) await gate.promise; } });
  const opening = h.open(4);
  await tick();
  h.resize(false);
  gate.resolve(); await opening; await tick();
  assert.equal(h.elements['reader-book'].dataset.layout, 'single');
  assert.deepEqual(h.visible(), ['hidden', 4]);
  assert.equal(h.buttons.next.disabled, false);
});

test('animation uses two leaf faces, blocks repeat turns, and supports backward turns', async () => {
  const h = harness({ animated: true });
  await h.open(); await tick();
  h.click('next'); await tick();
  assert.equal(h.animations.length, 1);
  assert.equal(h.animations[0].options.duration, 500);
  assert.deepEqual(h.visible(), [null, 2]);
  assert.equal(h.elements['reader-turn-front'].content.index, 0);
  assert.equal(h.elements['reader-turn-back'].content.index, 1);
  assert.equal(h.elements['reader-turn'].classList.contains('is-forward'), true);
  assert.equal(h.buttons.next.disabled, true);
  h.key('ArrowRight'); h.click('next'); await tick();
  assert.equal(h.animations.length, 1);
  h.animations[0].finish(); await tick();
  assert.deepEqual(h.visible(), [1, 2]);
  h.click('previous'); await tick();
  assert.equal(h.elements['reader-turn-front'].content.index, 1);
  assert.equal(h.elements['reader-turn-back'].content.index, 0);
  assert.equal(h.elements['reader-turn'].classList.contains('is-backward'), true);
  h.animations[1].finish(); await tick();
  assert.deepEqual(h.visible(), [null, 0]);
});

test('resize and reopen cancel animations without allowing old commits', async () => {
  const h = harness({ animated: true });
  await h.open(); await tick();
  h.click('next'); await tick();
  h.resize(false); await tick();
  assert.equal(h.animations[0].canceled, true);
  assert.deepEqual(h.visible(), ['hidden', 0]);
  h.animations[0].finish(); await tick();
  assert.deepEqual(h.visible(), ['hidden', 0]);
  h.click('next'); await tick();
  assert.equal(h.elements['reader-turn-front'].content.index, 0);
  assert.equal(h.elements['reader-turn-back'].dataset.blank, 'true');
  h.close();
  await h.open(5); await tick();
  h.animations[1].finish(); await tick();
  assert.deepEqual(h.visible(), ['hidden', 5]);
  assert.equal(h.elements['reader-turn'].hidden, true);
});

test('close releases display buffers and a queued old close event cannot clear a reopened reader', async () => {
  const h = harness({ animated: true, queuedClose: true });
  await h.open(); await tick();
  h.click('next'); await tick();
  assert.equal(h.elements['reader-turn-front'].width, 1240);
  h.close();
  for (const id of ['reader-left', 'reader-right', 'reader-turn-front', 'reader-turn-back']) {
    assert.equal(h.elements[id].width, 1);
    assert.equal(h.elements[id].height, 1);
    assert.equal(h.elements[id].content, null);
  }
  await h.open(5); await tick();
  h.flushClose(); await tick();
  assert.equal(h.dialog.open, true);
  assert.deepEqual(h.visible(), [5, 6]);
  assert.equal(h.elements['reader-right'].width, 1240);
  h.animations[0].finish(); await tick();
  assert.deepEqual(h.visible(), [5, 6]);
  h.dialog.close(); h.flushClose();
  assert.equal(h.elements['reader-right'].width, 1);
});

test('failed target keeps old pages, reports error, and restores navigation for retry', async () => {
  let fail = true;
  const h = harness({ render: async (_canvas, _snapshot, index) => { if (fail && index === 1) throw new Error('photo failed'); } });
  await h.open(); await tick();
  h.click('next'); await tick();
  assert.deepEqual(h.visible(), [null, 0]);
  assert.equal(h.elements['reader-error'].hidden, false);
  assert.match(h.elements['reader-error'].textContent, /photo failed/);
  assert.equal(h.errors.length, 1);
  assert.equal(h.buttons.next.disabled, false);
  assert.equal(h.elements['reader-loading'].hidden, true);
  fail = false;
  h.click('next'); await tick();
  assert.deepEqual(h.visible(), [1, 2]);
  assert.equal(h.elements['reader-error'].hidden, true);
});

test('reduced motion, missing/throwing WAAPI, stage clicks, swipe suppression and Escape', async () => {
  const h = harness({ spread: false, animated: true, reduced: true });
  await h.open(); await tick();
  h.elements['reader-stage'].dispatch('click', { clientX: 800, clientY: 300 }); await tick();
  assert.deepEqual(h.visible(), ['hidden', 1]);
  assert.equal(h.animations.length, 0);
  h.elements['reader-stage'].dispatch('click', { clientX: 50, clientY: 300 }); await tick();
  assert.deepEqual(h.visible(), ['hidden', 1]);
  h.elements['reader-stage'].dispatch('pointerdown', { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 750, clientY: 300 });
  h.elements['reader-stage'].dispatch('pointerdown', { pointerType: 'touch', isPrimary: false, pointerId: 2, clientX: 500, clientY: 300 });
  h.elements['reader-stage'].dispatch('pointerup', { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 500, clientY: 310 });
  await tick();
  assert.deepEqual(h.visible(), ['hidden', 1], 'A pinch must cancel the tracked page swipe.');
  h.elements['reader-stage'].dispatch('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 750, clientY: 300 });
  h.elements['reader-stage'].dispatch('pointerup', { pointerType: 'touch', pointerId: 1, clientX: 500, clientY: 310 });
  await tick();
  assert.deepEqual(h.visible(), ['hidden', 2]);
  h.elements['reader-stage'].dispatch('click', { clientX: 800, clientY: 300 }); await tick();
  assert.deepEqual(h.visible(), ['hidden', 2]);
  h.motion.matches = false;
  h.elements['reader-turn'].animate = () => { throw new Error('WAAPI unsupported'); };
  h.key('ArrowLeft'); await tick();
  assert.deepEqual(h.visible(), ['hidden', 1]);
  assert.equal(h.buttons.next.disabled, false);
  const escape = h.key('Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(h.dialog.open, false);
  assert.equal(h.trigger.focused, true);
});
