# Capture — Field Notes PWA

A capture-first note-taking PWA for catching thoughts on the go and shuffling them into Claude projects later.

**Live URL (once deployed):** `https://capture.jayleone.ai`

## What it does

- **Fast capture:** Tap the app icon, type or dictate a thought, tag it, save.
- **Primary + secondary tagging:** Pre-loaded with your accounts (EECU, SAFE, VSP, etc.), people (Kat Theole, Tim Redden, etc.), and personal projects (jayleone.ai, Furgone).
- **Offline-capable:** Notes save locally (IndexedDB), works without signal.
- **Installable:** Add to home screen on iOS/Android for one-tap launch.
- **Export briefs:** When you're back at your desk, review groups notes by tag — hit Copy or Download .md, paste into the relevant Claude Project.

## Deployment (one-time setup, ~10 minutes)

### 1. Create GitHub repo

```bash
# From your local machine
cd ~/code  # or wherever you keep projects
# Copy the capture-app folder from this session to your local machine
cd capture-app
git init
git add .
git commit -m "Initial Capture PWA"
gh repo create capture-app --public --source=. --push
# OR manually: create repo on github.com, then:
# git remote add origin https://github.com/YOUR_USERNAME/capture-app.git
# git push -u origin main
```

### 2. Enable GitHub Pages

- Go to repo → Settings → Pages
- Source: **Deploy from a branch**
- Branch: **main** · Folder: **/ (root)**
- Save. Site will publish at `https://YOUR_USERNAME.github.io/capture-app/`

### 3. Point Cloudflare DNS

In your Cloudflare dashboard for `jayleone.ai`:

- Add DNS record:
  - Type: **CNAME**
  - Name: **capture**
  - Target: **YOUR_USERNAME.github.io**
  - Proxy status: **DNS only** (gray cloud) — same pattern as your pet microsites
- Save

### 4. Set custom domain on GitHub

- Back in GitHub repo → Settings → Pages
- Custom domain: **capture.jayleone.ai**
- Check **Enforce HTTPS** (may take a few minutes to become available)

### 5. Install on iPhone

- Open **Safari** (must be Safari on iOS for PWA install to work)
- Navigate to `https://capture.jayleone.ai`
- Tap the **Share** button → **Add to Home Screen**
- Name it "Capture" → Add

You now have a one-tap app icon on your home screen.

### 6. Set up Siri Shortcut (iOS)

- Open the **Shortcuts** app
- Tap **+** to create new shortcut
- Add action: **Open URL**
- URL: `https://capture.jayleone.ai`
- Rename shortcut to "Capture Note"
- Tap settings (top right) → **Add to Siri** → record phrase like "Capture note" or "Open capture"

Now you can say **"Hey Siri, capture note"** while driving and the app launches hands-free. Combined with iOS keyboard dictation (tap the mic on the keyboard), you get the full voice workflow.

## Customizing your tag library

Edit `TAG_LIBRARY` at the top of `app.js`:

```javascript
const TAG_LIBRARY = {
  account: [ 'EECU', 'SAFE Credit Union', ... ],
  people: [ 'Kat Theole', ... ],
  personal: [ 'jayleone.ai', ... ]
};
```

Commit and push — GitHub Pages redeploys in a minute or two. Refresh the installed PWA to pick up changes (service worker updates next time you open it).

## File structure

```
capture-app/
├── index.html          # App shell
├── styles.css          # Field notebook aesthetic
├── app.js              # Main logic, tagging, storage, export
├── sw.js               # Service worker (offline)
├── manifest.json       # PWA manifest
└── icons/
    ├── icon.svg
    ├── icon-192.png
    ├── icon-512.png
    ├── icon-maskable-512.png
    └── favicon-64.png
```

## Roadmap

- **Phase 2 (next session):** AI tag suggestions using your Anthropic API key (stored locally, never transmitted elsewhere).
- **Phase 3 (when Phase 1+2 are proven):** Cloudflare Worker for scheduled 6pm daily email digest.

## Troubleshooting

**Mic button doesn't work**
- Voice requires HTTPS — should work once deployed to `capture.jayleone.ai`.
- iOS: Web Speech API support in Safari is inconsistent. The reliable path on iPhone is to tap the textarea and use the keyboard's mic button (system-level dictation).
- Android: Should work in Chrome.

**Notes disappeared**
- Notes are stored in the browser's IndexedDB, scoped to the domain. Clearing browser data or uninstalling the PWA will wipe them. Use the Download .md feature periodically as backup.

**Icon looks wrong on home screen**
- iOS sometimes caches the old favicon. Force-refresh: delete the home screen icon, clear Safari cache, re-add.

## License

Personal project. Do whatever.
