import { validateAlbum } from './storage.js';
import { MAX_PROJECT_BYTES, assertProjectBudget } from './album-limits.js';

const KEEP_FILE = '元のファイルは削除・上書きせず、そのまま保管してください。';
const CHOOSE_DATA = '「保存する」→「編集データを保存」で書き出した .album.json を選んでください。';
const IMAGE_ERROR = 'PNG・JPEGなどの画像からアルバムの編集内容は復元できません。写真として追加するか、編集データ（.album.json）を開いてください。';
const PDF_ERROR = 'PDFは閲覧・印刷用のため、アルバムの編集内容を復元できません。編集データ（.album.json）を開いてください。';
const MAX_IMAGE_PIXELS = 160000000;

function binaryKind(bytes) {
  const starts = (...signature) => signature.every((value, index) => bytes[index] === value);
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (starts(137, 80, 78, 71, 13, 10, 26, 10) || starts(255, 216, 255)
    || /^GIF8[79]a$/.test(ascii(0, 6))
    || (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')
    || (ascii(4, 8) === 'ftyp' && /^(avif|avis|heic|heix|mif1)$/.test(ascii(8, 12)))) return 'image';
  return null;
}

function mistakenFormat(file, text = '') {
  const name = typeof file.name === 'string' ? file.name : '';
  const type = typeof file.type === 'string' ? file.type.toLowerCase() : '';
  if (text.trimStart().startsWith('%PDF-') || /\.pdf$/i.test(name) || type === 'application/pdf') return PDF_ERROR;
  if (/^[\u0089\ufffd]PNG/.test(text) || /\.(png|jpe?g|webp|gif|avif|heic|heif|svg)$/i.test(name) || type.startsWith('image/')) return IMAGE_ERROR;
  return null;
}

/** Read one editable backup. Nothing in this module writes to browser storage. */
export async function readAlbumFile(file) {
  if (!file || typeof file.text !== 'function' || !Number.isSafeInteger(file.size) || file.size < 0) {
    throw new Error('アルバムの編集データ（.album.json）のファイルを選んでください。');
  }
  if (file.size > MAX_PROJECT_BYTES) throw new Error(`編集データは200MiB以内のファイルを選んでください。${KEEP_FILE}`);
  if (file.size === 0) throw new Error(`選んだファイルは空です。${KEEP_FILE}${CHOOSE_DATA}`);

  // Real File objects can identify binary exports without reading their entire body.
  let kind;
  let text;
  try {
    if (typeof file.slice === 'function') {
      const header = file.slice(0, 16);
      if (typeof header?.arrayBuffer === 'function') kind = binaryKind(new Uint8Array(await header.arrayBuffer()));
    }
    if (!kind) text = await file.text();
  } catch (error) {
    throw new Error(`ファイルを読み込めませんでした。端末へダウンロードしてから、もう一度選んでください。${KEEP_FILE}`, { cause: error });
  }
  if (kind) throw new Error(kind === 'pdf' ? PDF_ERROR : IMAGE_ERROR);
  if (typeof text !== 'string') throw new Error(`編集データを文字として読み込めませんでした。${KEEP_FILE}${CHOOSE_DATA}`);
  text = text.replace(/^\uFEFF/, '');
  let candidate;
  try {
    candidate = JSON.parse(text);
  } catch (error) {
    throw new Error(mistakenFormat(file, text) || `編集データのJSONを読み取れませんでした。${KEEP_FILE}${CHOOSE_DATA}`, { cause: error });
  }
  try {
    const album = validateAlbum(candidate);
    assertProjectBudget(album);
    return album;
  } catch (error) {
    throw new Error(`編集データを復元できませんでした。${error.message}${KEEP_FILE}`, { cause: error });
  }
}

async function decodeImage(source) {
  let image;
  try {
    image = new globalThis.Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = async () => {
        try {
          const width = image.naturalWidth;
          const height = image.naturalHeight;
          if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS) {
            throw new Error('編集データの画像サイズを確認してください。');
          }
          if (typeof image.decode === 'function') await image.decode();
          resolve();
        } catch (error) { reject(error); }
      };
      image.onerror = () => reject(new Error('画像の読み込みに失敗しました。'));
      image.src = source;
    });
  } catch (error) {
    throw new Error(`編集データに読み込めない画像が含まれています。${error?.message || '画像を確認できませんでした。'}${KEEP_FILE}元の編集データを選び直してください。`, { cause: error });
  } finally {
    if (image) {
      image.onload = null;
      image.onerror = null;
      try {
        if (typeof image.removeAttribute === 'function') image.removeAttribute('src');
        else image.src = '';
      } catch { /* Release failure must not mask the import result. */ }
    }
  }
}

/** Decode every distinct stored image before either editor or shelf replaces data. */
export async function decodeAlbumImages(album, { onProgress } = {}) {
  const candidate = validateAlbum(album);
  const images = [...new Set([candidate.coverImage, candidate.backgroundImage, ...candidate.pages.map(page => page.image)].filter(Boolean))];
  onProgress?.({ current: 0, total: images.length });
  if (images.length && typeof globalThis.Image !== 'function') {
    throw new Error('この環境では写真の読み込みを確認できません。対応するブラウザーで編集データを開いてください。');
  }
  for (let index = 0; index < images.length; index += 1) {
    await decodeImage(images[index]);
    onProgress?.({ current: index + 1, total: images.length });
  }
}
