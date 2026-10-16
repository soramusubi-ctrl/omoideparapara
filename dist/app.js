import { createAlbum, makeId, loadDraft, saveDraft, validateAlbum, serializeAlbum, fileToImage } from './storage.js';
import { PAGE_WIDTH, PAGE_HEIGHT, renderAlbumPage, downloadPdf, downloadPng, downloadBlob, sanitizeFilename } from './album-renderer.js';
import { MAX_PROJECT_BYTES, assertProjectBudget } from './album-limits.js';
import { FONT_OPTIONS } from './album-fonts.js';

const FRAME_OPTIONS = Object.freeze([
  { value: 'none', label: '枠なし' },
  { value: 'white', label: '白ふち' },
  { value: 'polaroid', label: 'ポラロイド風' },
  { value: 'rounded', label: '角丸' }
]);

const $ = (selector) => document.querySelector(selector);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const LIMIT = 100;
let album = createAlbum();
let selected = 0;
let busy = false;
let ready = false;
let revision = 0;
let savedRevision = 0;
let saveTimer;
let previewTimer;
let previewGeneration = 0;
let toastTimer;
let saveQueue = Promise.resolve();
let lastUndo = null;
let dragDepth = 0;
let lastSaveError = '';

function snapshot() { return { ...album, pages: album.pages.map((page) => ({ ...page })) }; }
function selectedPage() { return selected === 0 ? null : album.pages[selected - 1]; }
function hasContent() { return Boolean(album.coverImage || album.backgroundImage || album.pages.length || album.subtitle || (album.title && album.title !== '思い出のアルバム')); }
function pageName(index = selected) { return index === 0 ? '表紙' : `写真ページ ${String(index).padStart(2, '0')}`; }

function toast(message, undo = false) {
  clearTimeout(toastTimer);
  $('#toast-message').textContent = message;
  $('#undo-button').hidden = !undo;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, undo ? 10000 : 6000);
}

function setStatus(state, text) {
  const status = $('#save-status');
  status.dataset.state = state;
  status.lastElementChild.textContent = text;
  status.title = text;
  $('#save-warning').hidden = state !== 'error';
}

async function persist() {
  clearTimeout(saveTimer);
  const targetRevision = revision;
  const savedCopy = snapshot();
  setStatus('saving', '端末に保存しています');
  const operation = saveQueue.catch(() => {}).then(() => saveDraft(savedCopy));
  saveQueue = operation;
  try {
    await operation;
    savedRevision = Math.max(savedRevision, targetRevision);
    lastSaveError = '';
    if (targetRevision === revision) setStatus('saved', 'この端末に保存済み');
  } catch (error) {
    if (targetRevision !== revision) return;
    setStatus('error', '自動保存できません');
    if (lastSaveError !== error.message) toast(error.message || '端末に保存できません。編集データを書き出して保管してください。');
    lastSaveError = error.message;
  }
}

function commit({ full = false, undo = null } = {}) {
  album.updatedAt = new Date().toISOString();
  revision += 1;
  lastUndo = undo;
  if (!undo) $('#undo-button').hidden = true;
  setStatus('saving', '端末に保存しています');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 450);
  if (full) { renderSidebar(); renderEditor(); }
  else updateSidebarMetadata();
  queuePreview();
}

