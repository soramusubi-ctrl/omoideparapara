/** Shared, dependency-free album artwork and browser downloads. */
export const PAGE_WIDTH = 1240;
export const PAGE_HEIGHT = 1754;

export const THEMES = Object.freeze({
  linen: Object.freeze({ paper: '#F8F4EC', ink: '#3B443C', accent: '#7C8B74', muted: '#899184', line: '#D8D9CB', surface: '#F0EDE4', photo: '#EFECE3' }),
  sky: Object.freeze({ paper: '#F1F6F8', ink: '#374D5D', accent: '#7D9DAE', muted: '#8498A2', line: '#D3E0E5', surface: '#E8F0F4', photo: '#E7EFF3' }),
  rose: Object.freeze({ paper: '#FBF2EF', ink: '#654B4B', accent: '#B48B86', muted: '#AB918B', line: '#E7D8D2', surface: '#F4E8E3', photo: '#F3E7E1' }),
  plain: Object.freeze({ paper: '#FFFFFF', ink: '#252525', accent: '#555555', muted: '#555555', line: '#FFFFFF', surface: '#FFFFFF', photo: '#FFFFFF' }),
});

const SERIF = '"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "MS PMincho", serif';
const SANS = '"Noto Sans JP", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';
const PAGE_PT_WIDTH = 419.5276;
const PAGE_PT_HEIGHT = 595.2756;
const ENCODER = new TextEncoder();
const NO_LINE_START = /^[、。，．・：；？！ー〜～…‥）〕］｝〉》」』】〙〗〟’”ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]/u;
const NO_LINE_END = /[（〔［｛〈《「『【〘〖〝‘“]$/u;
let fontReady;

function limitedText(value, maxLength) {
  return Array.from(String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')).slice(0, maxLength).join('').trim();
}

function graphemes(value) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(value)].map(part => part.segment);
  }
  return Array.from(value);
}

/** Character wrapping includes basic Japanese line-start and line-end rules. */
function wrapText(ctx, text, maxWidth) {
  if (!text) return [];
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const char of graphemes(paragraph)) {
      if (line && ctx.measureText(line + char).width > maxWidth) {
        if (NO_LINE_START.test(char)) {
          // Reserve enough width for punctuation when selecting the font size.
          line += char;
          lines.push(line);
          line = '';
          continue;
        }
        if (NO_LINE_END.test(line)) {
          const parts = graphemes(line);
          const bracket = parts.pop();
          if (parts.length) lines.push(parts.join(''));
          line = bracket + char;
          continue;
        }
        lines.push(line.trimEnd());
        line = /^\s$/u.test(char) ? '' : char;
      } else {
        line += char;
      }
    }
    if (line) lines.push(line.trimEnd());
  }
  return lines;
}

function textLayout(ctx, text, { size, minSize, maxHeight, width, leading = 1.5, weight = 400, family = SERIF }) {
  if (!text) return { lines: [], size, lineHeight: 0, height: 0, font: `${weight} ${size}px ${family}` };
  let result;
  for (let candidate = size; candidate >= minSize; candidate -= 1) {
    const font = `${weight} ${candidate}px ${family}`;
    ctx.font = font;
    // A small inset accommodates Japanese punctuation and font-specific overhangs.
    const lines = wrapText(ctx, text, width - candidate * 1.05);
    const lineHeight = candidate * leading;
    result = { lines, size: candidate, lineHeight, height: lines.length * lineHeight, font };
    if (result.height <= maxHeight && lines.every(line => ctx.measureText(line).width <= width)) return result;
  }
  // Extreme manual line breaks still receive a complete, bounded layout.
  if (result.height > maxHeight) {
    const ratio = maxHeight / result.height;
    result.size *= ratio;
    result.lineHeight *= ratio;
    result.height = maxHeight;
    result.font = `${weight} ${result.size}px ${family}`;
  }
  return result;
}

function drawText(ctx, layout, x, y, color, alignment = 'left') {
  ctx.save();
  ctx.font = layout.font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.textAlign = alignment;
  layout.lines.forEach((line, index) => ctx.fillText(line, x, y + index * layout.lineHeight));
  ctx.restore();
}

async function waitForFonts() {
  if (typeof document === 'undefined' || !document.fonts) return;
  if (!fontReady) {
    fontReady = (async () => {
      await document.fonts.ready;
      await Promise.all([
        document.fonts.load(`500 76px ${SERIF}`, '思い出のアルバム'),
        document.fonts.load(`400 30px ${SERIF}`, '大切な日の記録'),
        document.fonts.load(`400 24px ${SANS}`, '0123456789-'),
      ]);
    })();
  }
  await fontReady;
}

