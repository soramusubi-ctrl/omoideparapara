import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PAGE_WIDTH, PAGE_HEIGHT, THEMES, renderAlbumPage, buildPdfFromJpegs, sanitizeFilename, downloadPdf, downloadPng } from '../dist/album-renderer.js';
import { FONT_OPTIONS, getAlbumFont } from '../dist/album-fonts.js';

const require = createRequire(import.meta.url);
let canvasModule;
try {
  canvasModule = require('@napi-rs/canvas');
} catch { /* Pure PDF and filename checks still run without optional native canvas. */ }

// Native QA hosts may lack Japanese faces; use distinct installed Latin faces
// to verify that switching the selected family changes actual raster output.
if (canvasModule) {
  const fonts = canvasModule.GlobalFonts;
  if (!fonts.has('Noto Serif JP')) fonts.setAlias('DejaVu Serif', 'Noto Serif JP');
  if (!fonts.has('Noto Sans JP')) fonts.setAlias('DejaVu Sans', 'Noto Sans JP');
  assert.ok(fonts.registerFromPath(fileURLToPath(new URL('../dist/fonts/mplus-rounded-1c-regular.woff2', import.meta.url)), 'Album Rounded'), 'The actual bundled rounded font must load in native QA.');
}

const album = {
  title: 'あの日の小さな思い出', subtitle: 'ずっと大切にしたい、家族の記録。', theme: 'linen', coverImage: null,
  coverFit: 'contain', pages: [{ image: null, date: '2026-10-15', note: 'いつもの時間が、宝物になりました。', fit: 'contain' }],
};

function instrumentedCanvas() {
  const canvas = canvasModule.createCanvas(1, 1);
  const base = canvas.getContext('2d');
  const text = [];
  const images = [];
  const fills = [];
  const measurements = [];
  const proxy = new Proxy(base, {
    get(target, property) {
      if (property === 'fillText') return (value, x, y) => {
        text.push({ value, x, y, font: target.font, width: target.measureText(value).width, align: target.textAlign, color: target.fillStyle });
        return target.fillText(value, x, y);
      };
      if (property === 'drawImage') return (...args) => {
        images.push({ args, alpha: target.globalAlpha });
        return target.drawImage(...args);
      };
      if (property === 'fillRect') return (...args) => {
        fills.push({ args, alpha: target.globalAlpha, color: target.fillStyle });
        return target.fillRect(...args);
      };
      if (property === 'measureText') return value => {
        measurements.push({ value, font: target.font });
        return target.measureText(value);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) { return Reflect.set(target, property, value, target); },
  });
  canvas.getContext = () => proxy;
  return { canvas, text, images, fills, measurements };
}

function solidImage(color, width = 10, height = 10) {
  const canvas = canvasModule.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return canvas.toDataURL('image/png');
}

function rgbAt(canvas, x, y) {
  return [...canvas.getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3);
}

test('Japanese filenames remain readable and unsafe path characters are removed', () => {
  assert.equal(sanitizeFilename('秋の / おもいで?.'), '秋の おもいで');
  assert.equal(sanitizeFilename('../'), '思い出アルバム');
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename(''), '思い出アルバム');
});

test('PDF has byte-accurate offsets, stream lengths and one image per A5 page', async () => {
  const jpeg = canvasModule
    ? new Uint8Array(canvasModule.createCanvas(2, 3).toBuffer('image/jpeg'))
    : new Uint8Array([255, 216, 255, 217]);
  const pdf = buildPdfFromJpegs(Array.from({ length: 3 }, () => ({ bytes: jpeg, width: 2, height: 3 })));
  const binary = Buffer.from(pdf).toString('latin1');
  assert.ok(binary.startsWith('%PDF-1.4'));
  assert.match(binary, /\/Count 3/);
  assert.equal((binary.match(/\/MediaBox \[0 0 419\.5276 595\.2756\]/g) || []).length, 3);
  const startxref = Number(binary.match(/startxref\n(\d+)/)[1]);
  assert.equal(binary.slice(startxref, startxref + 4), 'xref');
  const xref = binary.slice(startxref).split('\n');
  for (let id = 1; id <= 11; id += 1) {
    const offset = Number(xref[id + 2].slice(0, 10));
    assert.ok(binary.slice(offset).startsWith(`${id} 0 obj\n`));
  }
  for (const match of binary.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
    const begin = match.index + match[0].length;
    const length = Number(match[1]);
    assert.ok(binary.slice(begin + length).startsWith('\nendstream') || binary.slice(begin + length).startsWith('endstream'));
  }
  assert.throws(() => buildPdfFromJpegs([]));
  assert.throws(() => buildPdfFromJpegs([{ bytes: new Uint8Array([1, 2]) }]));
  if (process.env.ALBUM_RENDERER_QA_DIR && canvasModule) {
    await mkdir(process.env.ALBUM_RENDERER_QA_DIR, { recursive: true });
    await writeFile(`${process.env.ALBUM_RENDERER_QA_DIR}/fixture.pdf`, pdf);
  }
});

