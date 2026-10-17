import { migrateLegacyDraft, listAlbums, loadSavedAlbum, saveAlbum, readLegacyDraft } from './shelf-storage.js';
import { readAlbumFile, decodeAlbumImages } from './album-import.js';
import { makeId, serializeAlbum } from './storage.js';
import { downloadBlob, sanitizeFilename } from './album-renderer.js';

const defaults = { migrateLegacyDraft, listAlbums, loadSavedAlbum, saveAlbum, readLegacyDraft, readAlbumFile, decodeAlbumImages, makeId, serializeAlbum, downloadBlob, sanitizeFilename };

export function createBookshelf({ document: doc = globalThis.document, window: win = doc.defaultView, services = {} } = {}) {
  const api = { ...defaults, ...services };
  const $ = id => doc.getElementById(id);
  const grid = $('shelf-grid');
  const empty = $('shelf-empty');
  const loading = $('shelf-loading');
  const error = $('shelf-error');
  const errorText = $('shelf-error-text');
  const message = $('shelf-message');
  const input = $('shelf-file');
  const importButton = $('shelf-import');
  let generation = 0;
  let importing = false;

  const notice = text => { message.textContent = text; message.hidden = !text; };
  function fail(problem, heading = '操作を完了できませんでした。', storageFailure = false) {
    $('shelf-error-heading').textContent = heading;
    errorText.textContent = problem?.message || '本棚を読み込めませんでした。もう一度お試しください。';
    $('shelf-storage-help').hidden = !storageFailure;
    error.hidden = false;
  }
  function node(tag, className, text) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function link(label, path, className = 'button button-secondary') {
    const element = node('a', className, label);
    element.href = path;
    element.target = '_blank';
    element.rel = 'noopener';
    return element;
  }
  function formatDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' }).format(date) : '日時不明';
  }
  function card(summary) {
    const title = summary.title || 'タイトルのない本';
    const item = node('li', 'shelf-item');
    const article = node('article', 'shelf-card');
    const theme = ['linen', 'sky', 'rose', 'plain'].includes(summary.theme) ? summary.theme : 'linen';
    const scrapbook = summary.coverStyle === 'scrapbook';
    const cover = node('div', `shelf-cover cover-${theme}${scrapbook ? ' cover-scrapbook' : ''}`);
    const fallback = node('div', 'shelf-cover-title', title);
    cover.append(fallback);
    const photoMount = scrapbook ? node('div', 'shelf-scrap-photo') : cover;
    if (scrapbook) {
      fallback.hidden = false;
      const tape = node('span', 'shelf-scrap-tape');
      const pins = node('span', 'shelf-scrap-pins');
      tape.setAttribute('aria-hidden', 'true');
      pins.setAttribute('aria-hidden', 'true');
      cover.append(photoMount, tape, pins);
    }
    if (typeof summary.thumbnail === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(summary.thumbnail)) {
      const thumbnail = node('img', 'shelf-thumbnail');
      thumbnail.alt = '';
      thumbnail.loading = 'lazy';
      thumbnail.decoding = 'async';
      thumbnail.src = summary.thumbnail;
      fallback.hidden = !scrapbook;
      thumbnail.addEventListener('error', () => { thumbnail.remove(); fallback.hidden = false; });
      photoMount.append(thumbnail);
    }
    const details = node('div', 'shelf-card-details');
    const heading = node('h2', 'shelf-card-title', title);
    const pages = node('p', 'shelf-card-meta', `写真 ${summary.pageCount}ページ ＋ 表紙`);
    const date = node('time', 'shelf-card-date', `更新 ${formatDate(summary.updatedAt)}`);
    date.dateTime = summary.updatedAt;
    const actions = node('div', 'shelf-card-actions');
    const id = encodeURIComponent(summary.id);
    const read = link('読む', `./book.html?album=${id}`, 'button button-primary');
    read.setAttribute('aria-label', `${title}を読む（新しいタブ）`);
    const edit = link('編集', `./index.html?album=${id}`);
    edit.setAttribute('aria-label', `${title}を編集（新しいタブ）`);
    const download = node('button', 'text-button shelf-download', '編集データを保存');
    download.type = 'button';
    download.setAttribute('aria-label', `${title}の編集データを保存`);
    download.addEventListener('click', () => void downloadAlbum(summary.id, download));
    actions.append(read, edit);
    details.append(heading, pages, date, actions, download);
    article.append(cover, details);
    item.append(article);
    return item;
  }

  async function reload() {
    const token = ++generation;
    loading.hidden = false;
    error.hidden = true;
    grid.setAttribute('aria-busy', 'true');
    try {
      const migration = await api.migrateLegacyDraft();
      if (token === generation) $('legacy-warning').hidden = !migration.invalid;
      const summaries = await api.listAlbums();
      if (token !== generation) return;
      const fragment = doc.createDocumentFragment();
      for (const summary of summaries) fragment.append(card(summary));
      grid.replaceChildren(fragment);
      empty.hidden = summaries.length !== 0;
      $('shelf-count').textContent = `${summaries.length}冊のアルバム`;
    } catch (problem) {
      if (token !== generation) return;
      empty.hidden = true;
      fail(problem, '本棚を確認できませんでした。', true);
    } finally {
      if (token === generation) {
        loading.hidden = true;
        grid.setAttribute('aria-busy', 'false');
      }
    }
  }

  async function importFile(file) {
    if (importing) return false;
    importing = true;
    importButton.disabled = true;
    input.disabled = true;
    error.hidden = true;
    notice('編集データを確認しています…');
    try {
      const parsed = await api.readAlbumFile(file);
      await api.decodeAlbumImages(parsed, { onProgress: ({ current, total }) => notice(`写真を確認しています… ${current} / ${total}`) });
      const album = { ...parsed, id: api.makeId(), updatedAt: new Date().toISOString(), pages: parsed.pages.map(page => ({ ...page })) };
      await api.saveAlbum(album, { expectedRevision: 0 });
      notice(`「${album.title || 'タイトルのない本'}」を、新しい一冊として追加しました。`);
      await reload();
      return true;
    } catch (problem) {
      notice('');
      fail(problem, '編集データを追加できませんでした。');
      return false;
    } finally {
      importing = false;
      importButton.disabled = false;
      input.disabled = false;
    }
  }

  async function downloadAlbum(id, button) {
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try {
      const saved = await api.loadSavedAlbum(id);
      if (!saved) throw new Error('この本が見つかりません。本棚を再読み込みしてください。');
      api.downloadBlob(new Blob([api.serializeAlbum(saved.album)], { type: 'application/json;charset=utf-8' }), `${api.sanitizeFilename(saved.album.title)}.album.json`);
      notice('編集データの保存を開始しました。別の端末でも、このファイルから続きを開けます。');
    } catch (problem) { fail(problem); }
    finally { if (button) button.disabled = false; }
  }

  async function downloadLegacy() {
    const button = $('legacy-download');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const raw = await api.readLegacyDraft();
      if (raw === null) throw new Error('以前の作業データが見つかりませんでした。');
      const content = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
      api.downloadBlob(new Blob([content], { type: 'application/json;charset=utf-8' }), '復元できなかった旧データ.json');
      notice('以前の作業データの保存を開始しました。');
    } catch (problem) { fail(problem); }
    finally { button.disabled = false; }
  }

  importButton.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { const file = input.files?.[0]; input.value = ''; if (file) void importFile(file); });
  $('shelf-retry').addEventListener('click', () => void reload());
  $('shelf-refresh').addEventListener('click', () => void reload());
  $('legacy-download').addEventListener('click', () => void downloadLegacy());
  win.addEventListener('focus', () => { if (!importing) void reload(); });
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible' && !importing) void reload(); });
  return { reload, importFile, downloadAlbum, downloadLegacy };
}

if (typeof document !== 'undefined' && document.body?.dataset.page === 'bookshelf') void createBookshelf().reload();
