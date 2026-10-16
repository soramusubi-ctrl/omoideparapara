import { loadSavedAlbum } from './shelf-storage.js';
import { createAlbumReader } from './album-reader.js';
import { renderAlbumPage } from './album-renderer.js';

export function createBookPage({ document: doc = globalThis.document, window: win = doc.defaultView, services = {} } = {}) {
  const api = { loadSavedAlbum, createAlbumReader, renderAlbumPage, ...services };
  const $ = id => doc.getElementById(id);
  const dialog = $('book-dialog');
  const read = $('book-read');
  const loading = $('book-loading');
  const error = $('book-error');
  const retry = $('book-retry');
  const edit = $('book-edit');
  const id = new URLSearchParams(win.location.search).get('album');
  let album = null;
  let generation = 0;
  let busy = false;
  function fail(problem) {
    $('book-error-text').textContent = problem?.message || 'この本を読み込めませんでした。もう一度お試しください。';
    error.hidden = false;
  }
  const reader = api.createAlbumReader({ dialog, getAlbum: () => album, renderPage: api.renderAlbumPage, onError: fail });

  async function load() {
    const token = ++generation;
    busy = true;
    loading.hidden = false;
    error.hidden = true;
    read.disabled = true;
    retry.disabled = true;
    try {
      if (!id) throw new Error('本が指定されていません。本棚から読みたい本を選んでください。');
      const saved = await api.loadSavedAlbum(id);
      if (token !== generation) return;
      if (!saved) throw new Error('この本が見つかりません。同じブラウザの本棚から、もう一度選んでください。');
      album = { ...saved.album, pages: saved.album.pages.map(page => ({ ...page })) };
      $('book-title').textContent = album.title || 'タイトルのない本';
      $('book-subtitle').textContent = album.subtitle || '思い出を、一冊に。';
      $('book-page-count').textContent = `写真 ${album.pages.length}ページ ＋ 表紙`;
      edit.href = `./index.html?album=${encodeURIComponent(id)}`;
      edit.hidden = false;
      read.hidden = false;
      await reader.open(0);
    } catch (problem) {
      if (token === generation) fail(problem);
    } finally {
      if (token === generation) {
        busy = false;
        loading.hidden = true;
        read.disabled = !album;
        retry.disabled = false;
      }
    }
  }

  read.addEventListener('click', () => { if (!busy) void load(); });
  retry.addEventListener('click', () => void load());
  dialog.addEventListener('close', () => { if (!dialog.open && album) read.focus(); });
  return { load };
}

if (typeof document !== 'undefined' && document.body?.dataset.page === 'book') void createBookPage().load();