function renderSidebar() {
  const items = [{ image: album.coverImage, label: '表紙', detail: album.title || 'タイトルなし' }, ...album.pages.map((page, index) => ({ image: page.image, label: `写真ページ ${String(index + 1).padStart(2, '0')}`, detail: page.date ? page.date.replaceAll('-', '.') : page.note || '日付・ひとことを添える' }))];
  $('#page-count').textContent = album.pages.length ? `${album.pages.length}ページ＋表紙` : '表紙のみ';
  $('#page-list').innerHTML = items.map((item, index) => `<div class="page-row ${index === selected ? 'is-active' : ''}">
    <button type="button" class="page-select" data-action="select-page" data-index="${index}" ${index === selected ? 'aria-current="page"' : ''} aria-label="${escape(item.label)}を編集">
      <span class="page-thumb">${item.image ? `<img src="${escape(item.image)}" alt="" loading="lazy">` : icon(index === 0 ? 'book' : 'image')}</span>
      <span class="page-label"><strong>${escape(item.label)}</strong><small>${escape(item.detail)}</small></span>
    </button>
    ${index > 0 && index === selected ? `<span class="page-tools"><button class="icon-button" type="button" data-action="move-up" aria-label="このページを前へ移動" ${index === 1 ? 'disabled' : ''}>${icon('up')}</button><button class="icon-button" type="button" data-action="move-down" aria-label="このページを後ろへ移動" ${index === album.pages.length ? 'disabled' : ''}>${icon('down')}</button></span>` : ''}
  </div>`).join('');
  $('#prev-page').disabled = selected === 0;
  $('#next-page').disabled = selected === album.pages.length;
  $('#preview-position').textContent = `${selected === 0 ? '表紙' : String(selected).padStart(2, '0')} · ${selected + 1} / ${album.pages.length + 1}`;
}

function updateSidebarMetadata() {
  const rows = $('#page-list').children;
  const coverDetail = rows[0]?.querySelector('.page-label small');
  if (coverDetail) coverDetail.textContent = album.title || 'タイトルなし';
  const page = selectedPage();
  const detail = page && rows[selected]?.querySelector('.page-label small');
  if (detail) detail.textContent = page.date ? page.date.replaceAll('-', '.') : page.note || '日付・ひとことを添える';
}

