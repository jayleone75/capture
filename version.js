// ============================================================================
// VERSION — single source of truth
// Bump this on every meaningful change. Used by:
//   - header display (visible to user)
//   - footer build date
//   - service worker cache name (forces refresh)
// ============================================================================

const APP_VERSION = {
  number: 'v2.2',
  date: '2026-04-22',
  label: 'mobile voice echo fix (Android Chrome)',
  changes: [
    'v2.2 (Apr 22) — Fixed voice echo on mobile Chrome/Android: dedup against duplicate finalized results',
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