async function loadImage(source, label = '写真') {
  if (typeof source !== 'string' || !source.startsWith('data:image/')) {
    throw new Error(`${label}のデータを読み込めませんでした。${label}を選び直してください。`);
  }
  return new Promise((resolve, reject) => {
    const photo = new Image();
    photo.decoding = 'async';
    photo.onload = async () => {
      if (!photo.naturalWidth || !photo.naturalHeight) {
        reject(new Error(`${label}のサイズを確認できませんでした。${label}を選び直してください。`));
        return;
      }
      // onload guarantees the resource exists; decode also waits for pixel decoding.
      if (photo.decode) {
        try { await photo.decode(); } catch { /* onload already succeeded */ }
      }
      resolve(photo);
    };
    photo.onerror = () => reject(new Error(`${label}を読み込めませんでした。${label}を選び直してください。`));
    photo.src = source;
  });
}

function line(ctx, x1, y1, x2, y2, color, width = 1.5) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function paper(ctx, theme, background, opacity) {
  ctx.fillStyle = theme.paper;
  ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  if (theme === THEMES.plain) return;
  if (background) {
    ctx.save();
    ctx.globalAlpha = opacity;
    drawPhoto(ctx, background, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT }, 'cover', theme);
    ctx.restore();
  }
  // Fine, quiet rules give the raster export a paper stationery character.
  line(ctx, 72, 72, 116, 72, theme.line);
  line(ctx, 72, 72, 72, 116, theme.line);
  line(ctx, PAGE_WIDTH - 116, PAGE_HEIGHT - 72, PAGE_WIDTH - 72, PAGE_HEIGHT - 72, theme.line);
  line(ctx, PAGE_WIDTH - 72, PAGE_HEIGHT - 116, PAGE_WIDTH - 72, PAGE_HEIGHT - 72, theme.line);
}

function textPanel(ctx, box, theme) {
  ctx.save();
  ctx.globalAlpha = 0.96;
  ctx.fillStyle = theme.paper;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.restore();
}

function emptyPhoto(ctx, box, theme) {
  ctx.save();
  ctx.fillStyle = theme.surface;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  if (theme === THEMES.plain) {
    ctx.restore();
    return;
  }
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(box.x + 0.75, box.y + 0.75, box.width - 1.5, box.height - 1.5);
  // A quiet botanical mark keeps an empty page intentional without exporting UI.
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  ctx.strokeStyle = theme.accent;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - 18, y + 48);
  ctx.bezierCurveTo(x + 5, y + 17, x + 4, y - 18, x + 15, y - 48);
  ctx.moveTo(x + 2, y + 10);
  ctx.bezierCurveTo(x - 33, y + 7, x - 34, y - 19, x - 11, y - 9);
  ctx.bezierCurveTo(x - 3, y - 5, x + 2, y + 1, x + 2, y + 10);
  ctx.moveTo(x + 8, y - 13);
  ctx.bezierCurveTo(x + 35, y - 18, x + 35, y - 43, x + 17, y - 35);
  ctx.bezierCurveTo(x + 12, y - 30, x + 9, y - 22, x + 8, y - 13);
  ctx.stroke();
  ctx.restore();
}

function drawPhoto(ctx, image, box, fit, theme) {
  if (!image) {
    emptyPhoto(ctx, box, theme);
    return;
  }
  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
  const scale = fit === 'cover'
    ? Math.max(box.width / imageWidth, box.height / imageHeight)
    : Math.min(box.width / imageWidth, box.height / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  const x = box.x + (box.width - width) / 2;
  const y = box.y + (box.height - height) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, x, y, width, height);
  ctx.restore();
}