function renderEditor() {
  const page = selectedPage();
  const isCover = !page;
  const image = isCover ? album.coverImage : page.image;
  const imageName = isCover ? album.coverImageName : page.imageName;
  const fit = isCover ? album.coverFit : page.fit;
  const frame = (isCover ? album.coverFrame : page.frame) || 'none';
  $('#editor-heading').innerHTML = `<span class="editor-index">${isCover ? 'COVER' : `PAGE ${String(selected).padStart(2, '0')}`}</span><h2>${isCover ? '表紙をつくる' : '思い出を綴る'}</h2><p>${isCover ? '最初の一枚に、あなたらしいタイトルを。' : 'この一枚に、日付とひとことを添えて。'}</p>`;
  $('#editor-form').innerHTML = `
    <div class="field"><span class="field-label">${isCover ? '表紙の画像' : 'ページの画像'}</span>
      <button type="button" class="photo-picker ${image ? 'has-photo' : ''}" data-action="choose-image" aria-label="${isCover ? '表紙' : 'このページ'}の画像を${image ? '差し替える' : '選ぶ'}">
        ${image ? `<img src="${escape(image)}" alt="${escape(imageName || '選択した画像')}"><span class="replace-label">画像を差し替える</span>` : `${icon('image')}<strong>画像を選ぶ</strong><small>または、ここにドラッグ</small>`}
      </button>${image ? '<button class="image-remove" type="button" data-action="remove-image">画像を外す</button>' : ''}
    </div>
    ${isCover ? `<div class="field"><label for="album-title">アルバムのタイトル</label><input id="album-title" name="title" data-field="title" maxlength="120" value="${escape(album.title)}" placeholder="思い出のアルバム" autocomplete="off"><div class="field-footer"><span>表紙に大きく入ります</span><span data-count="title">${album.title.length} / 120</span></div></div>
    <div class="field"><label for="album-subtitle">サブタイトル<span class="optional">任意</span></label><textarea id="album-subtitle" name="subtitle" data-field="subtitle" maxlength="180" rows="2" placeholder="旅先や、いっしょに過ごした人の名前など">${escape(album.subtitle)}</textarea></div>` : `<div class="field"><label for="page-date">日付<span class="optional">任意</span></label><div class="date-control"><input type="date" id="page-date" name="date" data-field="date" value="${escape(page.date)}" min="0001-01-01" max="9999-12-31" aria-describedby="date-help"><button type="button" class="date-none" data-action="clear-date" aria-pressed="${!page.date}">日付なし</button></div><p class="field-help" id="date-help">「日付なし」を選ぶと、日付を印字せずに保存します。</p></div>
    <div class="field"><label for="page-note">ひとこと<span class="optional">任意</span></label><textarea id="page-note" name="note" data-field="note" maxlength="300" rows="4" placeholder="このとき、みんなで笑ったね。">${escape(page.note)}</textarea><div class="field-footer"><span>書かなくても大丈夫</span><span data-count="note">${page.note.length} / 300</span></div></div>`}
    <div class="field"><span class="field-label">画像の見せ方</span><div class="segments" role="group" aria-label="画像の見せ方"><button type="button" data-action="fit-contain" aria-pressed="${fit === 'contain'}">全体を入れる</button><button type="button" data-action="fit-cover" aria-pressed="${fit === 'cover'}">枠いっぱい</button></div><p class="field-help">「全体を入れる」は、画像を中央で切り抜かずに収めます。</p></div>
    <div class="field"><span class="field-label">写真の枠<span class="optional">この${isCover ? '表紙' : 'ページ'}</span></span><div class="frame-options" role="group" aria-label="${isCover ? '表紙' : 'このページ'}の写真の枠">${FRAME_OPTIONS.map(({ value, label }) => `<button type="button" class="frame-option" data-action="frame" data-frame="${value}" aria-pressed="${frame === value}"><span class="frame-preview frame-preview-${value}" aria-hidden="true"><span class="frame-preview-photo"></span></span><span>${label}</span></button>`).join('')}</div><p class="field-help">写真ごとに選べます。角丸は写真の角も丸くなります。PDF・PNGにも反映します。</p></div>
    <div class="field"><span class="field-label">文字のフォント<span class="optional">全ページ共通</span></span><div class="font-options" role="group" aria-label="アルバムのフォント">${FONT_OPTIONS.map(({ value, label, family }) => `<button type="button" class="font-option" data-action="font" data-font="${value}" aria-pressed="${album.font === value}"><span class="font-preview" style="font-family:${escape(family)}">あいうえお</span><span>${label}</span></button>`).join('')}</div><p class="field-help">タイトル・日付・ひとことに反映します。</p></div>
    <div class="field theme-field"><span class="field-label">アルバムの色・背景<span class="optional">全ページ共通</span></span><div class="theme-options" role="group" aria-label="紙と文字の色">${[['linen', 'きなり', '#ede5d3'], ['sky', '空色', '#dcebf0'], ['rose', 'さくら', '#f1dfe0'], ['plain', '背景なし（白）', '#ffffff']].map(([value, label, color]) => `<button type="button" class="theme-option" data-action="theme" data-theme="${value}" aria-pressed="${album.theme === value}"><span class="theme-swatch" style="--swatch:${color}"></span>${label}</button>`).join('')}</div>
      ${album.theme === 'plain' ? `<p class="field-help">印刷向けの白い台紙です。背景画像や台紙の色・飾りを表示しません。${album.backgroundImage ? '背景画像は残っています。ほかの色を選ぶと戻せます。' : 'ほかの色を選ぶと、背景画像も設定できます。'}</p>` : `<button type="button" class="background-picker ${album.backgroundImage ? 'has-background' : ''}" data-action="choose-background" aria-label="背景画像を${album.backgroundImage ? '差し替える' : '選ぶ'}">${album.backgroundImage ? `<img src="${escape(album.backgroundImage)}" alt=""><span><strong>背景画像を差し替える</strong><small>${escape(album.backgroundImageName || '選択した画像')}</small></span>` : `${icon('image')}<span><strong>背景画像を選ぶ</strong><small>好きな絵や模様を、アルバムの台紙に。</small></span>`}</button>
      ${album.backgroundImage ? `<button class="image-remove" type="button" data-action="remove-background">背景画像を外す</button><div class="background-opacity"><label for="background-opacity">背景画像の濃さ <output for="background-opacity" id="background-opacity-value">${Math.round(album.backgroundOpacity * 100)}%</output></label><input id="background-opacity" type="range" data-field="backgroundOpacity" min="0" max="100" step="1" value="${Math.round(album.backgroundOpacity * 100)}" aria-describedby="background-help"></div>` : ''}
      <p class="field-help" id="background-help">表紙と全ページに反映します。背景は中央で切り抜き、写真と文字は上に重ねます。</p>`}
    </div>
    ${isCover ? '' : `<button type="button" class="delete-page" data-action="delete-page">${icon('trash')}このページを削除</button>`}
  `;
}

