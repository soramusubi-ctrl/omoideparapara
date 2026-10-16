import { PAGE_WIDTH, PAGE_HEIGHT, THEMES } from './album-renderer.js';
import { getBookViews, findBookView } from './book-layout.js';

/** A modal reader keeps one immutable album snapshot and a bounded page cache. */
export function createAlbumReader({ dialog, getAlbum, renderPage, onError = () => {} }) {
  if (!dialog || typeof getAlbum !== 'function' || typeof renderPage !== 'function') throw new TypeError('Reader dialog, album source and page renderer are required.');
  const doc = dialog.ownerDocument;
  const win = doc.defaultView;
  const find = id => {
    const element = dialog.querySelector(`#${id}`);
    if (!element) throw new Error(`Reader element is missing: ${id}`);
    return element;
  };
  const title = find('reader-title');
  const position = find('reader-position');
  const loading = find('reader-loading');
  const errorMessage = find('reader-error');
  const stage = find('reader-stage');
  const book = find('reader-book');
  const left = find('reader-left');
  const right = find('reader-right');
  const turn = find('reader-turn');
  const front = find('reader-turn-front');
  const back = find('reader-turn-back');
  const controls = Object.fromEntries(['previous', 'next', 'first', 'last'].map(action => [action, dialog.querySelector(`[data-reader-action="${action}"]`)]));
  const closeButton = dialog.querySelector('[data-reader-action="close"]');
  const spreadQuery = win.matchMedia?.('(min-width: 760px)');
  const motionQuery = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  let opened = false;
  let busy = false;
  let generation = 0;
  let album;
  let views = [];
  let viewIndex = 0;
  let anchorPage = 0;
  let spread = false;
  let displayed = null;
  let cache = new Map();
  let animation = null;
  let returnFocus = null;
  let pointer = null;
  let suppressClickUntil = 0;

  const current = token => opened && generation === token;
  const isSpread = () => spreadQuery ? spreadQuery.matches : win.innerWidth >= 760;

  function updateControls() {
    for (const [action, button] of Object.entries(controls)) {
      if (button) button.disabled = busy || ((action === 'previous' || action === 'first') ? viewIndex === 0 : viewIndex >= views.length - 1);
    }
    book.setAttribute('aria-busy', busy ? 'true' : 'false');
    loading.hidden = !busy;
  }

  function paint(canvas, source, pageIndex) {
    canvas.width = PAGE_WIDTH;
    canvas.height = PAGE_HEIGHT;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('ページを表示できませんでした。');
    if (source) ctx.drawImage(source, 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    else {
      ctx.fillStyle = (THEMES[album?.theme] || THEMES.linen).paper;
      ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    }
    canvas.dataset.blank = pageIndex === null ? 'true' : 'false';
    const page = pageIndex > 0 ? album.pages[pageIndex - 1] : null;
    const label = pageIndex === null ? '余白のページ' : pageIndex === 0
      ? ['アルバムの表紙', album.title, album.subtitle].filter(Boolean).join('。')
      : [`写真ページ ${pageIndex}`, page?.date ? `日付 ${page.date}` : '', page?.note].filter(Boolean).join('。');
    canvas.setAttribute('aria-label', label);
  }

  function sides(prepared) {
    return spread ? prepared.canvases : [null, prepared.canvases[0]];
  }

  function pageSides(prepared) {
    return spread ? prepared.pages : [null, prepared.pages[0]];
  }

  function show(prepared) {
    const canvases = sides(prepared);
    const pages = pageSides(prepared);
    left.hidden = !spread;
    paint(left, canvases[0], pages[0]);
    paint(right, canvases[1], pages[1]);
    book.dataset.layout = spread ? 'spread' : 'single';
    book.dataset.cover = prepared.pages.includes(0) ? 'true' : 'false';
  }

  function updatePosition() {
    const visible = views[viewIndex].filter(page => page !== null);
    if (visible.includes(0)) position.textContent = album.pages.length ? `表紙 / 写真 ${album.pages.length}ページ` : '表紙のみ';
    else position.textContent = `${visible.join('–')}ページ / 全${album.pages.length}ページ`;
  }

  function prune(target) {
    const allowed = new Set([...(views[target] || []), ...(views[target + 1] || [])]);
    for (const page of cache.keys()) if (!allowed.has(page)) cache.delete(page);
  }

  function pageCanvas(pageIndex) {
    if (pageIndex === null) return Promise.resolve(null);
    if (cache.has(pageIndex)) return cache.get(pageIndex);
    const canvas = doc.createElement('canvas');
    const snapshot = album;
    const pending = Promise.resolve().then(() => renderPage(canvas, snapshot, pageIndex)).then(() => canvas).catch(error => {
      if (cache.get(pageIndex) === pending) cache.delete(pageIndex);
      throw error;
    });
    cache.set(pageIndex, pending);
    return pending;
  }

  async function prepare(target) {
    const pages = views[target].slice();
    return { pages, canvases: await Promise.all(pages.map(pageCanvas)) };
  }

  function prefetch(token) {
    if (current(token) && viewIndex + 1 < views.length) void prepare(viewIndex + 1).catch(() => {});
  }

  function stopAnimation() {
    const active = animation;
    animation = null;
    if (active) {
      try { active.cancel(); } catch { /* Already finished or unsupported cancellation. */ }
    }
    turn.hidden = true;
  }

  function report(error, token) {
    if (!current(token)) return;
    errorMessage.textContent = error?.message || 'ページを読み込めませんでした。もう一度お試しください。';
    errorMessage.hidden = false;
    try { onError(error); } catch { /* Error reporting must not lock the reader. */ }
  }

  async function animateTo(target, forward, token) {
    if (!displayed || motionQuery?.matches || typeof turn.animate !== 'function') return true;
    const oldSides = sides(displayed);
    const newSides = sides(target);
    const oldPages = pageSides(displayed);
    const newPages = pageSides(target);
    if (spread) {
      paint(left, forward ? oldSides[0] : newSides[0], forward ? oldPages[0] : newPages[0]);
      paint(right, forward ? newSides[1] : oldSides[1], forward ? newPages[1] : oldPages[1]);
      paint(front, forward ? oldSides[1] : oldSides[0], forward ? oldPages[1] : oldPages[0]);
      paint(back, forward ? newSides[0] : newSides[1], forward ? newPages[0] : newPages[1]);
    } else {
      paint(right, newSides[1], newPages[1]);
      paint(front, oldSides[1], oldPages[1]);
      paint(back, null, null);
    }
    turn.classList.toggle('is-forward', forward);
    turn.classList.toggle('is-backward', !forward);
    turn.hidden = false;
    let active;
    try {
      active = turn.animate([{ transform: 'rotateY(0deg)' }, { transform: `rotateY(${forward ? -180 : 180}deg)` }], { duration: 500, easing: 'cubic-bezier(.3,.05,.2,1)', fill: 'forwards' });
      animation = active;
      await active.finished;
    } catch {
      // Unsupported animation falls through to an immediate, fully rendered view.
    } finally {
      if (animation === active) animation = null;
      if (current(token)) {
        try { active?.cancel(); } catch { /* Finish without animation. */ }
        turn.hidden = true;
      }
    }
    return current(token);
  }

  async function goTo(target) {
    if (!opened || busy || target === viewIndex || target < 0 || target >= views.length) return;
    const token = generation;
    busy = true;
    errorMessage.hidden = true;
    updateControls();
    prune(target);
    try {
      const prepared = await prepare(target);
      if (!current(token)) return;
      if (!await animateTo(prepared, target > viewIndex, token)) return;
      if (!current(token)) return;
      show(prepared);
      displayed = prepared;
      viewIndex = target;
      anchorPage = prepared.pages.find(page => page !== null);
      updatePosition();
      prune(viewIndex);
    } catch (error) {
      if (current(token)) {
        stopAnimation();
        if (displayed) show(displayed);
        report(error, token);
      }
    } finally {
      if (current(token)) {
        busy = false;
        updateControls();
        prefetch(token);
      }
    }
  }

  async function layout(token) {
    busy = true;
    errorMessage.hidden = true;
    updateControls();
    prune(viewIndex);
    try {
      const prepared = await prepare(viewIndex);
      if (!current(token)) return;
      show(prepared);
      displayed = prepared;
      updatePosition();
      prune(viewIndex);
    } catch (error) { report(error, token); }
    finally {
      if (current(token)) {
        busy = false;
        updateControls();
        prefetch(token);
      }
    }
  }

  function cleanup() {
    if (!opened) return;
    opened = false;
    generation += 1;
    stopAnimation();
    cache.clear();
    displayed = null;
    for (const canvas of [left, right, front, back]) {
      canvas.width = 1;
      canvas.height = 1;
    }
    album = null;
    pointer = null;
    suppressClickUntil = 0;
    busy = false;
    loading.hidden = true;
    book.setAttribute('aria-busy', 'false');
    returnFocus?.focus?.();
    returnFocus = null;
  }

  function close() {
    cleanup();
    if (dialog.open) dialog.close();
  }

  async function open(pageIndex = 0) {
    const token = ++generation;
    stopAnimation();
    try {
      const source = getAlbum();
      const snapshot = { ...source, pages: source.pages.map(page => ({ ...page })) };
      spread = isSpread();
      const nextViews = getBookViews(snapshot.pages.length + 1, spread);
      if (!opened) returnFocus = doc.activeElement;
      opened = true;
      album = snapshot;
      views = nextViews;
      cache = new Map();
      displayed = null;
      viewIndex = findBookView(views, pageIndex);
      anchorPage = views[viewIndex].includes(pageIndex) ? pageIndex : 0;
      title.textContent = album.title || 'アルバム';
      position.textContent = 'ページを準備しています…';
      book.dataset.layout = spread ? 'spread' : 'single';
      book.dataset.cover = views[viewIndex].includes(0) ? 'true' : 'false';
      left.hidden = !spread;
      paint(left, null, null);
      paint(right, null, null);
      if (!dialog.open) dialog.showModal();
      closeButton?.focus?.();
      await layout(token);
    } catch (error) {
      if (current(token)) {
        busy = false;
        updateControls();
        report(error, token);
      } else {
        try { onError(error); } catch { /* Keep opening failures contained. */ }
      }
    }
  }

  function resize() {
    if (!opened) return;
    const nextSpread = isSpread();
    if (nextSpread === spread && !animation) return;
    const token = ++generation;
    stopAnimation();
    spread = nextSpread;
    views = getBookViews(album.pages.length + 1, spread);
    viewIndex = findBookView(views, anchorPage);
    book.dataset.layout = spread ? 'spread' : 'single';
    left.hidden = !spread;
    if (displayed) {
      const previous = displayed;
      displayed = {
        pages: views[viewIndex].slice(),
        canvases: views[viewIndex].map(page => {
          const index = previous.pages.indexOf(page);
          return index < 0 ? null : previous.canvases[index];
        }),
      };
      show(displayed);
      updatePosition();
    }
    void layout(token);
  }

  // Native close events are queued; an older close may arrive after reopening.
  dialog.addEventListener('close', () => { if (!dialog.open) cleanup(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    const action = event.target.closest?.('[data-reader-action]')?.dataset.readerAction;
    if (action === 'close') close();
    else if (action === 'previous') void goTo(viewIndex - 1);
    else if (action === 'next') void goTo(viewIndex + 1);
    else if (action === 'first') void goTo(0);
    else if (action === 'last') void goTo(views.length - 1);
  });
  dialog.addEventListener('keydown', event => {
    if (!opened || event.altKey || event.ctrlKey || event.metaKey) return;
    const targets = { ArrowLeft: viewIndex - 1, ArrowRight: viewIndex + 1, Home: 0, End: views.length - 1 };
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (Object.hasOwn(targets, event.key)) { event.preventDefault(); void goTo(targets[event.key]); }
  });
  stage.addEventListener('click', event => {
    if (!opened || busy || Date.now() < suppressClickUntil || event.defaultPrevented) return;
    const rect = book.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
    void goTo(viewIndex + (event.clientX < rect.left + rect.width / 2 ? -1 : 1));
  });
  stage.addEventListener('pointerdown', event => {
    if (event.isPrimary === false) { pointer = null; return; }
    if (!opened || busy || event.pointerType === 'mouse' || (event.button && event.button !== 0)) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  stage.addEventListener('pointerup', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    pointer = null;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
    suppressClickUntil = Date.now() + 500;
    void goTo(viewIndex + (dx < 0 ? 1 : -1));
  });
  stage.addEventListener('pointercancel', () => { pointer = null; });
  win.addEventListener('resize', resize);
  spreadQuery?.addEventListener?.('change', resize);

  return { open, close };
}