function folio(ctx, index, theme, hasBackground = false) {
  const center = PAGE_WIDTH / 2;
  if (hasBackground) textPanel(ctx, { x: center - 76, y: 1624, width: 152, height: 88 }, theme);
  if (theme !== THEMES.plain) line(ctx, center - 56, 1640, center + 56, 1640, theme.line);
  if (index > 0) {
    ctx.save();
    ctx.font = `400 22px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = hasBackground ? theme.ink : theme.muted;
    ctx.fillText(String(index).padStart(2, '0'), center, 1662);
    ctx.restore();
  } else if (theme !== THEMES.plain) {
    ctx.save();
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.arc(center, 1667, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Render one complete, print-resolution A5 portrait page. Index 0 is the cover. */
export async function renderAlbumPage(canvas, album, index = 0) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('A canvas is required.');
  if (!album || !Array.isArray(album.pages)) throw new TypeError('A valid album is required.');
  if (!Number.isInteger(index) || index < 0 || index > album.pages.length) throw new RangeError('Album page index is out of range.');
  await waitForFonts();
  const item = index === 0 ? null : album.pages[index - 1];
  const imageSource = index === 0 ? album.coverImage : item.image;
  const backgroundOpacity = Number.isFinite(album.backgroundOpacity)
    ? Math.max(0, Math.min(1, album.backgroundOpacity)) : 0.22;
  const backgroundSource = album.theme !== 'plain' && backgroundOpacity > 0 ? album.backgroundImage : null;
  const [image, background] = await Promise.all([
    imageSource ? loadImage(imageSource) : null,
    backgroundSource ? loadImage(backgroundSource, '背景画像') : null,
  ]);
  canvas.width = PAGE_WIDTH;
  canvas.height = PAGE_HEIGHT;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('このブラウザーではアルバムを描画できません。');
  const theme = THEMES[album.theme] || THEMES.linen;
  ctx.clearRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  paper(ctx, theme, background, backgroundOpacity);

  if (index === 0) {
    const title = limitedText(album.title, 120);
    const subtitle = limitedText(album.subtitle, 180);
    const titleLayout = textLayout(ctx, title, {
      size: 76, minSize: 42, width: 996, maxHeight: 360, leading: 1.38, weight: 500,
    });
    const subtitleLayout = textLayout(ctx, subtitle, {
      size: 28, minSize: 20, width: 940, maxHeight: 180, leading: 1.65,
    });
    if (theme !== THEMES.plain) line(ctx, 572, 126, 668, 126, theme.accent, 2);
    const titleTop = 187;
    const subtitleTop = titleTop + titleLayout.height + (title && subtitle ? 28 : 0);
    if (background && (title || subtitle)) {
      textPanel(ctx, { x: 88, y: titleTop - 24, width: 1064, height: subtitleTop + subtitleLayout.height - titleTop + 48 }, theme);
    }
    drawText(ctx, titleLayout, PAGE_WIDTH / 2, titleTop, theme.ink, 'center');
    drawText(ctx, subtitleLayout, PAGE_WIDTH / 2, subtitleTop, background ? theme.ink : theme.muted, 'center');
    const photoTop = Math.max(508, subtitleTop + subtitleLayout.height + 58);
    drawPhoto(ctx, image, { x: 114, y: photoTop, width: 1012, height: 1530 - photoTop }, album.coverFit, theme);
  } else {
    const note = limitedText(item.note, 300);
    const date = limitedText(item.date, 32);
    const noteLayout = textLayout(ctx, note, {
      size: 30, minSize: 27, width: 1008, maxHeight: 490, leading: 1.65,
    });
    const dateHeight = date ? 34 : 0;
    const dateNoteGap = date && note ? 24 : 0;
    const detailsHeight = dateHeight + dateNoteGap + noteLayout.height;
    const photoBottom = detailsHeight ? 1566 - detailsHeight - 58 : 1518;
    if (theme !== THEMES.plain) line(ctx, 114, 112, 180, 112, theme.accent, 2);
    drawPhoto(ctx, image, { x: 114, y: 164, width: 1012, height: photoBottom - 164 }, item.fit, theme);
    let textTop = photoBottom + 58;
    if (background && detailsHeight) {
      textPanel(ctx, { x: 88, y: textTop - 20, width: 1064, height: detailsHeight + 40 }, theme);
    }
    if (date) {
      ctx.save();
      ctx.font = `400 23px ${SANS}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillStyle = background ? theme.ink : theme.accent;
      // Display the supplied calendar date literally; never construct a Date.
      ctx.fillText(date, 116, textTop);
      ctx.restore();
      textTop += dateHeight + dateNoteGap;
    }
    drawText(ctx, noteLayout, 116, textTop, theme.ink);
  }
  folio(ctx, index, theme, Boolean(background));
  return canvas;
}

function jpegBytes(page) {
  const bytes = page.bytes ?? page.data ?? page;
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new TypeError('Each PDF page must contain JPEG bytes.');
}