function queuePreview(immediate = false) {
  clearTimeout(previewTimer);
  // Invalidate earlier asynchronous renders immediately, even before debounce fires.
  previewGeneration += 1;
  const generation = previewGeneration;
  const copy = snapshot();
  const index = selected;
  previewTimer = setTimeout(async () => {
    const canvas = document.createElement('canvas');
    $('#preview-loading').hidden = false;
    try {
      await renderAlbumPage(canvas, copy, index);
      if (generation !== previewGeneration) return;
      const target = $('#preview-canvas');
      target.width = PAGE_WIDTH;
      target.height = PAGE_HEIGHT;
      target.getContext('2d').drawImage(canvas, 0, 0);
      target.setAttribute('aria-label', `${pageName(index)}の仕上がりプレビュー`);
      if ($('#zoom-dialog').open) copyToZoom();
    } catch (error) {
      if (generation === previewGeneration) toast(error.message || '画像の読み込みに失敗しました。画像を選び直してください。');
    } finally {
      canvas.width = 1;
      canvas.height = 1;
      if (generation === previewGeneration) $('#preview-loading').hidden = true;
    }
  }, immediate ? 0 : 120);
}

function renderAll() { renderSidebar(); renderEditor(); queuePreview(true); }
function selectPage(index) {
  if (!Number.isInteger(index) || index < 0 || index > album.pages.length) return;
  selected = index;
  renderAll();
  const button = document.querySelector('.page-row.is-active .page-select');
  button?.focus({ preventScroll: true });
  button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function setView(view) {
  document.body.dataset.view = view;
  document.querySelector('[data-action="view-edit"]').setAttribute('aria-pressed', String(view === 'edit'));
  document.querySelector('[data-action="view-preview"]').setAttribute('aria-pressed', String(view === 'preview'));
  if (view === 'preview') queuePreview(true);
}

function copyToZoom() {
  const canvas = $('#zoom-canvas');
  canvas.width = PAGE_WIDTH; canvas.height = PAGE_HEIGHT;
  canvas.getContext('2d').drawImage($('#preview-canvas'), 0, 0);
  $('#zoom-title').textContent = `${album.title || 'アルバム'} / ${pageName()}`;
}

function confirmAction(title, copy, ok = '続ける') {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-copy').textContent = copy;
  $('#confirm-ok').textContent = ok;
  dialog.returnValue = 'cancel';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    $('#confirm-ok').onclick = () => dialog.close('ok');
    $('#confirm-cancel').onclick = () => dialog.close('cancel');
    dialog.showModal();
  });
}

async function busyTask(title, callback) {
  if (busy) return;
  busy = true;
  $('#save-dialog').close();
  $('#progress-title').textContent = title;
  $('#progress-message').textContent = '少しお待ちください。';
  $('#progress-bar').value = 0;
  $('#progress-bar').max = 1;
  $('#progress-dialog').showModal();
  try { return await callback(); }
  finally { busy = false; $('#progress-dialog').close(); }
}

function progress(current, total, message) {
  $('#progress-bar').max = total;
  $('#progress-bar').value = current;
  $('#progress-message').textContent = message;
}

