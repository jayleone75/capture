// ============================================================================
// Capture — Field Notes PWA
// Phase 1: capture, tag, review, export
// ============================================================================

// Pre-loaded tag taxonomy — edit TAG_LIBRARY to customize
const TAG_LIBRARY = {
  account: [
    'EECU', 'SAFE Credit Union', 'VSP', 'Save Mart', 'Community Health Fresno',
    'Adventist Health', 'Cal OES', 'CDCR', 'CAL FIRE', 'Dept of Consumer Affairs',
    'CA Parks & Rec', 'ePlus', 'Intersis 360'
  ],
  people: [
    'Kat Theole', 'Tim Redden', 'ExaGrid team', 'Rubrik contact', 'Veeam contact'
  ],
  personal: [
    'jayleone.ai', 'Furgone Avventura', 'IronLog', 'SiteBuilder',
    'Resume/Career', 'Pets', 'Home'
  ]
};

const CATEGORY_LABELS = {
  account: 'ACCOUNTS',
  people: 'PEOPLE',
  personal: 'PERSONAL',
  custom: 'CUSTOM'
};

// ============================================================================
// State
// ============================================================================

let state = {
  notes: [],
  currentText: '',
  primaryTag: null,        // { category, name }
  secondaryTags: [],       // [{ category, name }]
  customTags: [],          // user-created tag names (persist across sessions)
  isListening: false,
  view: 'capture',         // 'capture' | 'review'
  filterTag: null,
  searchQuery: ''
};

let recognition = null;
let deferredInstallPrompt = null;

// ============================================================================
// IndexedDB setup
// ============================================================================

const DB_NAME = 'capture_app_db';
const DB_VERSION = 1;
const STORE_NOTES = 'notes';
const STORE_META = 'meta';

