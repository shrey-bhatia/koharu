/**
 * Multi-provider Translation API wrapper
 * Supports Google Cloud Translation, DeepL (Free and Pro), and Ollama
 * Uses REST API (no SDK needed) - works in browser/Tauri context
 */

export type TranslationProvider = 'google' | 'deepl-free' | 'deepl-pro' | 'ollama'

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
 * Translate text using DeepL API via Tauri backend
 * (DeepL blocks CORS, so we must use the native HTTP layer)
 *
 * @param text - Text to translate
 * @param apiKey - DeepL API key
 * @param usePro - Whether to use Pro endpoint (default: false for free tier)
 * @param sourceLang - Source language code (default: 'JA' for Japanese, null for auto-detect)
 * @param targetLang - Target language code (default: 'EN-US' recommended by DeepL)
 * @returns Translated text
 *
 * @throws TranslationAPIError on API errors (invalid key, rate limit, etc.)
 */
export async function translateWithDeepL(
  text: string,
  apiKey: string,
  usePro = false,
  sourceLang: string | null = 'JA',
  targetLang = 'EN-US'
): Promise<string> {
  if (!text || text.trim().length === 0) {
    return text
  }

  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('API key is required')
  }

  try {
    // Use Tauri command to bypass CORS restrictions
    const { invoke } = await import('@tauri-apps/api/core')

    const result = await invoke<string>('translate_with_deepl', {
      apiKey: apiKey.trim(),
      text,
      usePro,
      sourceLang,
      targetLang,
    })

    return result
  } catch (error) {
    // Tauri invoke errors come as strings
    if (typeof error === 'string') {
      // Parse known error patterns
      if (error.includes('Invalid API key') || error.includes('403') || error.includes('401')) {
        throw new TranslationAPIError({
          code: 403,
          message: 'Invalid API key or insufficient permissions',
          status: 'Forbidden',
        })
      } else if (error.includes('Rate limit') || error.includes('429')) {
        throw new TranslationAPIError({
          code: 429,
          message: 'Rate limit exceeded. Please wait and try again.',
          status: 'Too Many Requests',
        })
      } else if (error.includes('Quota exceeded') || error.includes('456')) {
        throw new TranslationAPIError({
          code: 456,
          message: 'Quota exceeded. For DeepL Free, you\'ve used your 500,000 character/month limit.',
          status: 'Quota Exceeded',
        })
      }

      throw new Error(`DeepL translation failed: ${error}`)
    }

    if (error instanceof Error) {
      throw new Error(`Translation failed: ${error.message}`)
    }

    throw new Error('Unknown translation error')
  }
}

/**
 * Translate text using Ollama via Tauri backend
 * Passes the Japanese text directly - system prompt is set in Ollama
 *
 * @param text - Text to translate (raw Japanese OCR output)
 * @param model - Ollama model name (optional, defaults to gemma2:2b)
 * @returns Translated text
 */
export async function translateWithOllama(
  text: string,
  model?: string
): Promise<string> {
  if (!text || text.trim().length === 0) {
    return text
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')

    const result = await invoke<string>('translate_with_ollama', {
      text,
      model: model || null,
    })

    return result
  } catch (error) {
    if (typeof error === 'string') {
      if (error.includes('Failed to connect to Ollama')) {
        throw new Error('Could not connect to Ollama. Make sure Ollama is running on http://localhost:11434')
      }
      throw new Error(`Ollama translation failed: ${error}`)
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
 * @param provider - Translation provider ('google', 'deepl-free', 'deepl-pro', or 'ollama')
 * @param apiKey - API key for the selected provider (not used for Ollama)
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
  if (provider === 'ollama') {
    // Ollama: Pass text directly, system prompt is already set
    return translateWithOllama(text)
  } else if (provider === 'deepl-free' || provider === 'deepl-pro') {
    // DeepL: Use EN-US as recommended by DeepL docs
    const usePro = provider === 'deepl-pro'
    const deeplTarget = targetLang.toLowerCase() === 'en' ? 'EN-US' : targetLang.toUpperCase()
    return translateWithDeepL(text, apiKey, usePro, sourceLang.toUpperCase(), deeplTarget)
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
