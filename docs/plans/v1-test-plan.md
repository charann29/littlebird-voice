# Test Plan — littlebird-voice (offline-first voice transcription PWA)

This is a brand-new feature build with **no automated tests in the repo** (no test
runner installed). All verification below is higher-level browser testing plus
targeted code review for cases that can't be exercised headlessly. Adding unit
tests for pure logic (online-status, blob→recording mapping, Soniox status
parsing) is a follow-up gap, not part of this plan.

The app runs at the HTTPS preview URL (secure context, required for `getUserMedia`
and `crypto.randomUUID`). The Soniox key is configured and inlined, so realtime +
async transcription hit the real Soniox API.

## Areas & Test Cases

### A. Online Badge (`OnlineBadge` / `useOnlineStatus`)
1. **Initial state** — load online → badge shows green "Online" with wifi icon.
2. **Flips on `offline`** — `agent-browser set offline on` → badge turns amber
   "Offline" with wifi-off icon, no page reload.
3. **Flips back on `online`** — `set offline off` → returns to green "Online".
4. **Visual vs mocks** — colors/copy/icon match the header badge in
   `recorder-online-idle.html` / `recorder-offline-idle.html`.

### B. Live Tab (`LiveTranscription` + `useSoniox`) — online streaming
5. **Idle state** — language chips (English/Hindi/Telugu), indigo mic button,
   placeholder text present.
6. **Start listening with fake mic audio** — launch Chromium with
   `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream
   --use-file-for-fake-audio-capture=/tmp/speech.wav` (WAV via
   `espeak-ng -w /tmp/speech.wav "..."`). Click mic → button goes yellow
   "Connecting…" then green "Listening" once `onStarted` fires; waveform renders.
7. **Transcript streams** — interim (italic) updates, finalized text appended to
   the editable area; confirms a real Soniox WS round-trip.
8. **Stop listening** — click stop → returns to idle, mic/audio tracks released.
9. **Copy transcript** — Copy shows "Copied"; clipboard has the text.
10. **Offline steer** — go offline on the Live tab → amber banner "Live
    transcription needs a connection — switch to the Recorder…"; mic button
    disabled; the shell's "record here" affordance navigates to Recorder.
11. **Mic permission denial** (if simulatable via CDP) — `micError` surfaces,
    state resets to idle.

### C. Recorder Tab (online) — `useRecorder`
12. **Idle copy differs by connectivity** — online "we'll transcribe right away"
    vs offline "no connection needed" (mocks `recorder-online-idle.html` /
    `recorder-offline-idle.html`).
13. **Record with fake audio online** — click mic → REC badge + mm:ss timer,
    amber recording waveform, red stop button.
14. **Stop recording** — returns to idle; a new "Pending" item appears in
    Recordings with a timestamp.
15. **Max-length auto-stop** (`MAX_RECORDING_MS` = 10 min) — impractical to wait;
    verified by code review of the auto-stop path only.

### D. Recorder Tab (offline) — the core differentiator
16. **Simulate offline** — `agent-browser set offline on` (blocks network but not
    the local `getUserMedia` / `MediaRecorder` APIs).
17. **Recording still works fully offline** — mic button is NOT gated on
    connectivity; record with fake audio → REC timer runs, amber "Saved locally —
    will transcribe when online" helper shown.
18. **Idle-offline reassurance card** — amber "You're offline — recording still
    works." card (mock `recorder-offline-idle.html`).
19. **Stop while offline** — recording saved to IndexedDB even with no network; a
    "Pending" item appears; NO Soniox request is attempted automatically.
20. **Visual match** — vs `recorder-offline-idle.html` and
    `recorder-offline-recording.html`.

### E. Queue / IndexedDB Persistence
21. **DB shape** — `indexedDB.databases()` / open `littlebird-voice`; confirm
    store `recordings` (keyPath `id`, indexes `by-createdAt`, `by-status`).
22. **Persistence across reload** — record 1–2 items, reload → same items and
    statuses remain (not memory-only).
23. **Persistence across tab close** — close the browser/daemon, reopen the URL →
    recordings still present.
24. **Stranded "transcribing" recovery** — start a transcribe, reload mid-poll →
    item resumes polling if `sonioxTranscriptionId` was persisted, else resets to
    "pending" (never stuck).

### F. Recordings Tab — Async Transcription Happy Path
25. **Pending item, online** — Transcribe enabled; click → Pending →
    Transcribing (sub-stages Uploading/Starting/Transcribing/Finishing) → Done
    (green) with transcript text. Real Soniox async call (upload→create→poll→
    fetch); expect real latency.
26. **Transcript content** — espeak-ng speech should yield non-empty transcript
    text (validates full plumbing with genuine text output).
