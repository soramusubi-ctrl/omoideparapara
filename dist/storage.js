const SCHEMA_VERSION = 1;
const DATABASE_NAME = 'memory-album';
const STORE_NAME = 'drafts';
const DRAFT_KEY = 'current';
const MAX_INPUT_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2400;
const DEFAULT_BACKGROUND_OPACITY = 0.22;
const THEMES = new Set(['linen', 'sky', 'rose', 'plain']);
const FONTS = new Set(['serif', 'sans', 'rounded']);
const FITS = new Set(['contain', 'cover']);
const FRAMES = new Set(['none', 'white', 'polaroid', 'rounded']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const MAX_VALIDATED_IMAGES = 128;
// Image strings are immutable. Reuse successful checks while editing album text,
// and limit retained references when photographs are removed or replaced.
const validatedImages = new Map();

function invalid(message) {
  return new Error(`アルバムの形式を確認してください。${message}`);
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label}が正しくありません。`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(`${label}が正しくありません。`);
  }
  return value;
}

function own(value, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw invalid(`${label}がありません、または正しくありません。`);
  }
  return descriptor.value;
}

function optionalOwn(value, key, label, fallback) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return fallback;
  if (!Object.hasOwn(descriptor, 'value')) throw invalid(`${label}が正しくありません。`);
  return descriptor.value;
}

function boundedString(value, maximum, label, minimum = 0) {
  if (typeof value !== 'string') throw invalid(`${label}は文字で入力してください。`);
  const length = Array.from(value).length;
  if (length < minimum || length > maximum) {
    throw invalid(`${label}は${maximum}文字以内で入力してください。`);
  }
  return value;
}

function enumValue(value, values, label) {
  if (!values.has(value)) throw invalid(`${label}が正しくありません。`);
  return value;
}

function frameValue(value, label) {
  return enumValue(value === 'corners' ? 'rounded' : value, FRAMES, label);
}

function backgroundOpacity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalid('背景の濃さは0から1までの数値にしてください。');
  }
  return value;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function dateValue(value) {
  if (value !== '' && !validDate(value)) throw invalid('写真の日付が正しくありません。');
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value.length > 40) throw invalid(`${label}が正しくありません。`);
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !validDate(parts[1]) || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59) {
    throw invalid(`${label}が正しくありません。`);
  }
  if (parts[5] !== 'Z') {
    const [hours, minutes] = parts[5].slice(1).split(':').map(Number);
    if (hours > 23 || minutes > 59) throw invalid(`${label}が正しくありません。`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw invalid(`${label}が正しくありません。`);
  return value;
}

function uint32(bytes, offset, littleEndian = false) {
  if (littleEndian) {
    return (bytes.charCodeAt(offset) + bytes.charCodeAt(offset + 1) * 256
      + bytes.charCodeAt(offset + 2) * 65536 + bytes.charCodeAt(offset + 3) * 16777216) >>> 0;
  }
  return (bytes.charCodeAt(offset) * 16777216 + bytes.charCodeAt(offset + 1) * 65536
    + bytes.charCodeAt(offset + 2) * 256 + bytes.charCodeAt(offset + 3)) >>> 0;
}

function isPng(bytes) {
  if (!bytes.startsWith('\x89PNG\r\n\x1a\n')) return false;
  let offset = 8;
  let foundData = false;
  let foundHeader = false;
  while (offset + 12 <= bytes.length) {
    const length = uint32(bytes, offset);
    const type = bytes.slice(offset + 4, offset + 8);
    if (length > bytes.length - offset - 12) return false;
    if (!foundHeader) {
      if (type !== 'IHDR' || length !== 13 || !uint32(bytes, offset + 8) || !uint32(bytes, offset + 12)) return false;
      foundHeader = true;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT' && length > 0) foundData = true;
    offset += length + 12;
    if (type === 'IEND') return length === 0 && foundData && offset === bytes.length;
  }
  return false;
}

function isJpeg(bytes) {
  if (bytes.length < 16 || !bytes.startsWith('\xff\xd8\xff') || !bytes.endsWith('\xff\xd9')) return false;
  let offset = 2;
  let foundFrame = false;
  let foundScan = false;
  let frameComponents = new Set();
  while (offset < bytes.length) {
    if (bytes.charCodeAt(offset++) !== 255) return false;
    while (bytes.charCodeAt(offset) === 255) offset += 1;
    const marker = bytes.charCodeAt(offset++);
    if (marker === 217) return foundFrame && foundScan && offset === bytes.length;
    if (marker === 0 || marker === 216 || marker < 192 || offset + 2 > bytes.length) return false;
    if (marker >= 208 && marker <= 215) continue;
    const length = bytes.charCodeAt(offset) * 256 + bytes.charCodeAt(offset + 1);
    if (length < 2 || offset + length > bytes.length) return false;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8 || !(bytes.charCodeAt(offset + 3) * 256 + bytes.charCodeAt(offset + 4))
        || !(bytes.charCodeAt(offset + 5) * 256 + bytes.charCodeAt(offset + 6))) return false;
      const components = bytes.charCodeAt(offset + 7);
      if (components < 1 || components > 4 || length !== 8 + 3 * components || bytes.charCodeAt(offset + 2) !== 8) return false;
      frameComponents = new Set();
      for (let index = 0; index < components; index += 1) {
        const component = bytes.charCodeAt(offset + 8 + 3 * index);
        if (frameComponents.has(component)) return false;
        frameComponents.add(component);
      }
      foundFrame = true;
    }
    if (marker === 218) {
      const components = bytes.charCodeAt(offset + 2);
      if (!foundFrame || components < 1 || components > frameComponents.size || length !== 6 + 2 * components) return false;
      const scanComponents = new Set();
      for (let index = 0; index < components; index += 1) {
        const component = bytes.charCodeAt(offset + 3 + 2 * index);
        if (!frameComponents.has(component) || scanComponents.has(component)) return false;
        scanComponents.add(component);
      }
    }
    offset += length;
    if (marker === 218) {
      foundScan = true;
      const scanStart = offset;
      while (offset < bytes.length) {
        if (bytes.charCodeAt(offset) !== 255) { offset += 1; continue; }
        const next = bytes.charCodeAt(offset + 1);
        if (next === 0 || (next >= 208 && next <= 215)) { offset += 2; continue; }
        break;
      }
      if (offset === scanStart) return false;
    }
  }
  return false;
}

function isWebp(bytes) {
  if (bytes.length < 26 || bytes.slice(0, 4) !== 'RIFF' || bytes.slice(8, 12) !== 'WEBP'
    || uint32(bytes, 4, true) + 8 !== bytes.length) return false;
  let offset = 12;
  let foundImage = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.slice(offset, offset + 4);
    const length = uint32(bytes, offset + 4, true);
    if (length > bytes.length - offset - 8) return false;
    if (type === 'VP8 ') {
      if (length < 10 || bytes.slice(offset + 11, offset + 14) !== '\x9d\x01\x2a') return false;
      const frameTag = bytes.charCodeAt(offset + 8) + bytes.charCodeAt(offset + 9) * 256 + bytes.charCodeAt(offset + 10) * 65536;
      const width = (bytes.charCodeAt(offset + 14) + bytes.charCodeAt(offset + 15) * 256) & 16383;
      const height = (bytes.charCodeAt(offset + 16) + bytes.charCodeAt(offset + 17) * 256) & 16383;
      if ((frameTag & 1) || !(frameTag >> 5) || (frameTag >> 5) > length - 10 || !width || !height) return false;
      foundImage = true;
    } else if (type === 'VP8L') {
      if (length <= 5 || bytes.charCodeAt(offset + 8) !== 47 || (bytes.charCodeAt(offset + 12) & 224)) return false;
      foundImage = true;
    } else if (type === 'ANMF') {
      if (length < 24) return false;
      foundImage = true;
    }
    offset += 8 + length + (length % 2);
  }
  return foundImage && offset === bytes.length;
}

function imageValue(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4 + 32) {
    throw invalid('写真のデータが大きすぎるか、正しくありません。');
  }
  if (validatedImages.has(value)) {
    validatedImages.delete(value);
    validatedImages.set(value, true);
    return value;
  }
  const prefix = /^data:image\/(jpeg|png|webp);base64,/.exec(value);
  if (!prefix) throw invalid('写真はJPEG・PNG・WebP形式で保存してください。');
  const encoded = value.slice(prefix[0].length);
  if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw invalid('写真のデータが正しくありません。');
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if (encoded.length / 4 * 3 - padding > MAX_INPUT_BYTES) throw invalid('写真のデータが大きすぎます。');
  let bytes;
  try {
    bytes = atob(encoded);
  } catch {
    throw invalid('写真のデータを読み込めません。');
  }
  // Reject noncanonical padding as well as data merely labelled as an image.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if ((padding === 2 && (alphabet.indexOf(encoded.at(-3)) & 15) !== 0)
    || (padding === 1 && (alphabet.indexOf(encoded.at(-2)) & 3) !== 0)) {
    throw invalid('写真のデータが正しくありません。');
  }
  const matches = prefix[1] === 'jpeg' ? isJpeg(bytes) : prefix[1] === 'png' ? isPng(bytes) : isWebp(bytes);
  if (!matches) throw invalid('写真のデータが壊れているか、形式が一致していません。');
  validatedImages.set(value, true);
  if (validatedImages.size > MAX_VALIDATED_IMAGES) validatedImages.delete(validatedImages.keys().next().value);
  return value;
}

export function makeId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function createAlbum() {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: makeId(),
    title: '思い出のアルバム',
    subtitle: '',
    theme: 'linen',
    font: 'serif',
    coverImage: null,
    coverImageName: '',
    coverFit: 'contain',
    coverFrame: 'none',
    backgroundImage: null,
    backgroundImageName: '',
    backgroundOpacity: DEFAULT_BACKGROUND_OPACITY,
    pages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function validateAlbum(candidate) {
  const album = record(candidate, 'アルバム');
  if (own(album, 'schemaVersion', '保存形式') !== SCHEMA_VERSION) {
    throw invalid('この保存形式のバージョンには対応していません。');
  }
  const pages = own(album, 'pages', 'ページ');
  if (!Array.isArray(pages) || pages.length > 100) throw invalid('ページは100枚以内にしてください。');
  const pageIds = new Set();
  const normalizedPages = Array.from({ length: pages.length }, (_, index) => {
    const candidatePage = own(pages, String(index), `${index + 1}ページ目`);
    const page = record(candidatePage, `${index + 1}ページ目`);
    const id = boundedString(own(page, 'id', 'ページID'), 128, 'ページID', 1);
    if (pageIds.has(id)) throw invalid('ページIDが重複しています。');
    pageIds.add(id);
    return {
      id,
      image: imageValue(own(page, 'image', '写真')),
      imageName: boundedString(own(page, 'imageName', '写真の名前'), 260, '写真の名前'),
      date: dateValue(own(page, 'date', '写真の日付')),
      note: boundedString(own(page, 'note', 'ひとこと'), 300, 'ひとこと'),
      fit: enumValue(own(page, 'fit', '写真の表示方法'), FITS, '写真の表示方法'),
      frame: frameValue(optionalOwn(page, 'frame', '写真のフレーム', 'none'), '写真のフレーム'),
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    id: boundedString(own(album, 'id', 'アルバムID'), 128, 'アルバムID', 1),
    title: boundedString(own(album, 'title', 'タイトル'), 120, 'タイトル'),
    subtitle: boundedString(own(album, 'subtitle', 'サブタイトル'), 180, 'サブタイトル'),
    theme: enumValue(own(album, 'theme', 'テーマ'), THEMES, 'テーマ'),
    font: enumValue(optionalOwn(album, 'font', '文字の書体', 'serif'), FONTS, '文字の書体'),
    coverImage: imageValue(own(album, 'coverImage', '表紙の写真')),
    coverImageName: boundedString(own(album, 'coverImageName', '表紙の写真の名前'), 260, '表紙の写真の名前'),
    coverFit: enumValue(own(album, 'coverFit', '表紙の表示方法'), FITS, '表紙の表示方法'),
    coverFrame: frameValue(optionalOwn(album, 'coverFrame', '表紙のフレーム', 'none'), '表紙のフレーム'),
    backgroundImage: imageValue(optionalOwn(album, 'backgroundImage', '背景の写真', null)),
    backgroundImageName: boundedString(optionalOwn(album, 'backgroundImageName', '背景の写真の名前', ''), 260, '背景の写真の名前'),
    backgroundOpacity: backgroundOpacity(optionalOwn(album, 'backgroundOpacity', '背景の濃さ', DEFAULT_BACKGROUND_OPACITY)),
    pages: normalizedPages,
    createdAt: timestamp(own(album, 'createdAt', '作成日時'), '作成日時'),
    updatedAt: timestamp(own(album, 'updatedAt', '更新日時'), '更新日時'),
  };
}

export function serializeAlbum(album) {
  return JSON.stringify(validateAlbum(album), null, 2);
}

function storageError(error, action) {
  if (error?.name === 'QuotaExceededError') {
    return new Error('端末の保存容量が足りません。アルバムを書き出してから、写真やページを減らしてください。');
  }
  if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') {
    return new Error('ブラウザーが端末への保存を許可していません。ブラウザーの設定を確認し、アルバムを書き出して保管してください。');
  }
  return new Error(`アルバムを${action}できませんでした。アルバムを書き出して保管し、ブラウザーの設定や空き容量を確認してください。`);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    let indexedDatabase;
    try {
      indexedDatabase = globalThis.indexedDB;
    } catch (error) {
      reject(storageError(error, '読み書き'));
      return;
    }
    if (!indexedDatabase) {
      reject(new Error('このブラウザーでは端末への保存を利用できません。アルバムを書き出して保管してください。'));
      return;
    }
    let settled = false;
    let request;
    try {
      request = indexedDatabase.open(DATABASE_NAME, 1);
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
      reject(new Error('別のタブが保存先を使用しています。このアルバムを開いているほかのタブを閉じて、もう一度お試しください。'));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) { database.close(); return; }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

async function withStore(mode, action, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      let transaction;
      let request;
      let requestError;
      try {
        transaction = database.transaction(STORE_NAME, mode);
        request = operation(transaction.objectStore(STORE_NAME));
      } catch (error) {
        if (transaction) {
          try { transaction.abort(); } catch { /* Already closed. */ }
        }
        reject(storageError(error, action));
        return;
      }
      request.onerror = () => { requestError = request.error; };
      transaction.onabort = () => reject(storageError(transaction.error || requestError, action));
      transaction.onerror = () => { requestError ||= transaction.error; };
      // A successful put request can still be rolled back: only commit counts as saved.
      transaction.oncomplete = () => resolve(request.result);
    });
  } finally {
    database.close();
  }
}

export async function loadDraft() {
  const stored = await withStore('readonly', '読み込み', (store) => store.get(DRAFT_KEY));
  if (stored === undefined) return null;
  try {
    return validateAlbum(stored);
  } catch {
    throw new Error('端末に保存したアルバムのデータを読み込めません。書き出したアルバムがある場合は、そちらを読み込んでください。');
  }
}

export async function saveDraft(album) {
  const normalized = validateAlbum(album);
  await withStore('readwrite', '保存', (store) => store.put(normalized, DRAFT_KEY));
  return normalized;
}

export async function clearDraft() {
  await withStore('readwrite', '削除', (store) => store.delete(DRAFT_KEY));
}

function sniffImage(bytes) {
  const starts = (...signature) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(255, 216, 255)) return true;
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return true;
  const ascii = (offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return true;
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return true;
  if (ascii(4, 4) === 'ftyp') {
    const length = Math.min(bytes.length, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0));
    for (let offset = 8; offset + 4 <= length; offset += 4) {
      if (offset === 12) continue;
      if (ascii(offset, 4) === 'avif' || ascii(offset, 4) === 'avis') return true;
    }
  }
  return false;
}

async function decodeImage(file) {
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      const bitmap = await globalThis.createImageBitmap(file, { imageOrientation: 'from-image' });
      if (!bitmap.width || !bitmap.height) { bitmap.close(); throw new Error('Empty image'); }
      return { source: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close() };
    } catch {
      // Image supports some formats that createImageBitmap cannot decode.
    }
  }
  let objectUrl;
  let image;
  try {
    objectUrl = URL.createObjectURL(file);
    image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Image decode failed'));
      image.src = objectUrl;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Empty image');
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => { image.onload = null; image.onerror = null; image.removeAttribute('src'); },
    };
  } catch (error) {
    if (image) { image.onload = null; image.onerror = null; image.removeAttribute('src'); }
    throw error;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob && blob.type === 'image/jpeg') resolve(blob);
      else reject(new Error('JPEG encoding failed'));
    }, 'image/jpeg', 0.92);
  });
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Image read failed'));
    reader.onerror = () => reject(reader.error || new Error('Image read failed'));
    reader.onabort = () => reject(new Error('Image read cancelled'));
    reader.readAsDataURL(blob);
  });
}

export async function fileToImage(file) {
  if (typeof Blob === 'undefined' || !(file instanceof Blob) || file.size === 0) {
    throw new Error('写真のファイルを選んでください。');
  }
  if (file.size > MAX_INPUT_BYTES) throw new Error('写真は1枚30MB以内のファイルを選んでください。');
  if (file.type && !IMAGE_TYPES.has(file.type.toLowerCase()) && file.type !== 'application/octet-stream') {
    throw new Error('JPEG・PNG・WebP・GIF・AVIF形式の写真を選んでください。');
  }
  let decoded;
  let canvas;
  try {
    const header = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if (!sniffImage(header)) throw new Error('Unsupported image signature');
    decoded = await decodeImage(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(decoded.source, 0, 0, width, height);
    const dataUrl = await blobDataUrl(await canvasBlob(canvas));
    return {
      dataUrl,
      name: Array.from(typeof file.name === 'string' && file.name ? file.name : '写真.jpg').slice(0, 260).join(''),
      width,
      height,
    };
  } catch {
    throw new Error('この写真を読み込めませんでした。JPEG・PNG・WebP形式で保存し直すか、別の写真を選んでください。');
  } finally {
    if (decoded) decoded.dispose();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
