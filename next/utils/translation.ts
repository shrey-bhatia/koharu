/**
 * Google Cloud Translation API wrapper
 * Uses REST API (no SDK needed) - works in browser/Tauri context
 */

export interface TranslationError {
  code: number
  message: string
  status: string
}

export class TranslationAPIError extends Error {
  code: number
  status: string

  constructor(error: TranslationError) {
    super(error.message)
    this.name = 'TranslationAPIError'
    this.code = error.code
    this.status = error.status
  }
}

/**
 * Translate text using Google Cloud Translation API v2
 *
 * @param text - Text to translate
 * @param apiKey - Google Cloud API key
 * @param sourceLang - Source language code (default: 'ja' for Japanese)
 * @param targetLang - Target language code (default: 'en' for English)
 * @returns Translated text
 *
 * @throws TranslationAPIError on API errors (invalid key, rate limit, etc.)
 */
export async function translateWithGoogle(
  text: string,
  apiKey: string,
  sourceLang = 'ja',
  targetLang = 'en'
): Promise<string> {
  if (!text || text.trim().length === 0) {
    return text
  }

  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('API key is required')
  }

  try {
    // API key must be in query parameters, not body
    const url = new URL('https://translation.googleapis.com/language/translate/v2')
    url.searchParams.append('key', apiKey)

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: text,
        source: sourceLang,
        target: targetLang,
        format: 'text',
      }),
    })

    if (!response.ok) {
      const errorData = await response.json()
      throw new TranslationAPIError(errorData.error)
    }

    const data = await response.json()

    if (!data.data?.translations?.[0]?.translatedText) {
      throw new Error('Invalid API response format')
    }

    return data.data.translations[0].translatedText
  } catch (error) {
    if (error instanceof TranslationAPIError) {
      throw error
    }

    if (error instanceof Error) {
      throw new Error(`Translation failed: ${error.message}`)
    }

    throw new Error('Unknown translation error')
  }
}

/**
 * Test API key validity by attempting a simple translation
 */
export async function testApiKey(apiKey: string): Promise<boolean> {
  try {
    await translateWithGoogle('テスト', apiKey, 'ja', 'en')
    return true
  } catch (error) {
    console.error('API key test failed:', error)
    return false
  }
}

/**
 * Batch translate multiple texts with rate limiting
 * Adds delays between requests to avoid hitting rate limits
 *
 * @param texts - Array of texts to translate
 * @param apiKey - Google Cloud API key
 * @param onProgress - Callback for progress updates (optional)
 * @param delayMs - Delay between requests in milliseconds (default: 100ms)
 */
export async function batchTranslate(
  texts: string[],
  apiKey: string,
  onProgress?: (current: number, total: number) => void,
  delayMs = 100
): Promise<string[]> {
  const results: string[] = []

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]

    // Skip empty texts
    if (!text || text.trim().length === 0) {
      results.push('')
      continue
    }

    try {
      const translated = await translateWithGoogle(text, apiKey)
      results.push(translated)

      // Report progress
      if (onProgress) {
        onProgress(i + 1, texts.length)
      }

      // Add delay between requests (except for last one)
      if (i < texts.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    } catch (error) {
      console.error(`Translation failed for text ${i + 1}:`, error)
      throw error
    }
  }

  return results
}