let dbInstance = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance) return resolve(dbInstance);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NOTES)) {
        const store = db.createObjectStore(STORE_NOTES, { keyPath: 'id' });
        store.createIndex('created', 'created', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { dbInstance = req.result; resolve(dbInstance); };
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbGetMeta(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const req = tx.objectStore(STORE_META).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

async function dbSetMeta(key, value) {
  return dbPut(STORE_META, { key, value });
}

// ============================================================================
// Initialization
// ============================================================================

async function init() {
  // Render version info immediately so user sees what build they're on
  renderVersionInfo();

  // Load persisted data
  try {
    const notes = await dbGetAll(STORE_NOTES);
    state.notes = notes.sort((a, b) => new Date(b.created) - new Date(a.created));
    const customTags = await dbGetMeta('customTags');
    if (customTags) state.customTags = customTags;
  } catch (e) {
    console.error('Load failed:', e);
  }

  // Setup speech recognition if available
  setupSpeechRecognition();

  // Wire up UI
  wireEventListeners();

  // Render everything
  renderAll();

  // Listen for install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    maybeShowInstallPrompt();
  });
}

// Debug log for speech recognition — viewable via footer version button
let speechDebugLog = [];

function logSpeechEvent(entry) {
  const timestamp = new Date().toISOString().slice(11, 23);
  speechDebugLog.push(`[${timestamp}] ${entry}`);
  // Keep last 100 entries
  if (speechDebugLog.length > 100) speechDebugLog.shift();
}

function setupSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  // State held across onresult events for this recording session.
  let baseline = '';
  let committedChunks = [];      // ordered list of finalized phrases we've accepted
  let processedResultIds = new Set(); // dedup by result identity

  recognition.onstart = () => {
    baseline = (state.currentText || '').replace(/\s*\[listening\.\.\.\].*$/, '').trim();
    committedChunks = [];
    processedResultIds = new Set();
    speechDebugLog = [];
    logSpeechEvent(`START — baseline: "${baseline}"`);
  };

  recognition.onresult = (event) => {
    let latestInterim = '';

    // Log raw event data for diagnostics
    const resultSummary = [];
    for (let i = 0; i < event.results.length; i++) {
      const r = event.results[i];
      resultSummary.push(`[${i}]${r.isFinal?'F':'i'}:"${r[0].transcript.trim()}"`);
    }
    logSpeechEvent(`onresult (resultIndex=${event.resultIndex}, len=${event.results.length}): ${resultSummary.join(' ')}`);

    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript.trim();
      if (!transcript) continue;

      if (result.isFinal) {
        // Build a unique-ish identifier combining index AND the transcript text.
        // If Chrome re-emits the same text at the same index, this will be seen.
        // If it re-emits at a DIFFERENT index, we still catch it via the text match below.
        const resultId = `${i}:${transcript.toLowerCase()}`;

        if (processedResultIds.has(resultId)) {
          logSpeechEvent(`  SKIP (already processed id=${resultId})`);
          continue;
        }

        // Also check: is this text already in committed chunks? Exact match = duplicate.
        const tLower = transcript.toLowerCase();
        const alreadyCommitted = committedChunks.some(c => c.toLowerCase() === tLower);
        if (alreadyCommitted) {
          logSpeechEvent(`  SKIP (text already committed: "${transcript}")`);
          processedResultIds.add(resultId);
          continue;
        }

        // Check: is this text a prefix/suffix of something we committed? Likely duplicate growth.
        const lastCommitted = committedChunks[committedChunks.length - 1] || '';
        const lLower = lastCommitted.toLowerCase();
        if (lLower && tLower !== lLower) {
          // If new text starts with last committed OR last committed starts with new text,
          // it's probably the same phrase at a different completion stage.
          if (tLower.startsWith(lLower) && tLower.length > lLower.length) {
            // Extend the last chunk — replace it with the longer version
            logSpeechEvent(`  EXTEND ("${lastCommitted}" -> "${transcript}")`);
            committedChunks[committedChunks.length - 1] = transcript;
            processedResultIds.add(resultId);
            continue;
          }
          if (lLower.startsWith(tLower)) {
            // New text is a prefix of what we already have — skip
            logSpeechEvent(`  SKIP (prefix of existing)`);
            processedResultIds.add(resultId);
            continue;
          }
        }

        // Genuinely new chunk — commit it
        committedChunks.push(transcript);
        processedResultIds.add(resultId);
        logSpeechEvent(`  COMMIT ("${transcript}")`);
      } else {
        latestInterim = transcript;
      }
    }

    // Build display text from components — never append, always rebuild.
    const finalText = committedChunks.join(' ');
    const separator = baseline && !baseline.endsWith(' ') ? ' ' : '';
    const committed = (baseline + separator + finalText).trim();

    let displayText;
    if (latestInterim) {
      const interimSep = committed && !committed.endsWith(' ') ? ' ' : '';
      displayText = committed + interimSep + `[listening...] ${latestInterim}`;
    } else {
      displayText = committed;
    }

    state.currentText = displayText;
    document.getElementById('note-input').value = displayText;
    updateSaveButton();
  };

  recognition.onend = () => {
    state.isListening = false;
    const clean = state.currentText.replace(/\s*\[listening\.\.\.\].*$/, '').trim();
    state.currentText = clean;
    document.getElementById('note-input').value = clean;
    logSpeechEvent(`END — final text: "${clean}"`);
    baseline = '';
    committedChunks = [];
    processedResultIds = new Set();
    updateMicUI();
    updateSaveButton();
  };

  recognition.onerror = (e) => {
    state.isListening = false;
    updateMicUI();
    logSpeechEvent(`ERROR: ${e.error}`);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast('Mic permission denied. Check browser settings.');
    } else if (e.error === 'no-speech') {
      // Silent
    } else if (e.error !== 'aborted') {
      toast('Voice error: ' + e.error);
    }
  };
}

// ============================================================================
// Event wiring
// ============================================================================

function wireEventListeners() {
  // View toggle
  document.querySelectorAll('.view-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.view = btn.dataset.view;
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById(state.view + '-view').classList.add('active');
      renderAll();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // Note input
  const noteInput = document.getElementById('note-input');
  noteInput.addEventListener('input', (e) => {
    state.currentText = e.target.value;
    updateSaveButton();
  });

  // Mic button
  document.getElementById('mic-btn').addEventListener('click', toggleListening);

  // Clear button — wipes the textarea, works whether or not mic is recording
  document.getElementById('clear-btn').addEventListener('click', clearInput);

  // Save button
  document.getElementById('save-btn').addEventListener('click', saveNote);

  // Custom tag UI
  document.getElementById('add-custom-btn').addEventListener('click', () => {
    document.getElementById('custom-add-inline').classList.add('hidden');
    document.getElementById('custom-input-row').classList.remove('hidden');
    document.getElementById('custom-input').focus();
  });

  document.getElementById('custom-confirm').addEventListener('click', addCustomTag);
  document.getElementById('custom-cancel').addEventListener('click', cancelCustomTag);
  document.getElementById('custom-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addCustomTag(); }
    if (e.key === 'Escape') cancelCustomTag();
  });

  // View-all button
  document.getElementById('view-all-btn').addEventListener('click', () => {
    document.querySelector('[data-view="review"]').click();
  });

  // Search
  document.getElementById('search-input').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderReview();
  });

  // Install prompt buttons
  document.getElementById('install-dismiss').addEventListener('click', () => {
    dbSetMeta('installPromptDismissed', Date.now());
    document.getElementById('install-prompt').classList.add('hidden');
  });
  document.getElementById('install-confirm').addEventListener('click', async () => {
    document.getElementById('install-prompt').classList.add('hidden');
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const result = await deferredInstallPrompt.userChoice;
      if (result.outcome === 'accepted') {
        dbSetMeta('installed', true);
      }
      deferredInstallPrompt = null;
    }
  });
}

