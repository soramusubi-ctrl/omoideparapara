import test from 'node:test';
import assert from 'node:assert/strict';
import { getBookViews, findBookView } from '../dist/book-layout.js';

test('single-page mode includes the cover and every photo page in order', () => {
  assert.deepEqual(getBookViews(1, false), [[0]]);
  assert.deepEqual(getBookViews(2, false), [[0], [1]]);
  assert.deepEqual(getBookViews(4), [[0], [1], [2], [3]]);
  assert.deepEqual(getBookViews(101, false), Array.from({ length: 101 }, (_, page) => [page]));
});

test('spreads put the cover on the right and pad an unpaired final photo on the right', () => {
  assert.deepEqual(getBookViews(1, true), [[null, 0]]);
  assert.deepEqual(getBookViews(2, true), [[null, 0], [1, null]]);
  assert.deepEqual(getBookViews(3, true), [[null, 0], [1, 2]]);
  assert.deepEqual(getBookViews(4, true), [[null, 0], [1, 2], [3, null]]);
  const fullAlbum = getBookViews(101, true);
  assert.equal(fullAlbum.length, 51);
  assert.deepEqual(fullAlbum.at(-1), [99, 100]);
});

test('all supported album sizes have no omitted or repeated pages and only boundary blanks', () => {
  for (let totalPages = 1; totalPages <= 101; totalPages += 1) {
    for (const doublePage of [false, true]) {
      const views = getBookViews(totalPages, doublePage);
      const pages = views.flat().filter(page => page !== null);
      assert.deepEqual(pages, Array.from({ length: totalPages }, (_, page) => page));
      assert.equal(new Set(pages).size, totalPages);
      assert.ok(views.every(view => view.length === (doublePage ? 2 : 1)));
      const blanks = views.flat().filter(page => page === null).length;
      assert.equal(blanks, doublePage ? (totalPages % 2 === 0 ? 2 : 1) : 0);
      if (doublePage) {
        assert.deepEqual(views[0], [null, 0]);
        assert.ok(views.slice(1, -1).every(view => view.every(page => page !== null)));
        if (totalPages > 1) assert.notEqual(views.at(-1)[0], null);
      }
    }
  }
});

test('desktop and mobile transitions keep every selected page in its view, including final pages', () => {
  for (const totalPages of [1, 2, 3, 4, 100, 101]) {
    const desktop = getBookViews(totalPages, true);
    const mobile = getBookViews(totalPages, false);
    for (let page = 0; page < totalPages; page += 1) {
      const desktopPosition = findBookView(desktop, page);
      const mobilePosition = findBookView(mobile, page);
      assert.ok(desktop[desktopPosition].includes(page));
      assert.deepEqual(mobile[mobilePosition], [page]);
      assert.equal(findBookView(getBookViews(totalPages, true), mobile[mobilePosition][0]), desktopPosition);
    }
  }
  const views = getBookViews(5, true);
  assert.equal(findBookView(views, 1), 1);
  assert.equal(findBookView(views, 2), 1);
  assert.equal(findBookView(views, 3), 2);
  assert.equal(findBookView(views, 4), 2);
});

test('view lookup falls back to the cover for missing pages and invalid inputs', () => {
  const views = getBookViews(4, true);
  for (const page of [-1, 0.5, 4, 100, null, undefined, NaN, Infinity, '2', true, {}]) {
    assert.equal(findBookView(views, page), 0);
  }
  for (const invalidViews of [null, undefined, {}, 'views', 3, []]) {
    assert.equal(findBookView(invalidViews, 2), 0);
  }
  assert.equal(findBookView([null, {}, '2', [2]], 2), 3);
});

test('invalid page totals and non-boolean modes fail before building a layout', () => {
  for (const total of [undefined, null, '2', true, NaN, Infinity, -Infinity, 1.5, {}, []]) {
    assert.throws(() => getBookViews(total, false), TypeError);
  }
  for (const total of [-1, 0, 102, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => getBookViews(total, true), RangeError);
  }
  for (const mode of [null, 0, 1, 'false', 'true', [], {}]) {
    assert.throws(() => getBookViews(3, mode), TypeError);
  }
});

test('layouts own their arrays and lookup does not mutate frozen views', () => {
  const first = getBookViews(5, true);
  const second = getBookViews(5, true);
  first[1][0] = 99;
  first.push([100, null]);
  assert.deepEqual(second, [[null, 0], [1, 2], [3, 4]]);
  const frozen = Object.freeze(second.map(view => Object.freeze(view)));
  const before = JSON.stringify(frozen);
  assert.equal(findBookView(frozen, 4), 2);
  assert.equal(findBookView(frozen, 99), 0);
  assert.equal(JSON.stringify(frozen), before);
});
