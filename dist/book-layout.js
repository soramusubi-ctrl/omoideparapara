/** Build page views without changing album data. Page zero is the cover. */
export function getBookViews(totalPages, doublePage = false) {
  if (!Number.isInteger(totalPages)) throw new TypeError('totalPages must be an integer.');
  if (totalPages < 1 || totalPages > 101) throw new RangeError('totalPages must be between 1 and 101.');
  if (typeof doublePage !== 'boolean') throw new TypeError('doublePage must be a boolean.');

  if (!doublePage) return Array.from({ length: totalPages }, (_, page) => [page]);

  const views = [[null, 0]];
  for (let page = 1; page < totalPages; page += 2) {
    views.push([page, page + 1 < totalPages ? page + 1 : null]);
  }
  return views;
}

/** Locate the current page after switching between one-page and spread views. */
export function findBookView(views, pageIndex) {
  if (!Array.isArray(views) || !Number.isInteger(pageIndex) || pageIndex < 0) return 0;
  const index = views.findIndex(view => Array.isArray(view) && view.includes(pageIndex));
  return index < 0 ? 0 : index;
}