// ============================================================================
// Actions
// ============================================================================

function renderVersionInfo() {
  const v = window.APP_VERSION;
  if (!v) return;
  const label = document.getElementById('version-label');
  if (label) label.textContent = v.number;
  const build = document.getElementById('build-info');
  if (build) {
    build.innerHTML = `<button class="version-btn" id="version-btn">${v.number} · ${v.date}</button>`;
    document.getElementById('version-btn').addEventListener('click', showChangelog);
  }
}

function showChangelog() {
  const v = window.APP_VERSION;
  if (!v) return;

  const voiceMode = localStorage.getItem('voiceMode') || 'auto';
  const modeLabel = voiceMode === 'keyboard' ? 'Keyboard mic (Gboard)' : 'Web Speech API (auto)';

  const changelogText = v.changes.join('\n\n');
  const debugText = speechDebugLog.length > 0
    ? '\n\n─── LAST VOICE SESSION LOG ───\n' + speechDebugLog.join('\n')
    : '\n\n(No voice session logged yet — record something, then come back here.)';

  const fullText =
    `Capture ${v.number} · ${v.date}\n\n` +
    `Voice mode: ${modeLabel}\n\n` +
    `─── CHANGELOG ───\n${changelogText}` +
    debugText;

  // Use a prompt-style dialog so user can copy the text. Fallback to alert.
  const choice = confirm(
    fullText +
    '\n\n─────────\n' +
    'OK: close\n' +
    'Cancel: show options menu'
  );

  if (!choice) {
    showOptionsMenu();
  }
}

function showOptionsMenu() {
  const current = localStorage.getItem('voiceMode') || 'auto';
  const options =
    'Options:\n\n' +
    '1 — Switch voice mode (current: ' + (current === 'keyboard' ? 'keyboard mic' : 'Web Speech') + ')\n' +
    '2 — Force refresh (nuke cache, reload fresh)\n' +
    '3 — Copy debug log to clipboard\n\n' +
    'Type 1, 2, or 3:';

  const input = prompt(options, '');
  if (input === '1') {
    const newMode = current === 'keyboard' ? 'auto' : 'keyboard';
    localStorage.setItem('voiceMode', newMode);
    alert(`Voice mode set to: ${newMode === 'keyboard' ? 'Keyboard mic (Gboard)' : 'Web Speech API'}\n\nReload to apply.`);
    window.location.reload();
  } else if (input === '2') {
    forceRefresh();
  } else if (input === '3') {
    const log = speechDebugLog.join('\n') || '(empty)';
    navigator.clipboard.writeText(log).then(() => {
      alert('Debug log copied to clipboard. Paste it into Claude chat.');
    }).catch(() => {
      // Fallback — show in a prompt so user can manually copy
      prompt('Copy this debug log:', log);
    });
  }
}

async function forceRefresh() {
  try {
    // Unregister all service workers
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    // Delete all caches
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    }
    // Hard reload
    window.location.reload();
  } catch (e) {
    alert('Refresh failed: ' + e.message);
    window.location.reload();
  }
}

function clearInput() {
  // Stop recording if active — clean slate
  if (state.isListening && recognition) {
    try { recognition.stop(); } catch (e) {}
  }
  state.currentText = '';
  document.getElementById('note-input').value = '';
  updateSaveButton();
  // Refocus so user can immediately start typing or tap mic again
  document.getElementById('note-input').focus();
}