function makePdfParts(pages) {
  if (!Array.isArray(pages) || pages.length === 0) throw new TypeError('At least one JPEG page is required.');
  const chunks = [];
  const offsets = [0];
  let length = 0;
  const add = value => {
    const bytes = typeof value === 'string' ? ENCODER.encode(value) : value;
    chunks.push(bytes);
    length += bytes.byteLength;
  };
  const object = (number, content) => {
    offsets[number] = length;
    add(`${number} 0 obj\n${content}\nendobj\n`);
  };
  add(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const pageReferences = pages.map((_, index) => `${3 + index * 3} 0 R`).join(' ');
  object(2, `<< /Type /Pages /Kids [${pageReferences}] /Count ${pages.length} >>`);

  pages.forEach((page, index) => {
    const bytes = jpegBytes(page);
    if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[bytes.length - 2] !== 0xFF || bytes[bytes.length - 1] !== 0xD9) {
      throw new TypeError('A PDF page does not contain a complete JPEG image.');
    }
    const width = Math.floor(page.width ?? PAGE_WIDTH);
    const height = Math.floor(page.height ?? PAGE_HEIGHT);
    if (width <= 0 || height <= 0 || !Number.isFinite(width) || !Number.isFinite(height)) throw new TypeError('Invalid JPEG dimensions.');
    const pageObject = 3 + index * 3;
    const imageObject = pageObject + 1;
    const contentObject = pageObject + 2;
    object(pageObject, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_PT_WIDTH} ${PAGE_PT_HEIGHT}] /Resources << /XObject << /Im0 ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`);
    offsets[imageObject] = length;
    add(`${imageObject} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.byteLength} >>\nstream\n`);
    add(bytes);
    add('\nendstream\nendobj\n');
    const content = `q\n${PAGE_PT_WIDTH} 0 0 ${PAGE_PT_HEIGHT} 0 0 cm\n/Im0 Do\nQ\n`;
    object(contentObject, `<< /Length ${ENCODER.encode(content).byteLength} >>\nstream\n${content}endstream`);
  });

  const xrefOffset = length;
  const objectCount = 2 + pages.length * 3;
  add(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
  for (let index = 1; index <= objectCount; index += 1) {
    add(`${String(offsets[index]).padStart(10, '0')} 00000 n \n`);
  }
  add(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return { chunks, length };
}

/** Build a real PDF from JPEG byte arrays, useful independently of the browser. */
export function buildPdfFromJpegs(pages) {
  const { chunks, length } = makePdfParts(pages);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Keep Japanese names while removing characters disallowed in common filesystems. */
export function sanitizeFilename(value) {
  let name = String(value ?? '').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  name = graphemes(name).slice(0, 90).join('').replace(/[. ]+$/g, '');
  if (!name || name === '.' || name === '..') return '思い出アルバム';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Some browsers begin reading only after the click task finishes.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function canvasBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('画像を書き出せませんでした。もう一度お試しください。')), mimeType, quality);
  });
}

function nextFrame() {
  return new Promise(resolve => {
    // A timer keeps exports progressing when the tab is in the background.
    setTimeout(resolve, 0);
  });
}

export async function downloadPng(album, index = 0) {
  const canvas = document.createElement('canvas');
  try {
    await renderAlbumPage(canvas, album, index);
    const blob = await canvasBlob(canvas, 'image/png');
    downloadBlob(blob, `${sanitizeFilename(album.title)}-${String(index + 1).padStart(2, '0')}.png`);
    return blob;
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

export async function downloadPdf(album, { onProgress } = {}) {
  if (!album || !Array.isArray(album.pages)) throw new TypeError('A valid album is required.');
  const canvas = document.createElement('canvas');
  const pages = [];
  const total = album.pages.length + 1;
  try {
    // Only one full-size raster canvas is retained at a time.
    for (let index = 0; index < total; index += 1) {
      await renderAlbumPage(canvas, album, index);
      const blob = await canvasBlob(canvas, 'image/jpeg', 0.95);
      pages.push({ bytes: new Uint8Array(await blob.arrayBuffer()), width: PAGE_WIDTH, height: PAGE_HEIGHT });
      if (typeof onProgress === 'function') onProgress({ current: index + 1, total });
      await nextFrame();
    }
    const { chunks } = makePdfParts(pages);
    const pdf = new Blob(chunks, { type: 'application/pdf' });
    downloadBlob(pdf, `${sanitizeFilename(album.title)}.pdf`);
    return pdf;
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}