test('full-length Japanese copy fits the artboard and literal dates survive rendering', { skip: !canvasModule }, async () => {
  globalThis.Image = canvasModule.Image;
  const longAlbum = {
    ...album,
    title: '春夏秋冬、家族と過ごした大切な時間。'.repeat(8).slice(0, 120),
    subtitle: '何気ない毎日のなかにある、かけがえのない思い出を残して。'.repeat(8).slice(0, 180),
    pages: [{ image: null, fit: 'contain', date: '2026-01-01', note: 'お散歩の途中で見つけた花。みんなの笑顔が、いつまでも心に残っています。'.repeat(12).slice(0, 300) }],
  };
  for (const font of ['serif', 'sans', 'rounded']) for (const index of [0, 1]) {
    const { canvas, text } = instrumentedCanvas();
    await renderAlbumPage(canvas, { ...longAlbum, font }, index);
    assert.equal(canvas.width, PAGE_WIDTH);
    assert.equal(canvas.height, PAGE_HEIGHT);
    for (const item of text) {
      const fontSize = Number(item.font.match(/([\d.]+)px/)[1]);
      const left = item.align === 'center' ? item.x - item.width / 2 : item.x;
      const right = item.align === 'center' ? item.x + item.width / 2 : item.x + item.width;
      assert.ok(left >= 70, `Text starts outside the margin: ${left}`);
      assert.ok(right <= PAGE_WIDTH - 70, `Text ends outside the margin: ${right}`);
      assert.ok(item.y + fontSize < PAGE_HEIGHT - 60, `Text overflows bottom: ${item.y + fontSize}`);
    }
    if (index === 1) assert.ok(text.some(item => item.value === '2026-01-01'));
    if (process.env.ALBUM_RENDERER_QA_DIR) {
      await mkdir(process.env.ALBUM_RENDERER_QA_DIR, { recursive: true });
      await writeFile(`${process.env.ALBUM_RENDERER_QA_DIR}/${font}-${index ? 'long-note' : 'cover'}.png`, canvas.toBuffer('image/png'));
    }
  }
  const { canvas } = instrumentedCanvas();
  await assert.rejects(renderAlbumPage(canvas, album, 2), RangeError);
});

test('contain preserves landscape illustration edges; cover is explicitly opt-in', { skip: !canvasModule }, async () => {
  globalThis.Image = canvasModule.Image;
  const source = canvasModule.createCanvas(400, 200);
  const sourceCtx = source.getContext('2d');
  sourceCtx.fillStyle = '#e5b25d'; sourceCtx.fillRect(0, 0, 400, 200);
  sourceCtx.fillStyle = '#ff0000'; sourceCtx.fillRect(0, 0, 40, 200);
  sourceCtx.fillStyle = '#0000ff'; sourceCtx.fillRect(360, 0, 40, 200);
  const data = source.toDataURL('image/png');
  for (const fit of ['contain', 'cover']) {
    const canvas = canvasModule.createCanvas(1, 1);
    await renderAlbumPage(canvas, { ...album, pages: [{ image: data, note: '', date: '', fit }] }, 1);
    const ctx = canvas.getContext('2d');
    const left = [...ctx.getImageData(120, 840, 1, 1).data].slice(0, 3);
    const right = [...ctx.getImageData(1120, 840, 1, 1).data].slice(0, 3);
    if (fit === 'contain') {
      assert.deepEqual(left, [255, 0, 0]);
      assert.deepEqual(right, [0, 0, 255]);
    } else {
      assert.deepEqual(left, [229, 178, 93]);
      assert.deepEqual(right, [229, 178, 93]);
    }
  }
});

