// Default server configuration
const KOHARU_DEFAULT_PORT = 19284;
const KOHARU_DEFAULT_HOST = '127.0.0.1';
const KOHARU_VERSION = '0.1.0';

// CSS class marker for ViolentMonkey/Greasemonkey scripts
// Add this class to any <img> element to mark it for translation
const KOHARU_TRANSLATE_CLASS = 'koharu-translate';

// Minimum image dimensions to consider for translation
const MIN_IMAGE_WIDTH = 100;
const MIN_IMAGE_HEIGHT = 100;

// Cache settings
const MAX_CACHE_SIZE = 200; // Maximum number of cached translations

// Health check interval (ms)
const HEALTH_CHECK_INTERVAL = 30000;

function getServerUrl(port) {
  return `http://${KOHARU_DEFAULT_HOST}:${port || KOHARU_DEFAULT_PORT}`;
}
