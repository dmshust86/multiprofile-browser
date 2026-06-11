# Partitions

A multi-profile macOS desktop browser built on Electron + Chromium. Each saved profile runs in a truly separate persistent Chromium session — cookies, cache, localStorage, IndexedDB, service workers, login state, permissions, history, and downloads never collide between profiles. Think Chrome Profiles, with a cleaner dashboard and faster multi-profile management.

This is a browser only. It uses normal Chromium behavior, the standard Chrome user-agent string for the bundled Chromium version, and standard browser networking. There is no automation, scraping, fingerprint manipulation, or anti-detection tooling of any kind.

---

## 1. How profile isolation works

This is the core design requirement, so it's worth being explicit.

**Each profile maps to its own persistent Chromium storage partition, which is a real, separate directory on disk.**

- When a profile is created, it gets a UUID. Its session is created with
  `session.fromPartition('persist:profile-<uuid>')`.
- Electron/Chromium stores all data for a `persist:` partition in its own
  directory: `~/Library/Application Support/Partitions/Partitions/profile-<uuid>/`.
  That directory contains the profile's own `Cookies`, `Cache`, `Local Storage`,
  `IndexedDB`, `Service Worker`, `Network` state, and permission data —
  the same on-disk layout as a standalone Chromium user-data directory.
- Every tab in a profile window is a `WebContentsView` created with that
  partition, so all network requests, storage reads/writes, and service-worker
  registrations resolve against that profile's directory and nothing else.
- Closing one profile window has zero effect on any other profile. Profiles
  stay logged in independently and persist across app restarts.
- **Temporary sessions** use `session.fromPartition('temp-<uuid>')` — note the
  missing `persist:` prefix. Chromium treats these as in-memory partitions.
  On close, the app additionally calls `clearStorageData()` and discards the
  session, so nothing survives.

Because the app ships a current Electron release, it ships the current stable
Chromium that release embeds — modern consumer and account-based web apps
(Google Workspace, Microsoft 365, banking portals, social platforms, SaaS
dashboards) get full modern web platform support: service workers, WebAuthn UI,
modern TLS, HTTP/2/3, OAuth redirect flows, third-party-cookie handling, etc.
The user agent is set to the standard Chrome UA token matching the bundled
Chromium version (the Electron-documented compatibility practice), because some
sites gate features on the `Chrome/` token; nothing else about the browser
identity is altered.

Known caveat: a small number of identity providers (notably Google sign-in)
sometimes block sign-in inside *any* embedded browser, including all
Electron-based browsers. This is a provider-side policy, not an isolation
failure. Most sites are unaffected.

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Main process (src/main)                                    │
│                                                            │
│  main.js            app lifecycle, dashboard window, seed   │
│  profiles.js        ProfileManager — CRUD, PIN (scrypt),    │
│                     per-profile stores, encrypted notes     │
│  sessions.js        SessionManager — partitions, downloads, │
│                     permission prompts, UA                  │
│  browser-window.js  ProfileBrowserWindow — tabs as          │
│                     WebContentsViews, navigation, state     │
│  recovery.js        CrashRecovery — runtime journal,        │
│                     restore offer on unclean exit           │
│  ipc.js             all IPC handlers                        │
│  menu.js            native macOS menu + shortcuts           │
│  store.js           atomic JSON storage primitive           │
└──────────────┬─────────────────────────┬───────────────────┘
               │ contextBridge preloads  │
   ┌───────────▼───────────┐ ┌───────────▼───────────────────┐
   │ Dashboard renderer    │ │ Browser chrome renderer        │
   │ (profiles grid,       │ │ (identity strip, tabstrip,     │
   │  session manager,     │ │  toolbar, overlay panels)      │
   │  domain rules,        │ │ + N × WebContentsView          │
   │  time tools)          │ │   pinned to profile partition  │
   └───────────────────────┘ └───────────────────────────────┘
```

Key decisions:

- **Tabs are `WebContentsView`s**, not `<webview>` tags (deprecated) and not
  iframes. Each view is attached to the profile window's content view and
  laid out under a 92-px chrome region rendered by the window's own
  webContents. This gives full-fidelity Chromium rendering per tab with the
  partition enforced at creation time.
- **Renderers are fully sandboxed**: `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`. All privileged actions flow
  through small, explicit `contextBridge` APIs and IPC handlers.
- **Profile metadata** (name, color, icon, homepage, notes, last-opened,
  PIN hash) lives in a single atomic JSON store in the app's userData
  directory. Profile *browsing data* never lives there — it lives only in the
  profile's own partition directory.
- **Security**: PINs are stored as scrypt hashes (never plaintext). Profile
  notes are encrypted at rest with `safeStorage` (macOS Keychain-backed).
  No analytics, no telemetry, no network calls except the pages you browse.
- **Crash recovery**: a runtime journal (`runtime-state.json`) records open
  profiles and their tab URLs every few seconds. On an unclean exit, the next
  launch offers to restore the previous session — windows, profiles, and tabs.

## 3. Folder structure

```
partitions-browser/
├── package.json
├── electron-builder.yml
├── README.md
├── build/
│   └── entitlements.mac.plist
├── scripts/
│   └── notarize.js              # optional notarization hook (stub)
└── src/
    ├── main/
    │   ├── main.js              # entry point
    │   ├── profiles.js          # profile manager + encryption + PIN
    │   ├── sessions.js          # partition/session manager + downloads
    │   ├── browser-window.js    # profile windows + tabs
    │   ├── recovery.js          # crash recovery journal
    │   ├── ipc.js               # IPC surface
    │   ├── menu.js              # macOS application menu
    │   └── store.js             # atomic JSON store
    ├── preload/
    │   ├── dashboard.js
    │   └── chrome.js
    └── renderer/
        ├── dashboard/           # profile dashboard UI
        │   ├── index.html
        │   ├── dashboard.css
        │   └── dashboard.js
        └── chrome/              # browser window UI (tabstrip/toolbar)
            ├── chrome.html
            ├── chrome.css
            └── chrome.js