test('absent, null and zero-opacity backgrounds preserve the original pixels on every page', { skip: !canvasModule }, async () => {
  globalThis.Image = canvasModule.Image;
  for (const index of [0, 1]) {
    const original = canvasModule.createCanvas(1, 1);
    await renderAlbumPage(original, album, index);
    const baseline = original.toBuffer('image/png');
    for (const additions of [
      { backgroundImage: null },
      { backgroundImage: 'invalid and deliberately never loaded', backgroundOpacity: 0 },
      { backgroundImage: 'invalid and deliberately never loaded', backgroundOpacity: -1 },
    ]) {
      const canvas = canvasModule.createCanvas(1, 1);
      await renderAlbumPage(canvas, { ...album, ...additions }, index);
      assert.deepEqual(canvas.toBuffer('image/png'), baseline);
    }
  }
});

test('backgrounds fill the whole page with centered cover cropping on cover and interior', { skip: !canvasModule }, async () => {
  globalThis.Image = canvasModule.Image;
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff'];
  for (const portrait of [false, true]) {
    const background = canvasModule.createCanvas(portrait ? 100 : 500, portrait ? 500 : 100);
    const ctx = background.getContext('2d');
    colors.forEach((color, index) => {
      ctx.fillStyle = color;
      ctx.fillRect(portrait ? 0 : index * 100, portrait ? index * 100 : 0, 100, 100);
    });
    for (const index of [0, 1]) {
      const { canvas, images } = instrumentedCanvas();
      await renderAlbumPage(canvas, { ...album, backgroundImage: background.toDataURL(), backgroundOpacity: 1 }, index);
      const top = portrait ? [0, 255, 0] : [0, 0, 255];
      const bottom = portrait ? [255, 255, 0] : [0, 0, 255];
      assert.deepEqual(rgbAt(canvas, 2, 2), top);
      assert.deepEqual(rgbAt(canvas, PAGE_WIDTH - 3, 2), top);
      assert.deepEqual(rgbAt(canvas, 2, PAGE_HEIGHT - 3), bottom);
      assert.deepEqual(rgbAt(canvas, PAGE_WIDTH - 3, PAGE_HEIGHT - 3), bottom);
      const [, x, y, width, height] = images[0].args;
      assert.ok(Math.abs(x + width / 2 - PAGE_WIDTH / 2) < 0.001);
      assert.ok(Math.abs(y + height / 2 - PAGE_HEIGHT / 2) < 0.001);
      assert.ok(width >= PAGE_WIDTH && height >= PAGE_HEIGHT);
    }
  }
});

test('background opacity defaults, clamps and does not leak into foreground photo geometry', { skip: !canvasModule }, async () => {
  globalThis.Image = canvasModule.Image;
  const backgroundImage = solidImage('#000000');
  const photo = solidImage('#f36b48', 100, 200);
  const withPhotos = { ...album, coverImage: photo, pages: [{ ...album.pages[0], image: photo }] };
  for (const index of [0, 1]) {
    const original = instrumentedCanvas();
    await renderAlbumPage(original.canvas, withPhotos, index);
    for (const [backgroundOpacity, expectedOpacity] of [[undefined, 0.22], [NaN, 0.22], [0.5, 0.5], [2, 1]]) {
      const result = instrumentedCanvas();
      await renderAlbumPage(result.canvas, { ...withPhotos, backgroundImage, backgroundOpacity }, index);
      const paper = [248, 244, 236];
      const corner = rgbAt(result.canvas, 2, 2);
      corner.forEach((value, channel) => assert.ok(Math.abs(value - paper[channel] * (1 - expectedOpacity)) <= 1.5));
      assert.deepEqual(result.images[1].args.slice(1), original.images[0].args.slice(1));
      assert.equal(result.images[1].alpha, 1);
      assert.deepEqual(result.text.map(({ value, x, y, font }) => ({ value, x, y, font })), original.text.map(({ value, x, y, font }) => ({ value, x, y, font })));
      const [, x, y, width, height] = result.images[1].args;
      assert.deepEqual(rgbAt(result.canvas, Math.floor(x + width / 2), Math.floor(y + height / 2)), [243, 107, 72]);
    }
  }
});