function toggleListening() {
  // Check voice mode preference
  const voiceMode = localStorage.getItem('voiceMode') || 'auto';

  if (voiceMode === 'keyboard') {
    // Keyboard mode: just focus the textarea so user can tap Gboard's mic
    const textarea = document.getElementById('note-input');
    textarea.focus();
    // Position cursor at end
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    toast('Tap the mic on your keyboard');
    return;
  }

  if (!recognition) {
    toast('Voice not supported. Tap the textarea and use your keyboard\'s mic.');
    // Auto-focus textarea as fallback
    document.getElementById('note-input').focus();
    return;
  }
  if (state.isListening) {
    recognition.stop();
  } else {
    state.isListening = true;
    updateMicUI();
    try {
      recognition.start();
    } catch (e) {
      state.isListening = false;
      updateMicUI();
    }
  }
}

async function saveNote() {
  const text = state.currentText.replace(/\s*\[listening\.\.\.\].*$/, '').trim();
  if (!text) return;

  const note = {
    id: Date.now().toString() + '_' + Math.random().toString(36).slice(2, 8),
    text,
    primaryTag: state.primaryTag,
    secondaryTags: state.secondaryTags,
    created: new Date().toISOString()
  };

  try {
    await dbPut(STORE_NOTES, note);
    state.notes.unshift(note);
    state.currentText = '';
    state.primaryTag = null;
    state.secondaryTags = [];
    document.getElementById('note-input').value = '';
    if (state.isListening && recognition) recognition.stop();
    renderAll();
    toast('Note saved');
  } catch (e) {
    toast('Save failed');
    console.error(e);
  }
}

async function deleteNote(id) {
  try {
    await dbDelete(STORE_NOTES, id);
    state.notes = state.notes.filter(n => n.id !== id);
    renderAll();
    toast('Deleted');
  } catch (e) {
    toast('Delete failed');
  }
}

async function addCustomTag() {
  const input = document.getElementById('custom-input');
  const name = input.value.trim();
  if (!name) return;

  // Add to custom tag library if new
  if (!state.customTags.includes(name)) {
    state.customTags.push(name);
    await dbSetMeta('customTags', state.customTags);
  }

  // Select it appropriately
  if (!state.primaryTag) {
    state.primaryTag = { category: 'custom', name };
  } else {
    // Add as secondary if not already selected
    const exists = state.secondaryTags.some(t => t.category === 'custom' && t.name === name);
    if (!exists) state.secondaryTags.push({ category: 'custom', name });
  }

  input.value = '';
  document.getElementById('custom-input-row').classList.add('hidden');
  document.getElementById('custom-add-inline').classList.remove('hidden');
  renderTags();
}

function cancelCustomTag() {
  document.getElementById('custom-input').value = '';
  document.getElementById('custom-input-row').classList.add('hidden');
  document.getElementById('custom-add-inline').classList.remove('hidden');
}

function toggleTag(category, name) {
  // Is this the primary tag?
  if (state.primaryTag && state.primaryTag.category === category && state.primaryTag.name === name) {
    // Deselect primary; promote first secondary to primary if any
    if (state.secondaryTags.length > 0) {
      state.primaryTag = state.secondaryTags.shift();
    } else {
      state.primaryTag = null;
    }
    renderTags();
    return;
  }

  // Is this a secondary tag?
  const secIdx = state.secondaryTags.findIndex(t => t.category === category && t.name === name);
  if (secIdx !== -1) {
    state.secondaryTags.splice(secIdx, 1);
    renderTags();
    return;
  }

  // Not selected — add as primary if no primary, else as secondary
  if (!state.primaryTag) {
    state.primaryTag = { category, name };
  } else {
    state.secondaryTags.push({ category, name });
  }
  renderTags();
}

// ============================================================================
// Export / briefs
// ============================================================================

