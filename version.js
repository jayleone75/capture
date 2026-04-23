// ============================================================================
// VERSION — single source of truth
// Bump this on every meaningful change. Used by:
//   - header display (visible to user)
//   - footer build date
//   - service worker cache name (forces refresh)
// ============================================================================

const APP_VERSION = {
  number: 'v2.4',
  date: '2026-04-22',
  label: 'stable — voice fix confirmed, debug code removed',
  changes: [
    'v2.4 (Apr 22) — Cleanup: removed debug logging, fixed baseline-to-dictation spacing. Voice confirmed working on Android Chrome.',
    'v2.3 (Apr 22) — Added voice debug log + keyboard-fallback voice mode',
    'v2.2 (Apr 22) — Fixed voice echo on mobile: dedup duplicate results',
    'v2.1 (Apr 22) — Visible version display, better PWA refresh',
    'v2.0 (Apr 22) — Fixed voice transcription echo on desktop, added Clear button',
    'v1.0 (Apr 22) — Initial release: capture, tag, review, export'
  ]
};

// Expose globally so both app.js and sw.js can read from the same source
if (typeof window !== 'undefined') {
  window.APP_VERSION = APP_VERSION;
}
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  // Service worker context
  self.APP_VERSION = APP_VERSION;
}