27. **Transcribe all pending** — with 2+ pending, click "Transcribe pending" (or
    the banner's "Transcribe all") → items transcribe sequentially.
28. **Back-online banner** — create pending items offline, flip online → green
    "You're back online — N ready to transcribe" banner with "Transcribe all"
    (mock `recordings-online.html`).
29. **Copy transcript** on a Done item → "Copied", clipboard has the text.
30. **Delete** — trash any item → removed immediately, count decrements, DB record
    gone on reload; done items fire a best-effort remote DELETE.

### G. Async Transcription — Offline / Error / Retry
31. **Offline in Recordings** — pending items show disabled dashed Transcribe +
    "Connect to transcribe" hint; header shows disabled "Offline"; amber info bar
    "Playback works offline…" (mock `recordings-offline.html`).
32. **Error path** — `agent-browser network route "*api.soniox.com*" --abort`
    while `navigator.onLine` is still true → status Error (red), readable error
    message, Retry button.
33. **Retry after fixing network** — unblock Soniox, click Retry → flow restarts
    from Uploading and can reach Done.
34. **Abort on delete mid-transcription** — start a transcription, Delete before
    it finishes → `AbortController.abort()` fires, no crash, clean removal, no
    orphaned "transcribing" state in DB.

### H. Playback
35. **Play/pause a stored recording** — play button plays the object-URL Blob,
    swaps to pause, progress bar fills, mm:ss counters update.
36. **Playback works fully offline** — go offline, play a prior recording → plays
    fine (Blob is local).
37. **Playback ends** — button reverts to play, progress resets.

### I. Visual-vs-Mocks Review
For each mock, capture a live screenshot in the matching state and compare
layout, color tokens (slate-950 bg, indigo-600 primary, green listening, amber
offline/pending, red error/stop), copy, and icons. The "Warble" → "littlebird-
voice" name difference is the only intentional deviation; log any other
deviation as a bug.
38. `recorder-online-idle.html` vs Recorder idle-online.
39. `recorder-online-listening.html` vs Live listening-online.
40. `recorder-offline-idle.html` vs Recorder idle-offline.
41. `recorder-offline-recording.html` vs Recorder recording-offline.
42. `recordings-online.html` vs Recordings with back-online banner.
43. `recordings-offline.html` vs Recordings offline state.
44. `recording-detail.html` — **known gap**: the app has no distinct detail/
    expanded view or Download/Re-transcribe buttons (`RecordingItem` has
    Transcribe/Retry, Copy, Delete only). Confirm this is an accepted deviation,
    not a regression.
45. `pwa-install.html` — **known gap**: the app uses the native
    `beforeinstallprompt` dialog + inline `InstallBanner`; there's no custom
    full-screen install sheet. Compare the inline banner only.

### J. PWA — Build + Preview (NOT dev server)
The service worker is disabled under `vite dev`, so these run against a
production build: `npm run build && npm run preview` (port 4173), exposed
publicly.
46. **Production build** — `npm run build` completes with no TS errors and emits
    `dist/` with `manifest.webmanifest`, `sw.js`, precache assets.
47. **Serve preview** — `npm run preview` on port 4173, exposed like the 5173
    preview.
48. **Service worker registers** — `navigator.serviceWorker.getRegistrations()`
    shows a registration (only meaningful on build+preview, not dev).
49. **Installability** — `beforeinstallprompt` fires in Chromium over HTTPS;
    `InstallBanner` appears and Install triggers the native prompt; or verify the
    event fired + manifest is valid (icons, name, start_url, standalone, active
    SW).
50. **Offline app-shell boot** — after first load (SW installed + precached), go
    offline and hard-reload → shell loads via `navigateFallback: /index.html`;
    Recorder tab still usable offline.
51. **Soniox never served from cache** — offline post-install, transcribe
    attempts fail cleanly (NetworkOnly rule) rather than returning a stale
    cached transcript.
52. **Update banner** — not fully testable without two published builds; if time
    allows, modify a string, rebuild, redeploy, reload an open tab → prompt-based
    `UpdateBanner` ("A new version is available" + Reload) appears. Otherwise
    code-reviewed-only (`registerType: "prompt"` avoids auto-reload during a
    recording).

## Test Environment & Exact Commands

- **Live/Recorder/Recordings/Badge tests**: use the running dev server at the
  HTTPS preview URL (secure context).
- **Fake mic audio**: `espeak-ng -w /tmp/speech.wav "This is a test recording for
  transcription."` (22050Hz mono PCM WAV). Launch Chromium with
  `--args "--no-sandbox,--use-fake-device-for-media-stream,--use-fake-ui-for-media-stream,--use-file-for-fake-audio-capture=/tmp/speech.wav"`.
  Feeds the WAV as the mic for both `useSoniox` (Live) and `useRecorder`
  (Recorder).
- **Offline simulation**: `npx agent-browser set offline on` / `off` (fires real
  `online`/`offline` DOM events; leaves local APIs working). For the "online per
  `navigator.onLine` but Soniox unreachable" case use
  `npx agent-browser network route "*api.soniox.com*" --abort`.
- **PWA build+preview**: `npm run build && npm run preview` (port 4173), exposed
  publicly. SW/installability/offline-boot must be tested here, never on dev.
- **IndexedDB inspection**: `agent-browser eval` running `indexedDB.databases()`
  and reading the `littlebird-voice` `recordings` store, or the DevTools
  Application panel in `--headed` mode.

## What genuinely cannot be verified headlessly

- **Real mic permission prompts** — `--use-fake-ui-for-media-stream` auto-accepts;
  a genuine "user denies mic" click can't be observed (only forced via CDP).
- **Actual hardware/OS network offline** (real Wi-Fi drop, captive portal) —
  emulation via `set offline` / route-abort is the standard approximation, not a
  true OS-level disconnect.
- **Native OS "Add to Home Screen" install** — can validate
  `beforeinstallprompt`, manifest validity, and SW registration, but not the real
  OS install surface or a truly standalone window.
- **Real speech accuracy** — espeak-ng audio is robotic; Soniox may return a
  low-fidelity but non-empty transcript. Validates plumbing, not accuracy.
- **10-minute max-recording auto-stop** — verified by code reading only.
- **Recording-detail mock & PWA install sheet** — no matching UI exists (reported
  as mock-vs-implementation gaps, not silently skipped).