function formatFullTimestamp(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

function generateBriefForTag(tagKey) {
  const [, name] = tagKey.split('::');
  const tagNotes = getNotesForTagKey(tagKey);
  const header = `# Captured Notes — ${name}\n*${tagNotes.length} note${tagNotes.length !== 1 ? 's' : ''} · exported ${new Date().toLocaleString()}*\n\n`;
  const body = tagNotes.map((n) => {
    const allTags = [];
    if (n.primaryTag) allTags.push(n.primaryTag.name);
    if (n.secondaryTags) n.secondaryTags.forEach(t => { if (t.name !== name) allTags.push(t.name); });
    const tagLine = allTags.length > 1 ? ` · also tagged: ${allTags.filter(t => t !== name).join(', ')}` : '';
    return `**${formatFullTimestamp(n.created)}**${tagLine}\n${n.text}\n`;
  }).join('\n---\n\n');
  return header + body;
}

function getNotesForTagKey(tagKey) {
  const [category, name] = tagKey.split('::');
  if (category === 'untagged') {
    return state.notes.filter(n => !n.primaryTag);
  }
  return state.notes.filter(n => {
    if (n.primaryTag && n.primaryTag.category === category && n.primaryTag.name === name) return true;
    if (n.secondaryTags && n.secondaryTags.some(t => t.category === category && t.name === name)) return true;
    return false;
  });
}

async function copyBrief(tagKey) {
  const text = generateBriefForTag(tagKey);
  try {
    await navigator.clipboard.writeText(text);
    toast('Brief copied');
  } catch (e) {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('Brief copied');
  }
}

function downloadBrief(tagKey) {
  const [, name] = tagKey.split('::');
  const text = generateBriefForTag(tagKey);
  const filename = `notes-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().split('T')[0]}.md`;
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyNote(id) {
  const note = state.notes.find(n => n.id === id);
  if (!note) return;
  try {
    await navigator.clipboard.writeText(note.text);
    toast('Copied');
  } catch (e) {
    toast('Copy failed');
  }
}

// ============================================================================
// Rendering
// ============================================================================

function renderAll() {
  renderNoteCount();
  renderTags();
  updateSaveButton();
  renderRecent();
  renderReview();
}

function renderNoteCount() {
  const badge = document.getElementById('note-count-badge');
  badge.textContent = state.notes.length > 0 ? state.notes.length : '';
}

function renderTags() {
  renderPrimaryTagSection();
  renderSecondaryTagSection();
  renderCustomTagSection();
}

function makeTagChip(category, name, options = {}) {
  const chip = document.createElement('span');
  chip.className = `tag-chip ${category}`;
  if (options.primarySelected) chip.classList.add('primary-selected');
  if (options.secondarySelected) chip.classList.add('secondary-selected');
  if (options.dashed) chip.classList.add('dashed');
  chip.textContent = name;
  if (options.onClick) chip.addEventListener('click', options.onClick);
  return chip;
}

function renderPrimaryTagSection() {
  const container = document.getElementById('primary-tags');
  container.innerHTML = '';

  Object.entries(TAG_LIBRARY).forEach(([category, tags]) => {
    const block = document.createElement('div');
    block.className = 'tag-category';

    const label = document.createElement('div');
    label.className = 'tag-category-label';
    label.style.color = `var(--tag-${category}-fg)`;
    label.textContent = CATEGORY_LABELS[category] || category.toUpperCase();
    block.appendChild(label);

    const row = document.createElement('div');
    row.className = 'tag-row';

    tags.forEach((name) => {
      const isPrimary = state.primaryTag && state.primaryTag.category === category && state.primaryTag.name === name;
      const isSecondary = state.secondaryTags.some(t => t.category === category && t.name === name);
      const chip = makeTagChip(category, name, {
        primarySelected: isPrimary,
        secondarySelected: isSecondary,
        onClick: () => toggleTag(category, name)
      });
      row.appendChild(chip);
    });

    block.appendChild(row);
    container.appendChild(block);
  });
}

function renderSecondaryTagSection() {
  // Just shows a hint based on primary state
  const hint = document.getElementById('secondary-hint');
  if (!state.primaryTag) {
    hint.textContent = 'Select a primary tag above first, then tap more tags to add as secondary.';
    hint.classList.remove('hidden');
  } else {
    hint.textContent = `Primary: ${state.primaryTag.name}. Tap other tags above to add as secondary.`;
    hint.classList.remove('hidden');
  }
}

function renderCustomTagSection() {
  const container = document.getElementById('custom-display');
  container.innerHTML = '';

  const row = document.createElement('div');
  row.className = 'tag-row';

  state.customTags.forEach((name) => {
    const isPrimary = state.primaryTag && state.primaryTag.category === 'custom' && state.primaryTag.name === name;
    const isSecondary = state.secondaryTags.some(t => t.category === 'custom' && t.name === name);
    const chip = makeTagChip('custom', name, {
      primarySelected: isPrimary,
      secondarySelected: isSecondary,
      onClick: () => toggleTag('custom', name)
    });
    row.appendChild(chip);
  });

  container.appendChild(row);
}

function updateSaveButton() {
  const btn = document.getElementById('save-btn');
  const clearBtn = document.getElementById('clear-btn');
  const text = state.currentText.replace(/\s*\[listening\.\.\.\].*$/, '').trim();
  btn.disabled = !text;
  // Show clear button whenever there's any text (including interim "listening..." content)
  const hasAnyContent = (state.currentText || '').trim().length > 0;
  if (hasAnyContent) {
    clearBtn.classList.remove('hidden');
  } else {
    clearBtn.classList.add('hidden');
  }
}

function updateMicUI() {
  const btn = document.getElementById('mic-btn');
  const indicator = document.getElementById('recording-indicator');
  if (state.isListening) {
    btn.classList.add('listening');
    indicator.classList.remove('hidden');
  } else {
    btn.classList.remove('listening');
    indicator.classList.add('hidden');
  }
}

function formatTimestamp(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderRecent() {
  const preview = document.getElementById('recent-preview');
  const list = document.getElementById('recent-list');
  const viewAllBtn = document.getElementById('view-all-btn');

  if (state.notes.length === 0) {
    preview.classList.add('hidden');
    return;
  }

  preview.classList.remove('hidden');
  list.innerHTML = '';

  const recent = state.notes.slice(0, 3);
  recent.forEach(note => list.appendChild(buildNoteCard(note, { compact: true })));

  if (state.notes.length > 3) {
    viewAllBtn.textContent = `View all ${state.notes.length} notes →`;
    viewAllBtn.classList.remove('hidden');
  } else {
    viewAllBtn.classList.add('hidden');
  }
}

function buildNoteCard(note, opts = {}) {
  const card = document.createElement('div');
  card.className = 'note-card';

  const meta = document.createElement('div');
  meta.className = 'note-meta';

  const ts = document.createElement('div');
  ts.className = 'note-timestamp';
  ts.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ${opts.compact ? formatTimestamp(note.created) : formatFullTimestamp(note.created)}`;
  meta.appendChild(ts);

  const tagsWrap = document.createElement('div');
  tagsWrap.className = 'note-tags';

  if (note.primaryTag) {
    const primaryChip = makeTagChip(note.primaryTag.category, note.primaryTag.name, {
      onClick: () => { state.filterTag = note.primaryTag; renderReview(); window.scrollTo({top:0,behavior:'smooth'}); }
    });
    tagsWrap.appendChild(primaryChip);
  }
  if (note.secondaryTags && note.secondaryTags.length > 0) {
    note.secondaryTags.forEach(t => {
      const chip = makeTagChip(t.category, t.name, {
        onClick: () => { state.filterTag = t; renderReview(); window.scrollTo({top:0,behavior:'smooth'}); }
      });
      chip.style.opacity = '0.75';
      tagsWrap.appendChild(chip);
    });
  }

  if (tagsWrap.children.length > 0) meta.appendChild(tagsWrap);
  card.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'note-body';
  body.textContent = note.text;
  card.appendChild(body);

  if (!opts.compact) {
    const actions = document.createElement('div');
    actions.className = 'note-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'action-btn';
    copyBtn.innerHTML = '⎘ Copy';
    copyBtn.addEventListener('click', () => copyNote(note.id));
    actions.appendChild(copyBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'action-btn danger';
    delBtn.innerHTML = '🗑';
    delBtn.addEventListener('click', () => {
      if (confirm('Delete this note?')) deleteNote(note.id);
    });
    actions.appendChild(delBtn);

    card.appendChild(actions);
  }

  return card;
}

function renderReview() {
  const empty = document.getElementById('review-empty');
  const content = document.getElementById('review-content');

  if (state.notes.length === 0) {
    empty.classList.remove('hidden');
    content.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  content.classList.remove('hidden');

  // Active filter display
  const filterEl = document.getElementById('active-filter');
  if (state.filterTag) {
    filterEl.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'active-filter-label';
    label.textContent = 'FILTER:';
    filterEl.appendChild(label);
    const chip = makeTagChip(state.filterTag.category, state.filterTag.name + ' ✕', {
      onClick: () => { state.filterTag = null; renderReview(); }
    });
    filterEl.appendChild(chip);
    filterEl.classList.remove('hidden');
  } else {
    filterEl.classList.add('hidden');
  }

  // Brief export cards (only when no filter/search)
  const briefSection = document.getElementById('brief-export-section');
  const briefList = document.getElementById('brief-list');
  briefList.innerHTML = '';

  if (!state.filterTag && !state.searchQuery) {
    const notesByTag = {};
    state.notes.forEach(n => {
      // Each note contributes to ALL its tags (primary + secondary)
      const allTags = [];
      if (n.primaryTag) allTags.push(n.primaryTag);
      if (n.secondaryTags) allTags.push(...n.secondaryTags);
      if (allTags.length === 0) allTags.push({ category: 'untagged', name: 'Untagged' });
      allTags.forEach(t => {
        const key = `${t.category}::${t.name}`;
        if (!notesByTag[key]) notesByTag[key] = { count: 0, tag: t };
        notesByTag[key].count++;
      });
    });

    const sorted = Object.entries(notesByTag).sort((a, b) => b[1].count - a[1].count);

    if (sorted.length > 0) {
      briefSection.classList.remove('hidden');
      sorted.forEach(([key, data]) => {
        const card = document.createElement('div');
        card.className = 'brief-card';

        const row = document.createElement('div');
        row.className = 'brief-card-row';

        const info = document.createElement('div');
        info.className = 'brief-card-info';

        const chipCategory = data.tag.category === 'untagged' ? 'custom' : data.tag.category;
        const chip = makeTagChip(chipCategory, data.tag.name, {
          onClick: () => { state.filterTag = data.tag; renderReview(); }
        });
        info.appendChild(chip);

        const count = document.createElement('span');
        count.className = 'brief-card-count';
        count.textContent = `${data.count} note${data.count !== 1 ? 's' : ''}`;
        info.appendChild(count);

        row.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'brief-card-actions';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'action-btn';
        copyBtn.innerHTML = '⎘ Copy';
        copyBtn.addEventListener('click', () => copyBrief(key));
        actions.appendChild(copyBtn);

        const dlBtn = document.createElement('button');
        dlBtn.className = 'action-btn';
        dlBtn.innerHTML = '↓ .md';
        dlBtn.addEventListener('click', () => downloadBrief(key));
        actions.appendChild(dlBtn);

        row.appendChild(actions);
        card.appendChild(row);
        briefList.appendChild(card);
      });
    } else {
      briefSection.classList.add('hidden');
    }
  } else {
    briefSection.classList.add('hidden');
  }

  // Filtered notes list
  const filtered = state.notes.filter(n => {
    if (state.filterTag) {
      const matchesPrimary = n.primaryTag && n.primaryTag.category === state.filterTag.category && n.primaryTag.name === state.filterTag.name;
      const matchesSecondary = n.secondaryTags && n.secondaryTags.some(t => t.category === state.filterTag.category && t.name === state.filterTag.name);
      if (!matchesPrimary && !matchesSecondary) return false;
    }
    if (state.searchQuery) {
      if (!n.text.toLowerCase().includes(state.searchQuery.toLowerCase())) return false;
    }
    return true;
  });

  const listLabel = document.getElementById('notes-list-label');
  const isFiltered = state.filterTag || state.searchQuery;
  listLabel.textContent = `${filtered.length} note${filtered.length !== 1 ? 's' : ''}${isFiltered ? ' (filtered)' : ''}`;

  const notesList = document.getElementById('notes-list');
  notesList.innerHTML = '';
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No notes match your filter.';
    notesList.appendChild(empty);
  } else {
    filtered.forEach(n => notesList.appendChild(buildNoteCard(n, { compact: false })));
  }
}

// ============================================================================
// Toast
// ============================================================================

let toastTimer = null;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('visible'));
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.classList.add('hidden'), 300);
  }, 2000);
}

// ============================================================================
// Install prompt
// ============================================================================

async function maybeShowInstallPrompt() {
  if (!deferredInstallPrompt) return;
  const installed = await dbGetMeta('installed');
  if (installed) return;
  const dismissed = await dbGetMeta('installPromptDismissed');
  if (dismissed && Date.now() - dismissed < 7 * 24 * 60 * 60 * 1000) return;

  // Only show after user has captured at least one note
  if (state.notes.length >= 1) {
    document.getElementById('install-prompt').classList.remove('hidden');
  }
}

// ============================================================================
// Go
// ============================================================================

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