function newPage(image = null, imageName = '') { return { id: makeId(), image, imageName, date: '', note: '', fit: 'contain', frame: 'none' }; }

async function addPhotos(files) {
  if (!files.length || busy) return;
  const available = LIMIT - album.pages.length;
  if (available < 1) { toast('一冊に入れられる写真ページは100ページまでです。'); return; }
  const chosen = [...files].slice(0, available);
  await busyTask('写真をアルバムに入れています', async () => {
    const additions = [];
    const failures = [];
    for (let index = 0; index < chosen.length; index++) {
      progress(index, chosen.length, `${index + 1} / ${chosen.length} 枚を読み込み中`);
      try {
        const result = await fileToImage(chosen[index]);
        const addition = newPage(result.dataUrl, result.name);
        assertProjectBudget({ ...album, coverImage: album.coverImage || additions[0]?.image || addition.image, pages: [...album.pages, ...additions, addition] });
        additions.push(addition);
      } catch (error) { failures.push(`${chosen[index].name}: ${error.message}`); }
    }
    if (!additions.length) throw new Error(failures[0] || '画像を読み込めませんでした。');
    const firstIndex = album.pages.length + 1;
    const coverAdded = !album.coverImage;
    album.pages.push(...additions);
    if (coverAdded) { album.coverImage = additions[0].image; album.coverImageName = additions[0].imageName; }
    selected = firstIndex;
    commit({ full: true });
    setView('edit');
    let message = `${additions.length}枚の写真を追加しました。`;
    if (coverAdded) message += '最初の写真を表紙にも使いました。';
    if (files.length > available) message += '100ページを超える分は追加していません。';
    if (failures.length) message += `${failures.length}枚は追加できませんでした。${failures[0].includes('200MB') ? '容量上限を超える分は、別のアルバムに分けてください。' : '画像形式やファイルの大きさをご確認ください。'}`;
    toast(message);
  });
}

async function replacePhoto(file) {
  if (!file || busy) return;
  await busyTask('画像を読み込んでいます', async () => {
    const result = await fileToImage(file);
    const candidate = snapshot();
    if (selected === 0) candidate.coverImage = result.dataUrl;
    else candidate.pages[selected - 1].image = result.dataUrl;
    assertProjectBudget(candidate);
    if (selected === 0) { album.coverImage = result.dataUrl; album.coverImageName = result.name; }
    else { selectedPage().image = result.dataUrl; selectedPage().imageName = result.name; }
    commit({ full: true });
  });
}

async function replaceBackground(file) {
  if (!file || busy) return;
  await busyTask('背景画像を読み込んでいます', async () => {
    const result = await fileToImage(file);
    assertProjectBudget({ ...album, backgroundImage: result.dataUrl, backgroundImageName: result.name });
    const undo = { album: snapshot(), selected };
    album.backgroundImage = result.dataUrl;
    album.backgroundImageName = result.name;
    commit({ full: true, undo });
    toast('表紙と全ページに背景画像を入れました。濃さも調整できます。', true);
  });
}

async function decodeImportedImages(candidate) {
  const values = [...new Set([candidate.coverImage, candidate.backgroundImage, ...candidate.pages.map((page) => page.image)].filter(Boolean))];
  for (let index = 0; index < values.length; index++) {
    progress(index, Math.max(values.length, 1), `写真を確認しています ${index + 1} / ${values.length}`);
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = () => {
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 160000000) reject(new Error('編集データの画像サイズを確認してください。'));
        else resolve();
      };
      image.onerror = () => reject(new Error('編集データに読み込めない画像が含まれています。元の編集データを選び直してください。'));
      image.src = values[index];
    });
    image.src = '';
  }
}