test('opaque busy backgrounds keep all cover and page text on padded, high-contrast paper', { skip: !canvasModule }, async () => {
  globalThis.Image = canvasModule.Image;
  const background = canvasModule.createCanvas(200, 200);
  const ctx = background.getContext('2d');
  for (let x = 0; x < 200; x += 10) for (let y = 0; y < 200; y += 10) {
    ctx.fillStyle = (x + y) % 20 ? '#ffffff' : '#000000';
    ctx.fillRect(x, y, 10, 10);
  }
  const longAlbum = {
    ...album, backgroundImage: background.toDataURL(), backgroundOpacity: 1,
    title: 'Family memories '.repeat(9).slice(0, 120),
    subtitle: 'Little moments to treasure together. '.repeat(6).slice(0, 180),
    pages: [{ ...album.pages[0], note: 'A little note about this special day. '.repeat(9).slice(0, 300) }],
  };
  const luminance = rgb => rgb.map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((total, value, i) => total + value * [0.2126, 0.7152, 0.0722][i], 0);
  for (const theme of Object.keys(THEMES).filter(theme => theme !== 'plain')) for (const index of [0, 1]) {
    const result = instrumentedCanvas();
    await renderAlbumPage(result.canvas, { ...longAlbum, theme }, index);
    const panels = result.fills.filter(fill => Math.abs(fill.alpha - 0.96) < 0.005);
    for (const text of result.text) {
      const fontSize = Number(text.font.match(/([\d.]+)px/)[1]);
      const left = text.align === 'center' ? text.x - text.width / 2 : text.x;
      const right = text.align === 'center' ? text.x + text.width / 2 : text.x + text.width;
      const panel = panels.find(({ args: [x, y, width, height] }) => x < left && x + width > right && y < text.y && y + height > text.y + fontSize);
      assert.ok(panel, `Unprotected ${theme} page ${index} text: ${text.value}`);
      assert.equal(text.color.toLowerCase(), THEMES[theme].ink.toLowerCase());
      const [x, y] = panel.args;
      const panelColor = rgbAt(result.canvas, x + 3, y + 3);
      const inkColor = THEMES[theme].ink.match(/[a-f\d]{2}/gi).map(value => Number.parseInt(value, 16));
      assert.ok((luminance(panelColor) + 0.05) / (luminance(inkColor) + 0.05) > 4.5);
    }
    if (process.env.ALBUM_RENDERER_QA_DIR) {
      await mkdir(process.env.ALBUM_RENDERER_QA_DIR, { recursive: true });
      await writeFile(`${process.env.ALBUM_RENDERER_QA_DIR}/background-${theme}-${index}.png`, result.canvas.toBuffer('image/png'));
    }
  }
});

test('plain pages stay pure white and never decode stored background images', { skip: !canvasModule }, async () => {
  const nativeImage = canvasModule.Image;
  const vividBackground = solidImage('#ef098f');
  let imageCreations = 0;
  globalThis.Image = class {
    constructor() {
      imageCreations += 1;
      throw new Error('Plain pages must not decode their stored background.');
    }
  };
  try {
    const blankAlbum = {
      ...album, theme: 'plain', title: '', subtitle: '', coverImage: null, backgroundOpacity: 1,
      pages: [{ image: null, date: '', note: '', fit: 'contain' }],
    };
    for (const backgroundImage of [null, vividBackground, 'data:image/png;base64,broken-background']) {
      for (const index of [0, 1]) {
        const { canvas, text, images, fills } = instrumentedCanvas();
        await renderAlbumPage(canvas, { ...blankAlbum, backgroundImage }, index);
        assert.equal(images.length, 0);
        assert.ok(fills.every(fill => fill.color.toLowerCase() === '#ffffff' && fill.alpha === 1));
        assert.deepEqual(text.map(item => item.value), index ? ['01'] : []);
        const pixels = canvas.getContext('2d').getImageData(0, 0, PAGE_WIDTH, PAGE_HEIGHT).data;
        let numberPixels = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          const x = (offset / 4) % PAGE_WIDTH;
          const y = Math.floor(offset / 4 / PAGE_WIDTH);
          const white = pixels[offset] === 255 && pixels[offset + 1] === 255 && pixels[offset + 2] === 255 && pixels[offset + 3] === 255;
          if (index && x >= 580 && x <= 660 && y >= 1660 && y <= 1708) {
            if (!white) numberPixels += 1;
          } else if (!white) {
            assert.fail(`Non-white unused pixel on plain page ${index}: ${x},${y}`);
          }
        }
        if (index) assert.ok(numberPixels > 0, 'The page number must remain visible.');
      }
    }
    assert.equal(imageCreations, 0);
  } finally {
    globalThis.Image = nativeImage;
  }
});

