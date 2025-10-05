/**
 * Multi-provider Translation API wrapper
 * Supports Google Cloud Translation and DeepL
 * Uses REST API (no SDK needed) - works in browser/Tauri context
 */

export type TranslationProvider = 'google' | 'deepl'

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
 * Translate text using DeepL API
 *
 * @param text - Text to translate
 * @param apiKey - DeepL API key
 * @param sourceLang - Source language code (default: 'JA' for Japanese)
 * @param targetLang - Target language code (default: 'EN' for English)
 * @returns Translated text
 *
 * @throws TranslationAPIError on API errors (invalid key, rate limit, etc.)
 */
export async function translateWithDeepL(
  text: string,
  apiKey: string,
  sourceLang = 'JA',
  targetLang = 'EN'
): Promise<string> {
  if (!text || text.trim().length === 0) {
    return text
  }

  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('API key is required')
  }

  try {
    // DeepL uses different endpoints for free vs pro tier
    // Free tier endpoint: api-free.deepl.com
    const url = 'https://api-free.deepl.com/v2/translate'

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `DeepL-Auth-Key ${apiKey}`,
      },
      body: JSON.stringify({
        text: [text],
        source_lang: sourceLang.toUpperCase(),
        target_lang: targetLang.toUpperCase(),
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const errorMessage = errorData.message || `HTTP ${response.status}: ${response.statusText}`

      throw new TranslationAPIError({
        code: response.status,
        message: errorMessage,
        status: response.statusText,
      })
    }

    const data = await response.json()

    if (!data.translations?.[0]?.text) {
      throw new Error('Invalid API response format')
    }

    return data.translations[0].text
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
 * Unified translation function that routes to the correct provider
 *
 * @param text - Text to translate
 * @param provider - Translation provider ('google' or 'deepl')
 * @param apiKey - API key for the selected provider
 * @param sourceLang - Source language code
 * @param targetLang - Target language code
 * @returns Translated text
 */
export async function translate(
  text: string,
  provider: TranslationProvider,
  apiKey: string,
  sourceLang = 'ja',
  targetLang = 'en'
): Promise<string> {
  if (provider === 'deepl') {
    // DeepL uses uppercase language codes
    return translateWithDeepL(text, apiKey, sourceLang.toUpperCase(), targetLang.toUpperCase())
  } else {
    // Google uses lowercase language codes
    return translateWithGoogle(text, apiKey, sourceLang.toLowerCase(), targetLang.toLowerCase())
  }
}

/**
 * Test API key validity by attempting a simple translation
 *
 * @param apiKey - API key to test
 * @param provider - Translation provider
 * @returns true if valid, false otherwise
 */
export async function testApiKey(apiKey: string, provider: TranslationProvider): Promise<boolean> {
  try {
    await translate('テスト', provider, apiKey, 'ja', 'en')
    return true
  } catch (error) {
    console.error(`${provider} API key test failed:`, error)
    return false
  }
}

/**
 * Batch translate multiple texts with rate limiting
 * Adds delays between requests to avoid hitting rate limits
 *
 * @param texts - Array of texts to translate
 * @param provider - Translation provider
 * @param apiKey - API key for the selected provider
 * @param onProgress - Callback for progress updates (optional)
 * @param delayMs - Delay between requests in milliseconds (default: 100ms)
 */
export async function batchTranslate(
  texts: string[],
  provider: TranslationProvider,
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
      const translated = await translate(text, provider, apiKey)
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