```

Data on disk (macOS):

```
~/Library/Application Support/Partitions/
├── profiles.json                # metadata (PINs hashed, notes encrypted)
├── settings.json                # search engine, domain rules, countdowns
├── runtime-state.json           # crash-recovery journal
├── profile-data/<id>/           # per-profile bookmarks/history/downloads DBs
└── Partitions/profile-<id>/     # the Chromium partition itself
    ├── Cookies
    ├── Cache/
    ├── Local Storage/
    ├── IndexedDB/
    ├── Service Worker/
    └── ...
```

## 4. Setup & development

Requirements: macOS 12+, Node.js 20+ (22 recommended), npm.

```bash
npm install        # installs Electron (current stable Chromium) + builder
npm start          # launch the app
npm run dev        # launch with Chromium logging enabled
```

First run seeds a "Personal" profile. From the dashboard you can create,
rename, color-code, icon, annotate, PIN-lock, and launch profiles; open all or
selected profiles at once; start disposable temporary sessions; manage domain
routing rules; and use the clock/countdown tools.

Keyboard shortcuts (native macOS menu): ⌘T new tab, ⌘W close tab, ⌘R reload,
⇧⌘N new temporary session, ⇧⌘T reopen closed profile, ⇧⌘D show dashboard.

## 5. Building for macOS

### Local unsigned build (no Apple account needed)

`electron-builder.yml` ships with `identity: null`, so this works out of the box:

```bash
npm run dist             # .dmg + .zip for arm64 and x64 → release/
npm run dist:arm64       # Apple Silicon only
npm run dist:x64         # Intel only
npm run dist:universal   # single universal binary
```

Install: open the `.dmg` in `release/` and drag **Partitions** to Applications.
Because the build is unsigned, the first launch requires right-click → Open
(or System Settings → Privacy & Security → "Open Anyway").

### Optional: code signing

1. Get a **Developer ID Application** certificate from your Apple Developer
   account and install it in your keychain.
2. In `electron-builder.yml`, delete the `identity: null` line.
3. Build:

```bash
# electron-builder auto-discovers the identity in your keychain, or:
export CSC_LINK=/path/to/DeveloperID.p12
export CSC_KEY_PASSWORD='p12-password'
npm run dist
```

Hardened runtime and entitlements (`build/entitlements.mac.plist`) are already
configured.

### Optional: notarization

1. `npm install --save-dev @electron/notarize`
2. Uncomment `afterSign: scripts/notarize.js` in `electron-builder.yml`.
3. Export credentials and build:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com → App-Specific Passwords
export APPLE_TEAM_ID="ABCDE12345"
npm run dist
```

The hook staples the notarization ticket automatically; users then get no
Gatekeeper friction.

## 6. MVP roadmap (shipped in this build)

- Profile dashboard: create / rename / delete / color / icon / notes /
  homepage / startup URLs / last-opened timestamps
- True per-profile persistent Chromium partitions (separate on-disk dirs)
- Profile browser windows with visible identity (color strip + name badge),
  tabstrip, address bar with search, back/forward/reload/stop/home,
  copy URL, open-current-URL-in-another-profile
- Session manager: active status, open all / open selected, reopen last
  closed, archive, delete
- Temporary disposable sessions (in-memory partition, wiped on close) and
  duplicate-tab-into-temp
- Domain rules: route configured domains to a designated profile
- Sticky notes per profile and per URL (encrypted at rest)
- Clock, time zones, and multiple saved countdowns (informational only)
- PIN lock per profile (scrypt), safeStorage-encrypted metadata,
  no analytics
- Crash recovery with full window/tab restore offer
- Download manager with per-profile history, folders, and progress +
  native notifications
- Per-profile bookmarks with JSON import/export
- Configurable search engine per profile (DuckDuckGo, Google, Bing, Brave)
- Native macOS menus/shortcuts, multi-window, dmg/zip packaging for
  Apple Silicon + Intel

## 7. Future roadmap

- Per-temporary-session scratch notes UI
- "Save temporary session as profile" promotion flow
- Shared-session domain exceptions (a literal shared partition for chosen
  domains, beyond the current routing rules)
- HTML (Netscape format) bookmark import/export for Chrome/Firefox interop
- Bookmark folders UI with drag-and-drop
- Per-profile content settings page (JS, images, popups toggles)
- Find-in-page, zoom controls, print
- Profile data export/backup and migration between machines
- Widevine/DRM support for streaming services (requires a castLabs Electron
  build or Widevine signing — stock Electron does not include CDM)
- Auto-update channel (electron-updater) once builds are signed
- Windows/Linux targets

## 8. Privacy & security posture

- All data is local. No telemetry, no analytics, no external services.
- PINs: scrypt-hashed with per-profile random salt; never stored or logged
  in plaintext. PIN gates app-level access to a profile (it is an access
  control inside Partitions, not full-disk encryption of the partition).
- Profile notes: encrypted via Electron `safeStorage` (macOS Keychain).
- Renderers sandboxed; no Node integration in any web content.
- Passwords typed into websites are handled by Chromium exactly as in any
  browser; Partitions never reads, stores, or logs them.
