/** Shared font choices for the editor, preview, and exported album pages. */
export const FONT_OPTIONS = Object.freeze([
  Object.freeze({ value: 'serif', label: '明朝', family: '"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "MS PMincho", serif' }),
  Object.freeze({ value: 'sans', label: 'ゴシック', family: '"Noto Sans JP", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif' }),
  Object.freeze({ value: 'rounded', label: '丸ゴシック', family: '"Album Rounded", "Hiragino Maru Gothic ProN", "UD Digi Kyokasho NK-R", "Noto Sans JP", "Yu Gothic", sans-serif' }),
]);

export function getAlbumFont(value) {
  return (FONT_OPTIONS.find((font) => font.value === value) || FONT_OPTIONS[0]).family;
}
