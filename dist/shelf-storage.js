import { validateAlbum } from './storage.js';

const DATABASE_NAME = 'memory-album';
const STORE_NAME = 'drafts';
const LEGACY_KEY = 'current';
const ALBUM_PREFIX = 'shelf:album:';
const SUMMARY_PREFIX = 'shelf:summary:';
const SUMMARY_UPPER_BOUND = 'shelf:summary;';
const MAX_THUMBNAIL_LENGTH = 64 * 1024;
const THUMBNAIL_CACHE_SIZE = 8;
const THUMBNAIL_CACHE_SOURCE_LIMIT = 24 * 1024 * 1024;
const thumbnailCache = new Map();
let thumbnailSourceLength = 0;

function shelfError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function corruptError() {
  return shelfError('ALBUM_CORRUPT', '本棚に保存したデータの形式を確認できません。元のデータを保護するため、上書きしていません。別の編集データがあれば読み込んでください。');
}

function conflictError(expected, actual) {
  const error = shelfError('ALBUM_CONFLICT', 'このアルバムは別のタブで更新されています。編集データを書き出して保管し、本棚から開き直してください。');
  error.expectedRevision = expected;
  error.actualRevision = actual;
  return error;
}

function storageError(error, action) {
  if (error?.code === 'ALBUM_CONFLICT' || error?.code === 'ALBUM_CORRUPT' || error?.code === 'ALBUM_INVALID') return error;
  if (error?.name === 'QuotaExceededError') {
    return shelfError('ALBUM_STORAGE_FULL', '端末の保存容量が足りないため、本棚に保存できませんでした。編集データを書き出して保管してください。');
  }
  if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') {
    return shelfError('ALBUM_STORAGE_DENIED', 'ブラウザーが端末への保存を許可していません。ブラウザーの設定を確認し、編集データを書き出して保管してください。');
  }
  return shelfError('ALBUM_STORAGE_ERROR', `本棚のデータを${action}できませんでした。編集データを書き出して保管し、ブラウザーの設定や空き容量を確認してください。`);
}

function validId(value) {
  if (typeof value !== 'string' || !value.length || Array.from(value).length > 128) {
    throw shelfError('ALBUM_INVALID', 'アルバムのIDが正しくありません。');
  }
  return value;
}

function own(record, field) {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw corruptError();
  return descriptor.value;
}

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw corruptError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw corruptError();
  return value;
}

function savedRecord(value, id) {
  try {
    const record = plainRecord(value);
    const revision = own(record, 'revision');
    if (!Number.isSafeInteger(revision) || revision < 1) throw corruptError();
    const album = validateAlbum(own(record, 'album'));
    if (album.id !== id) throw corruptError();
    return { album, revision };
  } catch {
    throw corruptError();
  }
}

function smallJpeg(dataUrl) {
  const bytes = atob(dataUrl.slice('data:image/jpeg;base64,'.length));
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes.charCodeAt(offset++) !== 255) return false;
    while (bytes.charCodeAt(offset) === 255) offset += 1;
    const marker = bytes.charCodeAt(offset++);
    if (marker === 217 || marker === 218) return false;
    const length = bytes.charCodeAt(offset) * 256 + bytes.charCodeAt(offset + 1);
    if (length < 2 || offset + length > bytes.length) return false;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      const height = bytes.charCodeAt(offset + 3) * 256 + bytes.charCodeAt(offset + 4);
      const width = bytes.charCodeAt(offset + 5) * 256 + bytes.charCodeAt(offset + 6);
      return width > 0 && width <= 160 && height > 0 && height <= 226;
    }
    offset += length;
  }
  return false;
}

function summaryRecord(value, id) {
  try {
    const record = plainRecord(value);
    const thumbnail = own(record, 'thumbnail');
    if (thumbnail !== null && (typeof thumbnail !== 'string' || thumbnail.length > MAX_THUMBNAIL_LENGTH || !thumbnail.startsWith('data:image/jpeg;base64,'))) throw corruptError();
    // Reuse the import validator for text, dates and safe JPEG data, without any
    // full-size page/cover/background images entering this metadata-only read.
    const metadata = validateAlbum({
      schemaVersion: 1,
      id: own(record, 'id'),
      title: own(record, 'title'),
      subtitle: own(record, 'subtitle'),
      theme: own(record, 'theme'),
      coverImage: thumbnail,
      coverImageName: '',
      coverFit: 'contain',
      pages: [],
      createdAt: own(record, 'createdAt'),
      updatedAt: own(record, 'updatedAt'),
    });
    if (thumbnail !== null && !smallJpeg(thumbnail)) throw corruptError();
    const pageCount = own(record, 'pageCount');
    if (metadata.id !== id || !Number.isInteger(pageCount) || pageCount < 0 || pageCount > 100) throw corruptError();
    return {
      id: metadata.id,
      title: metadata.title,
      subtitle: metadata.subtitle,
      theme: metadata.theme,
      pageCount,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      thumbnail,
    };
  } catch {
    throw corruptError();
  }
}

