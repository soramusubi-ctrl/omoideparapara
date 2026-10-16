/** Serialize immutable save requests while retaining only committed revisions. */
export function createAlbumWriter({ saveAlbum }) {
  if (typeof saveAlbum !== 'function') throw new TypeError('Album storage is required.');
  const revisions = new Map();
  let queue = Promise.resolve();

  function seed(id, revision) {
    revisions.set(id, revision);
  }

  function save(album) {
    // Capture edits now, including when an earlier request is still committing.
    const snapshot = { ...album, pages: album.pages.map(page => ({ ...page })) };
    const pending = queue.then(async () => {
      const result = await saveAlbum(snapshot, { expectedRevision: revisions.get(snapshot.id) ?? 0 });
      revisions.set(snapshot.id, result.revision);
      return result;
    });
    // A failed write stays failed for its caller without blocking later requests.
    queue = pending.catch(() => {});
    return pending;
  }

  return { seed, save };
}
