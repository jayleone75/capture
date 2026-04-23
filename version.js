// ============================================================================
// VERSION — single source of truth
// Bump this on every meaningful change. Used by:
//   - header display (visible to user)
//   - footer build date
//   - service worker cache name (forces refresh)
// ============================================================================

const APP_VERSION = {
  number: 'v2.5',
  date: '2026-04-22',
  label: 'extended listening — auto-restart through silence pauses',
  changes: [
    'v2.5 (Apr 22) — Mic now stays active through silence. Auto-restarts after Chrome shuts it off so you can pause and continue thinking. Tap mic again to actually stop.',
    'v2.4 (Apr 22) — Cleanup: removed debug logging, fixed baseline-to-dictation spacing',
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