function matchingSummary(summary, album) {
  return summary.id === album.id && summary.title === album.title && summary.subtitle === album.subtitle
    && summary.theme === album.theme && summary.pageCount === album.pages.length
    && summary.createdAt === album.createdAt && summary.updatedAt === album.updatedAt;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    try {
      if (!globalThis.indexedDB) {
        reject(shelfError('ALBUM_STORAGE_DENIED', 'このブラウザーでは本棚への保存を利用できません。編集データを書き出して保管してください。'));
        return;
      }
      request = globalThis.indexedDB.open(DATABASE_NAME, 1);
    } catch (error) {
      reject(storageError(error, '読み書き'));
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onerror = () => {
      settled = true;
      reject(storageError(request.error, '読み書き'));
    };
    request.onblocked = () => {
      settled = true;
      reject(shelfError('ALBUM_STORAGE_ERROR', '別のタブが本棚の保存先を使用しています。ほかのタブを閉じて、もう一度お試しください。'));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) { database.close(); return; }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

async function transact(mode, action, run) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      let transaction;
      let failure;
      let nativeError;
      let result;
      try {
        transaction = database.transaction(STORE_NAME, mode);
      } catch (error) {
        reject(storageError(error, action));
        return;
      }
      const fail = error => {
        failure ||= error;
        try { transaction.abort(); }
        catch { reject(storageError(failure, action)); }
      };
      const watch = (request, onSuccess = () => {}) => {
        request.onerror = () => { nativeError ||= request.error; };
        request.onsuccess = () => {
          try { onSuccess(request.result); }
          catch (error) { fail(error); }
        };
        return request;
      };
      transaction.onerror = event => { nativeError ||= transaction.error || event.target?.error; };
      transaction.onabort = () => reject(storageError(failure || nativeError || transaction.error, action));
      // A successful request may still be rolled back by a later request or by
      // quota enforcement. Only the complete event means these writes persisted.
      transaction.oncomplete = () => failure ? reject(storageError(failure, action)) : resolve(result);
      try {
        run(transaction.objectStore(STORE_NAME), { watch, fail, setResult: value => { result = value; } });
      } catch (error) { fail(error); }
    });
  } finally { database.close(); }
}

function readEntry(key) {
  return transact('readonly', '読み込み', (store, { watch, setResult }) => {
    watch(store.openCursor(key), cursor => setResult(cursor ? { found: true, value: cursor.value } : { found: false, value: undefined }));
  });
}

export async function readLegacyDraft() {
  const entry = await readEntry(LEGACY_KEY);
  return !entry.found || entry.value === undefined ? null : entry.value;
}

