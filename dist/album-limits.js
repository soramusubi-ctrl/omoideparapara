export const MAX_PROJECT_BYTES = 200 * 1024 * 1024;
// Reserve enough for every allowed title, note, ID and filename (including the
// background filename and opacity), so later text edits cannot exceed the budget.
const METADATA_RESERVE = 512 * 1024;

// Count ASCII image strings without constructing a second, very large JSON copy.
// The small metadata copy is measured as UTF-8, including Japanese and emoji.
export function estimateProjectBytes(album) {
  let imageBytes = 0;
  const imageCost = (value) => {
    if (typeof value === 'string') imageBytes += value.length - 2;
    return null;
  };
  const metadata = { ...album, coverImage: imageCost(album.coverImage), pages: album.pages.map((page) => ({ ...page, image: imageCost(page.image) })) };
  if (typeof metadata.backgroundImage === 'string') {
    metadata.backgroundImage = imageCost(metadata.backgroundImage);
  }
  return imageBytes + Math.max(METADATA_RESERVE, new TextEncoder().encode(JSON.stringify(metadata, null, 2)).length);
}

export function assertProjectBudget(album) {
  if (estimateProjectBytes(album) > MAX_PROJECT_BYTES) {
    throw new Error('編集データの上限（200MB）を超えます。写真を減らすか、別のアルバムに分けてください。');
  }
}
