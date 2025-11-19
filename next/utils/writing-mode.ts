/**
 * Detects whether text should be rendered vertically (Tategaki) or horizontally.
 * 
 * Heuristic:
 * 1. If text contains Japanese/Chinese characters (Kanji, Hiragana, Katakana),
 *    it strongly prefers vertical layout, unless the box is very wide (banner).
 * 2. If text is Latin/Cyrillic/etc, it ALWAYS prefers horizontal layout,
 *    even in tall bubbles (it just wraps).
 */
export function detectWritingMode(text: string, width: number, height: number): 'horizontal-tb' | 'vertical-rl' {
  if (!text) return 'horizontal-tb'

  // Regex for CJK characters (Common ranges)
  // Hiragana, Katakana, Kanji, Punctuation
  const cjkRegex = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf]/
  
  const hasCJK = cjkRegex.test(text)
  const aspectRatio = height / width

  if (hasCJK) {
    // CJK text
    // Default to vertical unless it's a wide banner (ratio < 0.8)
    if (aspectRatio < 0.8) {
      return 'horizontal-tb'
    }
    return 'vertical-rl'
  } else {
    // Latin/Non-CJK text
    // ALWAYS horizontal. English is never written vertically in standard manga bubbles
    // (except for special effects, which we can't auto-detect easily yet)
    return 'horizontal-tb'
  }
}
