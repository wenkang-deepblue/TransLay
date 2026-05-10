// API base URL — production domain, Portal and API co-located
var API_BASE_URL = 'https://your-domain.example.com/api';
var PORTAL_BASE_URL = 'https://your-domain.example.com';

// Entitlement cache TTL (seconds) — frozen decision
var ENTITLEMENT_CACHE_TTL = 300;

// Job polling interval (ms)
var JOB_POLL_INTERVAL_MS = 3000;

// Preset languages — UI displays name only, never the code
var PRESET_LANGUAGES = [
  { name: 'English', code: 'en' },
  { name: 'Portuguese', code: 'pt' },
  { name: 'Spanish', code: 'es' },
  { name: 'French', code: 'fr' },
  { name: 'German', code: 'de' },
  { name: 'Italian', code: 'it' },
  { name: 'Dutch', code: 'nl' },
  { name: 'Swedish', code: 'sv' },
  { name: 'Russian', code: 'ru' },
  { name: 'Arabic', code: 'ar' },
  { name: 'Greek', code: 'el' },
  { name: 'Hebrew', code: 'he' },
  { name: 'Simplified Chinese', code: 'zh-Hans' },
  { name: 'Traditional Chinese', code: 'zh-Hant' },
  { name: 'Japanese', code: 'ja' },
  { name: 'Korean', code: 'ko' },
  { name: 'Klingon', code: 'tlh' }
];

// Host types
var HOST_TYPE_SLIDES = 'slides';
var HOST_TYPE_DOCS = 'docs';
var HOST_TYPE_SHEETS = 'sheets';

// Supported host types for MVP (only Slides)
var SUPPORTED_HOST_TYPES = [HOST_TYPE_SLIDES];