test('plain retains photo and text layout, and switching back restores the stored background', { skip: !canvasModule }, async () => {
  globalThis.Image = canvasModule.Image;
  const photo = solidImage('#2a83c8', 100, 200);
  const backgroundImage = solidImage('#ef098f');
  const savedAlbum = {
    ...album, title: 'Our memories', subtitle: 'Together forever', coverImage: photo,
    backgroundImage, backgroundOpacity: 1,
    pages: [{ image: photo, date: '2026-10-16', note: 'A special little day', fit: 'contain' }],
  };
  for (const index of [0, 1]) {
    const original = instrumentedCanvas();
    await renderAlbumPage(original.canvas, { ...savedAlbum, backgroundImage: null }, index);
    const plain = instrumentedCanvas();
    await renderAlbumPage(plain.canvas, { ...savedAlbum, theme: 'plain' }, index);
    assert.equal(plain.images.length, 1);
    assert.deepEqual(plain.images[0].args.slice(1), original.images[0].args.slice(1));
    assert.deepEqual(plain.text.map(({ value, x, y, font }) => ({ value, x, y, font })), original.text.map(({ value, x, y, font }) => ({ value, x, y, font })));
    assert.deepEqual(rgbAt(plain.canvas, 2, 2), [255, 255, 255]);
    const [, x, y, width, height] = plain.images[0].args;
    assert.deepEqual(rgbAt(plain.canvas, Math.floor(x + width / 2), Math.floor(y + height / 2)), [42, 131, 200]);
    for (const text of plain.text) {
      const fontSize = Number(text.font.match(/([\d.]+)px/)[1]);
      const left = text.align === 'center' ? text.x - text.width / 2 : text.x;
      const pixels = plain.canvas.getContext('2d').getImageData(Math.floor(left), Math.floor(text.y), Math.ceil(text.width + 1), Math.ceil(fontSize * 1.5)).data;
      assert.ok(pixels.some((value, offset) => offset % 4 !== 3 && value < 200), `Missing visible plain text: ${text.value}`);
    }
    const switchedBack = instrumentedCanvas();
    await renderAlbumPage(switchedBack.canvas, savedAlbum, index);
    assert.equal(switchedBack.images.length, 2);
    assert.deepEqual(rgbAt(switchedBack.canvas, 2, 2), [239, 9, 143]);
    assert.equal(savedAlbum.backgroundImage, backgroundImage);
    if (process.env.ALBUM_RENDERER_QA_DIR) {
      await mkdir(process.env.ALBUM_RENDERER_QA_DIR, { recursive: true });
      await writeFile(`${process.env.ALBUM_RENDERER_QA_DIR}/plain-${index}.png`, plain.canvas.toBuffer('image/png'));
    }
  }
});