async function openProject(file) {
  if (!file || busy) return;
  $('#save-dialog').close();
  if (file.size > MAX_PROJECT_BYTES) throw new Error('編集データは200MB以内のファイルを選んでください。');
  let candidate;
  try { candidate = validateAlbum(JSON.parse(await file.text())); }
  catch (error) { throw new Error(error instanceof SyntaxError ? 'アルバムの編集データ（.album.json）を選んでください。' : error.message); }
  assertProjectBudget(candidate);
  if (hasContent() && !await confirmAction('編集データを開きますか？', 'いま表示しているアルバムを、選んだ編集データに置き換えます。\nいまの内容を残す場合は、先に編集データで保存してください。', '置き換えて開く')) return;
  await busyTask('アルバムを開いています', async () => {
    await decodeImportedImages(candidate);
    const undo = { album: snapshot(), selected };
    album = candidate;
    selected = 0;
    commit({ full: true, undo });
    setView('edit');
    toast('保存したアルバムを開きました。', true);
  });
}

async function loadDemo() {
  if (hasContent() && !await confirmAction('見本のアルバムを開きますか？', 'いまの内容を見本に置き換えます。\n残しておきたい場合は、先に編集データで保存してください。', '見本を開く')) return;
  await busyTask('見本のアルバムを用意しています', async () => {
    const definitions = [
      ['cavalry.webp', 'はちまきは水色。みんなで大笑いした、体育祭の一枚。'],
      ['courtyard.webp', '休憩中も、それぞれの時間。こっそり覗く人がひとり。'],
      ['shade.webp', '木陰で、ちょっとひと休み。日焼け止めを塗る距離。']
    ];
    const pages = [];
    for (let index = 0; index < definitions.length; index++) {
      const [filename, note] = definitions[index];
      progress(index, definitions.length, `${index + 1} / ${definitions.length} 枚`);
      const response = await fetch(new URL(`./demo/${filename}`, import.meta.url));
      if (!response.ok) throw new Error('見本の画像を読み込めませんでした。もう一度お試しください。');
      const blob = await response.blob();
      const result = await fileToImage(new File([blob], filename, { type: blob.type || 'image/webp' }));
      pages.push({ ...newPage(result.dataUrl, filename), date: '2026-10-15', note });
    }
    const undo = { album: snapshot(), selected };
    album = { ...createAlbum(), title: 'ポルトガルの思い出', subtitle: '青いジャージでめぐった、にぎやかな一日。', coverImage: pages[0].image, coverImageName: pages[0].imageName, pages };
    selected = 0;
    commit({ full: true, undo });
    toast('見本を入れました。写真も文章も自由に変えられます。', true);
  });
}