async function drawThumbnail(cover) {
  let image;
  let canvas;
  let timeout;
  try {
    image = new globalThis.Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Thumbnail decode timeout')), 5000);
      image.onload = resolve;
      image.onerror = reject;
      image.src = cover;
    });
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) return null;
    const scale = Math.min(1, 160 / width, 226 / height);
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.78);
    return typeof data === 'string' && data.length <= MAX_THUMBNAIL_LENGTH && data.startsWith('data:image/jpeg;base64,') ? data : null;
  } catch {
    // A missing decoder or a failed optional thumbnail must never lose a book.
    return null;
  } finally {
    clearTimeout(timeout);
    if (image) { image.onload = null; image.onerror = null; image.src = ''; }
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

function thumbnailFor(cover) {
  if (!cover || typeof globalThis.Image !== 'function' || typeof globalThis.document?.createElement !== 'function') return Promise.resolve(null);
  if (thumbnailCache.has(cover)) {
    const pending = thumbnailCache.get(cover);
    thumbnailCache.delete(cover);
    thumbnailCache.set(cover, pending);
    return pending;
  }
  const pending = drawThumbnail(cover);
  if (cover.length <= THUMBNAIL_CACHE_SOURCE_LIMIT) {
    thumbnailCache.set(cover, pending);
    thumbnailSourceLength += cover.length;
    while (thumbnailCache.size > THUMBNAIL_CACHE_SIZE || thumbnailSourceLength > THUMBNAIL_CACHE_SOURCE_LIMIT) {
      const oldest = thumbnailCache.keys().next().value;
      thumbnailSourceLength -= oldest.length;
      thumbnailCache.delete(oldest);
    }
  }
  return pending;
}

async function makeSummary(album) {
  const summary = {
    id: album.id,
    title: album.title,
    subtitle: album.subtitle,
    theme: album.theme,
    pageCount: album.pages.length,
    createdAt: album.createdAt,
    updatedAt: album.updatedAt,
    thumbnail: await thumbnailFor(album.coverImage),
  };
  if (summary.thumbnail !== null) {
    try { return summaryRecord(summary, album.id); }
    catch { summary.thumbnail = null; }
  }
  return summary;
}

export async function migrateLegacyDraft() {
  const entry = await readEntry(LEGACY_KEY);
  if (!entry.found) return { found: false, migrated: false, invalid: false };
  let album;
  try { album = validateAlbum(entry.value); }
  catch { return { found: true, migrated: false, invalid: true }; }
  const summary = await makeSummary(album);
  const migrated = await transact('readwrite', '移行', (store, { watch, setResult }) => {
    let albumKey;
    let summaryKey;
    let completed = 0;
    const decide = () => {
      completed += 1;
      if (completed !== 2) return;
      if (albumKey !== undefined || summaryKey !== undefined) { setResult(false); return; }
      watch(store.put({ album, revision: 1 }, ALBUM_PREFIX + album.id));
      watch(store.put(summary, SUMMARY_PREFIX + album.id));
      setResult(true);
    };
    watch(store.getKey(ALBUM_PREFIX + album.id), key => { albumKey = key; decide(); });
    watch(store.getKey(SUMMARY_PREFIX + album.id), key => { summaryKey = key; decide(); });
  });
  return { found: true, migrated, invalid: false, albumId: album.id };
}

export async function listAlbums() {
  await migrateLegacyDraft();
  return transact('readonly', '読み込み', (store, { watch, setResult }) => {
    const summaries = [];
    const range = globalThis.IDBKeyRange.bound(SUMMARY_PREFIX, SUMMARY_UPPER_BOUND, false, true);
    watch(store.openCursor(range), cursor => {
      if (!cursor) {
        summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
        setResult(summaries);
        return;
      }
      if (typeof cursor.key !== 'string' || !cursor.key.startsWith(SUMMARY_PREFIX)) throw corruptError();
      summaries.push(summaryRecord(cursor.value, cursor.key.slice(SUMMARY_PREFIX.length)));
      cursor.continue();
    });
  });
}

export async function loadSavedAlbum(id) {
  validId(id);
  const entry = await readEntry(ALBUM_PREFIX + id);
  return entry.found ? savedRecord(entry.value, id) : null;
}

export async function saveAlbum(candidate, { expectedRevision = 0 } = {}) {
  const album = validateAlbum(candidate);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw shelfError('ALBUM_INVALID', '保存バージョンが正しくありません。本棚から開き直してください。');
  const summary = await makeSummary(album);
  return transact('readwrite', '保存', (store, { watch, setResult }) => {
    let existingAlbum;
    let existingSummary;
    let completed = 0;
    const decide = () => {
      completed += 1;
      if (completed !== 2) return;
      let currentRevision = 0;
      let saved;
      if (existingAlbum) {
        saved = savedRecord(existingAlbum.value, album.id);
        currentRevision = saved.revision;
      } else if (existingSummary) throw corruptError();
      if (currentRevision !== expectedRevision) throw conflictError(expectedRevision, currentRevision);
      if (saved) {
        if (!existingSummary) throw corruptError();
        const savedSummary = summaryRecord(existingSummary.value, album.id);
        if (!matchingSummary(savedSummary, saved.album)) throw corruptError();
      }
      if (currentRevision === Number.MAX_SAFE_INTEGER) throw shelfError('ALBUM_INVALID', 'このアルバムの保存バージョンが上限に達しました。編集データを書き出し、新しいアルバムとして保管してください。');
      const record = { album, revision: currentRevision + 1 };
      watch(store.put(record, ALBUM_PREFIX + album.id));
      watch(store.put(summary, SUMMARY_PREFIX + album.id));
      setResult(record);
    };
    watch(store.openCursor(ALBUM_PREFIX + album.id), cursor => { existingAlbum = cursor ? { value: cursor.value } : null; decide(); });
    watch(store.openCursor(SUMMARY_PREFIX + album.id), cursor => { existingSummary = cursor ? { value: cursor.value } : null; decide(); });
  });
}