test('font choices reach every text role, change output, and preserve the default family', { skip: !canvasModule }, async () => {
  globalThis.Image = canvasModule.Image;
  const shortAlbum = {
    ...album, title: 'Our family memories', subtitle: 'Little moments together',
    pages: [{ image: null, date: '2026-10-16', note: 'A special little day', fit: 'contain' }],
  };
  const outputs = new Map();
  for (const { value } of FONT_OPTIONS) {
    for (const index of [0, 1]) {
      const { canvas, text } = instrumentedCanvas();
      await renderAlbumPage(canvas, { ...shortAlbum, font: value }, index);
      assert.ok(text.length >= 2);
      for (const item of text) assert.ok(item.font.endsWith(getAlbumFont(value)), `${value}: ${item.font}`);
      outputs.set(`${value}-${index}`, canvas.toBuffer('image/png'));
      if (index === 1) assert.deepEqual(text.map(item => item.value), ['2026-10-16', 'A special little day', '01']);
    }
  }
  assert.notDeepEqual(outputs.get('serif-0'), outputs.get('sans-0'));
  assert.notDeepEqual(outputs.get('rounded-0'), outputs.get('serif-0'));
  assert.notDeepEqual(outputs.get('rounded-0'), outputs.get('sans-0'));
  for (const font of [undefined, 'unknown']) {
    const { canvas } = instrumentedCanvas();
    await renderAlbumPage(canvas, { ...shortAlbum, font }, 0);
    assert.deepEqual(canvas.toBuffer('image/png'), outputs.get('serif-0'));
  }
});

test('font readiness is awaited, cached per family, and extended for newly edited glyphs', { skip: !canvasModule }, async () => {
  globalThis.Image = canvasModule.Image;
  const previousDocument = globalThis.document;
  let resolveReady;
  const loads = [];
  const pendingLoads = [];
  globalThis.document = {
    fonts: {
      ready: new Promise(resolve => { resolveReady = resolve; }),
      load(specification, sample) {
        loads.push({ specification, sample });
        return new Promise(resolve => pendingLoads.push(resolve));
      },
    },
  };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const releaseLoads = () => pendingLoads.splice(0).forEach(resolve => resolve([]));
  const requestedAlbum = { ...album, title: '家族', subtitle: '記録', font: 'serif', pages: [{ ...album.pages[0], note: '花', date: '' }] };
  try {
    const first = instrumentedCanvas();
    const pending = renderAlbumPage(first.canvas, requestedAlbum, 0);
    await tick();
    assert.equal(loads.length, 0);
    assert.equal(first.measurements.length, 0);
    resolveReady();
    await tick();
    assert.equal(loads.length, 3);
    assert.ok(loads.every(load => load.specification.endsWith(getAlbumFont('serif'))));
    assert.ok(loads.every(load => [...'家族記録花0123456789-'].every(character => load.sample.includes(character))));
    assert.equal(first.measurements.length, 0);
    // A render uses the same text/font snapshot even if editing continues while loading.
    requestedAlbum.title = '桜';
    requestedAlbum.font = 'rounded';
    releaseLoads();
    await pending;
    assert.ok(first.text.some(item => item.value === '家族'));
    assert.ok(first.text.every(item => item.font.endsWith(getAlbumFont('serif'))));
    const serifAlbum = { ...requestedAlbum, title: '家族', font: 'serif' };
    await renderAlbumPage(instrumentedCanvas().canvas, serifAlbum, 1);
    assert.equal(loads.length, 3);

    const sans = instrumentedCanvas();
    const sansPending = renderAlbumPage(sans.canvas, { ...serifAlbum, font: 'sans' }, 1);
    await tick();
    assert.equal(loads.length, 6);
    assert.ok(loads.slice(3).every(load => load.specification.endsWith(getAlbumFont('sans'))));
    assert.equal(sans.measurements.length, 0);
    releaseLoads();
    await sansPending;
    await renderAlbumPage(instrumentedCanvas().canvas, serifAlbum, 0);
    assert.equal(loads.length, 6);

    const edited = instrumentedCanvas();
    const editPending = renderAlbumPage(edited.canvas, { ...serifAlbum, title: '桜' }, 0);
    await tick();
    assert.equal(loads.length, 9);
    assert.ok(loads.slice(6).every(load => load.sample === '桜'));
    assert.equal(edited.measurements.length, 0);
    releaseLoads();
    await editPending;
  } finally {
    releaseLoads();
    globalThis.document = previousDocument;
  }
});

test('a failed font load can be retried', { skip: !canvasModule }, async () => {
  globalThis.Image = canvasModule.Image;
  const previousDocument = globalThis.document;
  let fail = true;
  let calls = 0;
  globalThis.document = { fonts: { ready: Promise.resolve(), load() { calls += 1; return fail ? Promise.reject(new Error('font unavailable')) : Promise.resolve([]); } } };
  try {
    await assert.rejects(renderAlbumPage(instrumentedCanvas().canvas, { ...album, font: 'rounded' }, 0), /font unavailable/);
    fail = false;
    await renderAlbumPage(instrumentedCanvas().canvas, { ...album, font: 'rounded' }, 0);
    assert.equal(calls, 6);
  } finally {
    globalThis.document = previousDocument;
  }
});