async function handleAction(action, button) {
  if (!ready || busy) return;
  switch (action) {
    case 'save-menu': $('#save-dialog').showModal(); break;
    case 'close-save': $('#save-dialog').close(); break;
    case 'open-project': $('#save-dialog').close(); $('#project-input').click(); break;
    case 'add-photos': $('#photo-input').click(); break;
    case 'choose-image': $('#single-photo-input').click(); break;
    case 'choose-background': $('#background-input').click(); break;
    case 'remove-background': {
      const undo = { album: snapshot(), selected };
      album.backgroundImage = null; album.backgroundImageName = '';
      commit({ full: true, undo }); toast('背景画像を外しました。', true); break;
    }
    case 'select-page': selectPage(Number(button.dataset.index)); break;
    case 'previous': selectPage(selected - 1); break;
    case 'next': selectPage(selected + 1); break;
    case 'view-edit': setView('edit'); break;
    case 'view-preview': setView('preview'); break;
    case 'zoom': copyToZoom(); $('#zoom-dialog').showModal(); break;
    case 'close-zoom': $('#zoom-dialog').close(); break;
    case 'theme': album.theme = button.dataset.theme; commit({ full: true }); break;
    case 'font': {
      if (!FONT_OPTIONS.some((font) => font.value === button.dataset.font)) break;
      album.font = button.dataset.font;
      commit({ full: true });
      document.querySelector(`[data-action="font"][data-font="${album.font}"]`)?.focus({ preventScroll: true });
      break;
    }
    case 'frame': {
      const frame = button.dataset.frame;
      if (!FRAME_OPTIONS.some((option) => option.value === frame)) break;
      if (selected === 0) album.coverFrame = frame; else selectedPage().frame = frame;
      commit({ full: true });
      document.querySelector(`[data-action="frame"][data-frame="${frame}"]`)?.focus({ preventScroll: true });
      break;
    }
    case 'clear-date': {
      const page = selectedPage();
      if (!page) break;
      if (!page.date) { $('#page-date').value = ''; break; }
      const undo = { album: snapshot(), selected };
      page.date = '';
      commit({ full: true, undo });
      document.querySelector('[data-action="clear-date"]')?.focus({ preventScroll: true });
      toast('日付なしにしました。', true); break;
    }
    case 'fit-contain': case 'fit-cover': {
      const fit = action === 'fit-contain' ? 'contain' : 'cover';
      if (selected === 0) album.coverFit = fit; else selectedPage().fit = fit;
      commit({ full: true }); break;
    }
    case 'add-blank':
      if (album.pages.length >= LIMIT) { toast('一冊に入れられる写真ページは100ページまでです。'); break; }
      album.pages.push(newPage()); selected = album.pages.length; commit({ full: true }); setView('edit'); break;
    case 'move-up': case 'move-down': {
      const delta = action === 'move-up' ? -1 : 1;
      const from = selected - 1; const to = from + delta;
      if (from < 0 || to < 0 || to >= album.pages.length) break;
      [album.pages[from], album.pages[to]] = [album.pages[to], album.pages[from]];
      selected += delta; commit({ full: true }); break;
    }
    case 'delete-page': {
      if (!selectedPage()) break;
      const undo = { album: snapshot(), selected };
      album.pages.splice(selected - 1, 1); selected = Math.min(selected, album.pages.length);
      commit({ full: true, undo }); toast('ページを削除しました。', true); break;
    }
    case 'remove-image': {
      const undo = { album: snapshot(), selected };
      if (selected === 0) { album.coverImage = null; album.coverImageName = ''; }
      else { selectedPage().image = null; selectedPage().imageName = ''; }
      commit({ full: true, undo }); toast('画像を外しました。', true); break;
    }
    case 'undo': {
      if (!lastUndo) break;
      const previous = lastUndo;
      album = previous.album; selected = previous.selected; commit({ full: true }); toast('元に戻しました。'); break;
    }
    case 'new-album': {
      if (hasContent() && !await confirmAction('新しいアルバムを始めますか？', 'いまの内容を残す場合は、先にPDFや編集データで保存してください。', '新しく始める')) break;
      const undo = { album: snapshot(), selected };
      album = createAlbum(); selected = 0; commit({ full: true, undo }); setView('edit'); toast('新しいアルバムを始めました。', true); break;
    }
    case 'demo': await loadDemo(); break;
    case 'export-project': {
      assertProjectBudget(album);
      const contents = serializeAlbum(album);
      downloadBlob(new Blob([contents], { type: 'application/json;charset=utf-8' }), `${sanitizeFilename(album.title)}.album.json`);
      $('#save-dialog').close(); toast('編集データの保存を開始しました。'); break;
    }
    case 'export-png':
      await busyTask('今のページを画像にしています', async () => { await downloadPng(snapshot(), selected); toast('PNG画像の保存を開始しました。'); }); break;
    case 'export-pdf':
      await busyTask('アルバムを一冊にしています', async () => {
        await downloadPdf(snapshot(), { onProgress: ({ current, total }) => progress(current, total, `${current} / ${total} ページを用意しました`) });
        toast('PDFの保存を開始しました。ダウンロード先をご確認ください。');
      }); break;
  }
}

function reportError(error) { console.error(error); toast(error?.message || '操作を完了できませんでした。もう一度お試しください。'); }

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  event.preventDefault();
  handleAction(button.dataset.action, button).catch(reportError);
});