test('browser download APIs produce actual PNG and all album pages in a PDF', { skip: !canvasModule }, async () => {
  globalThis.Image = canvasModule.Image;
  const downloads = [];
  const revoked = [];
  const nativeSetTimeout = globalThis.setTimeout;
  const previousDocument = globalThis.document;
  const previousURL = globalThis.URL;
  const exportCanvases = [];
  const fontLoads = [];
  globalThis.document = {
    fonts: { ready: Promise.resolve(), load: async specification => { fontLoads.push(specification); return []; } },
    body: { appendChild() {} },
    createElement(tag) {
      if (tag === 'canvas') {
        const record = instrumentedCanvas();
        exportCanvases.push(record);
        return record.canvas;
      }
      if (tag === 'a') return {
        style: {}, href: '', download: '',
        click() { downloads.push(this.download); }, remove() {},
      };
      throw new Error(`Unexpected element ${tag}`);
    },
  };
  globalThis.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: value => revoked.push(value) };
  globalThis.setTimeout = (callback, delay) => nativeSetTimeout(callback, delay === 30000 ? 0 : delay);
  try {
    const exportAlbum = { ...album, font: 'rounded', theme: 'plain', backgroundImage: 'data:image/png;base64,broken-background', backgroundOpacity: 1 };
    const progress = [];
    const png = await downloadPng(exportAlbum, 1);
    assert.equal(png.type, 'image/png');
    assert.deepEqual([...new Uint8Array(await png.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const exportedPng = await canvasModule.loadImage(Buffer.from(await png.arrayBuffer()));
    const pngCanvas = canvasModule.createCanvas(PAGE_WIDTH, PAGE_HEIGHT);
    pngCanvas.getContext('2d').drawImage(exportedPng, 0, 0);
    assert.deepEqual(rgbAt(pngCanvas, 2, 2), [255, 255, 255]);
    assert.deepEqual(rgbAt(pngCanvas, 620, 800), [255, 255, 255]);
    const pdf = await downloadPdf({ ...exportAlbum, pages: [...album.pages, { image: null, note: '', date: '' }] }, { onProgress: page => progress.push(page) });
    assert.equal(pdf.type, 'application/pdf');
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    const pdfBinary = pdfBytes.toString('latin1');
    assert.match(pdfBinary, /\/Count 3/);
    let exportedImages = 0;
    for (const match of pdfBinary.matchAll(/\/Subtype \/Image [\s\S]*?\/Length (\d+) >>\nstream\n/g)) {
      const start = match.index + match[0].length;
      const jpeg = await canvasModule.loadImage(pdfBytes.subarray(start, start + Number(match[1])));
      const page = canvasModule.createCanvas(PAGE_WIDTH, PAGE_HEIGHT);
      page.getContext('2d').drawImage(jpeg, 0, 0);
      assert.deepEqual(rgbAt(page, 2, 2), [255, 255, 255]);
      assert.deepEqual(rgbAt(page, 620, 800), [255, 255, 255]);
      exportedImages += 1;
    }
    assert.equal(exportedImages, 3);
    assert.equal(exportCanvases.length, 2);
    assert.ok(exportCanvases.every(record => record.text.length > 0 && record.text.every(text => text.font.endsWith(getAlbumFont('rounded')))));
    assert.equal(fontLoads.length, 3);
    assert.ok(fontLoads.every(specification => specification.endsWith(getAlbumFont('rounded'))));
    assert.deepEqual(progress, [{ current: 1, total: 3 }, { current: 2, total: 3 }, { current: 3, total: 3 }]);
    assert.deepEqual(downloads, ['あの日の小さな思い出-02.png', 'あの日の小さな思い出.pdf']);
  } finally {
    globalThis.document = previousDocument;
    globalThis.URL = previousURL;
    globalThis.setTimeout = nativeSetTimeout;
  }
});