$('#editor-form').addEventListener('submit', (event) => event.preventDefault());
$('#editor-form').addEventListener('input', (event) => {
  const field = event.target.dataset.field;
  if (!field || busy || !ready) return;
  if (field === 'backgroundOpacity') {
    const value = Number(event.target.value);
    if (!Number.isFinite(value) || value < 0 || value > 100) return;
    album.backgroundOpacity = value / 100;
    $('#background-opacity-value').textContent = `${value}%`;
  } else if (selected === 0 && ['title', 'subtitle'].includes(field)) album[field] = event.target.value;
  else if (selectedPage() && ['date', 'note'].includes(field)) {
    if (field === 'date' && !event.target.validity.valid) return;
    selectedPage()[field] = event.target.value;
    if (field === 'date') document.querySelector('[data-action="clear-date"]').setAttribute('aria-pressed', String(!event.target.value));
  } else return;
  const counter = document.querySelector(`[data-count="${field}"]`);
  if (counter) counter.textContent = `${event.target.value.length} / ${field === 'note' ? 300 : 120}`;
  commit();
});

$('#photo-input').addEventListener('change', async (event) => { const files = [...event.target.files]; event.target.value = ''; try { await addPhotos(files); } catch (error) { reportError(error); } });
$('#single-photo-input').addEventListener('change', async (event) => { const file = event.target.files[0]; event.target.value = ''; try { await replacePhoto(file); } catch (error) { reportError(error); } });
$('#background-input').addEventListener('change', async (event) => { const file = event.target.files[0]; event.target.value = ''; try { await replaceBackground(file); } catch (error) { reportError(error); } });
$('#project-input').addEventListener('change', async (event) => { const file = event.target.files[0]; event.target.value = ''; try { await openProject(file); } catch (error) { reportError(error); } });

document.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files') || busy) return;
  event.preventDefault(); dragDepth += 1;
  $('#drop-overlay').hidden = Boolean(event.target.closest('.photo-picker, .background-picker'));
});
document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
  const target = event.target.closest('.photo-picker, .background-picker');
  document.querySelectorAll('.photo-picker, .background-picker').forEach((picker) => picker.classList.toggle('is-dragging', picker === target));
});
document.addEventListener('dragleave', (event) => { if (!event.dataTransfer?.types.includes('Files')) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { $('#drop-overlay').hidden = true; document.querySelectorAll('.is-dragging').forEach((picker) => picker.classList.remove('is-dragging')); } });
document.addEventListener('drop', async (event) => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault(); dragDepth = 0; $('#drop-overlay').hidden = true;
  document.querySelectorAll('.is-dragging').forEach((picker) => picker.classList.remove('is-dragging'));
  if (busy || !ready) return;
  const files = [...event.dataTransfer.files];
  try {
    if (files.length === 1 && /\.(json|album)$/i.test(files[0].name)) await openProject(files[0]);
    else if (event.target.closest('.background-picker')) await replaceBackground(files[0]);
    else if (event.target.closest('.photo-picker')) await replacePhoto(files[0]);
    else await addPhotos(files);
  } catch (error) { reportError(error); }
});

$('#progress-dialog').addEventListener('cancel', (event) => event.preventDefault());
for (const id of ['save-dialog', 'zoom-dialog']) {
  const dialog = $(`#${id}`);
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
}
window.addEventListener('beforeunload', (event) => {
  if (revision > savedRevision) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && revision > savedRevision) void persist(); });

async function init() {
  let loadFailed = false;
  try {
    const restored = await loadDraft();
    if (restored) { album = restored; setStatus('saved', 'この端末に保存済み'); }
    else setStatus('saved', '写真からはじめよう');
  } catch (error) { loadFailed = true; setStatus('error', '自動保存を利用できません'); toast(error.message); }
  ready = true;
  renderAll();
  // An unreadable existing draft is not overwritten until the user explicitly edits.
  if (!loadFailed && !hasContent()) void persist();
}

init().catch(reportError);
