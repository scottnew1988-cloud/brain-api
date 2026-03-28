# AI Content Guardian — Android App Specification

**Version:** 2.1
**Platform:** Android only
**Status:** Draft
**Last Updated:** 2026-03-28

---

## What It Does

User installs the app. A floating button appears over every other app.
While on TikTok / Instagram / X, user taps the button.
App captures the current screen, runs on-device detection, and blurs harmful regions.
User gives a thumbs up/down. App learns locally from that feedback.
No server. No internet required for core logic.

---

## A. Architecture

```
┌─────────────────────────────────────────────────────┐
│  OverlayService  (foreground service, always-on FAB) │
│       │                                              │
│       ▼  on tap                                      │
│  CaptureManager  (MediaProjection API)               │
│       │  bitmap                                      │
│       ▼                                              │
│  InferenceModule                                             │
│    ├─ MemorySimilarityScorer  (pHash lookup + px heuristics) │
│    ├─ ImageClassifier         (TFLite — MobileNetV3 quant.)  │
│    └─ TextExtractor           (ML Kit OCR → token scorer)    │
│       │  scores                                      │
│       ▼                                              │
│  DecisionEngine  (weighted score + local rules)      │
│       │  blur regions / pass                         │
│       ▼                                              │
│  BlurRenderer    (Canvas overlay, RenderEffect / sw fallback) │
│       │                                              │
│       ▼  result shown to user                        │
│  FeedbackSheet   (thumbs up / down + optional label) │
│       │  signal                                      │
│       ▼                                              │
│  LocalLearner    (pHash store + token freq table)    │
│       │  persists to                                 │
│       ▼                                              │
│  LocalStorage    (Room DB + SharedPreferences)       │
└─────────────────────────────────────────────────────┘
```

**All components are in-process. No IPC. No network calls on the detection path.**

---

## B. Detection Pipeline — Tap to Blur

```
1.  User taps FAB
        │
2.  OverlayService calls CaptureManager.capture()
        │  MediaProjection virtualDisplay → Bitmap (compressed to 720p)
        │
3.  InferenceModule.analyse(bitmap) — runs in parallel:
        ├─ MemorySimilarityScorer.score(bitmap) → memoryScore  [0.0–1.0]
        ├─ ImageClassifier.score(bitmap)        → imageScore   [0.0–1.0]
        └─ TextExtractor.extractAndScore()      → textScore    [0.0–1.0]
        │
4.  DecisionEngine.decide(memoryScore, imageScore, textScore)
        │  combined = (memory * 0.5) + (image * 0.3) + (text * 0.2)
        │
5a. combined >= THRESHOLD (default 0.65)
        │  → DecisionEngine.getRegions() returns List<Rect>
        │  → BlurRenderer.apply(bitmap, regions)
        │  → OverlayService renders blurred overlay on screen
        │  → FeedbackSheet shown (non-blocking bottom sheet)
        │
5b. combined < THRESHOLD
        │  → no overlay drawn
        │  → silent pass (optionally log for debugging)
        │
6.  User taps thumbs up / down on FeedbackSheet
        │
7.  LocalLearner.record(bitmap, regions, feedback)
        │  → pHash of bitmap stored with label
        │  → text tokens updated in frequency table
        │  → per-app threshold adjusted ±0.02 (see Section C — Threshold)
```

**Target total latency (tap → blur visible): ≤ 800ms on mid-range device.**

---

## C. Scoring Logic

### Formula

```
combinedScore = (memoryScore * 0.5) + (imageScore * 0.3) + (textScore * 0.2)
```

### MemorySimilarityScorer (weight 0.5)

This is a **memory and retrieval signal**, not a second classifier. It answers:
"Have we seen something like this before, and did the user mark it harmful?"

Two sub-signals, averaged:

**1. pHash similarity** — query Room DB for stored hashes within Hamming distance ≤ 8.
If match found: sub-score = `1.0 - (hammingDistance / 64.0)`.
If no match found: sub-score = 0.0.

**2. Pixel heuristics** — lightweight rule-based signal applied to the bitmap:

| Signal | Score contribution |
|---|---|
| Skin-tone pixel ratio > 40% of frame | +0.4 |
| High-contrast central region, no UI chrome | +0.3 |
| Dominant red/pink saturation cluster | +0.2 |
| Low text density (< 5% of pixels are text-like) | +0.1 |

Final `memoryScore = (pHashSubScore + heuristicSubScore) / 2`, clamped to [0.0, 1.0].

This component is named `memory` because as the user flags more content,
pHash matches dominate and the heuristics become less influential.

### ImageClassifier (weight 0.3)

- Model: MobileNetV3-Small, quantised INT8, NSFW binary classifier
- Input: 224×224 crop of the most prominent region
- Output: float [0.0–1.0] (0 = safe, 1 = harmful)
- Model file: `assets/nsfw_v1.tflite` (~4MB)
- Inference time target: ≤ 150ms

### TextExtractor (weight 0.2)

- OCR: ML Kit Text Recognition (on-device, no network)
- Tokenise extracted text → compare against local `BlocklistTokens` table
- Score = `matchedTokens / max(totalTokens, 1)`, clamped to [0.0, 1.0]
- Blocklist bootstrapped from a hardcoded seed list; updated by LocalLearner

### Threshold

**Baseline:** 0.65 (global). Stored in `SharedPreferences`.

**Two separate thresholds:**

| Scope | Key | Default | Bounds |
|---|---|---|---|
| Global | `threshold_global` | 0.65 | [0.55, 0.75] |
| Per-app | `threshold_<packageName>` | inherits global | [0.50, 0.80] |

Per-app threshold is created on first feedback for that app's package name.
Subsequent taps on the same app use the per-app value; unknown apps use global.

**Adjustment rules:**

- Thumbs-down on a miss (false negative): threshold -= 0.02 for that app
- Thumbs-up on a correct blur (true positive): no change — reinforce, not lower
- Long-press FAB and report false positive: threshold += 0.02 for that app
- Minimum 3 feedback signals before a per-app threshold is persisted
- Maximum ±0.10 total drift from global baseline before user is prompted to review sensitivity

**Decay:**

- Each threshold decays 0.005 toward global baseline per 7 days of inactivity on that app
- Prevents stale per-app thresholds from persisting indefinitely after usage changes

---

## D. Local Learning

**No model training. No gradient descent. No server sync.**

### pHash Store

- On each capture, compute perceptual hash (pHash) of the full bitmap
- Store in `Room` table: `{ hash TEXT, label INT, timestamp INTEGER }`
- On future captures: compute pHash → query for nearest stored hash (Hamming distance ≤ 8)
- If match found: boost or suppress combined score by ±0.15 before threshold check

```kotlin
// Hamming distance between two 64-bit pHashes
fun hammingDistance(a: Long, b: Long): Int = (a xor b).countOneBits()
// Match threshold: distance <= 8 (out of 64 bits)
```

### Token Frequency Table

- After each thumbs-down feedback: extract OCR tokens from flagged screen → increment `harmful_count`
- After each thumbs-up feedback: decrement `harmful_count` for matched tokens (floor 0)
- TextExtractor score uses `harmful_count / max_seen_count` as per-token weight
- Table capped at 2000 tokens (LRU eviction)

### No Learning On

- Blur regions (not stored)
- Raw screenshots (never persisted)
- Model weights (static)

---

## E. Blur Logic

### Region-Based Blur

1. DecisionEngine returns `List<Rect>` — one rect per detected harmful region
2. BlurRenderer applies blur to each rect using the appropriate API for the device:

| API level | Method | Notes |
|---|---|---|
| API 31+ (Android 12+) | `RenderEffect.createBlurEffect(25f, 25f, SHADER_TILE_MODE_CLAMP)` applied to a `View` via `setRenderEffect()` | Hardware-accelerated; preferred path |
| API 26–30 | Software `StackBlur` (pure Kotlin, radius 20, iterative) | Slower; run on background thread, post result to main |
| API < 26 | Solid semi-transparent dark scrim (`#CC000000`) over region rect | No blur — obscures content without GPU dependency |

> **RenderScript is explicitly excluded.** It was deprecated in API 31 and removed from NDK toolchains. Do not use `ScriptIntrinsicBlur` or any `android.renderscript.*` API.

3. Blurred/obscured regions are drawn onto a transparent overlay `View` anchored to the window via `WindowManager`
4. Original app content is untouched — overlay sits above it

### Fallback Rules

Applied in order if InferenceModule throws or times out (> 1000ms):

| Level | Trigger | Action |
|---|---|---|
| L1 — score degraded | `ImageClassifier` fails or times out | Reweight remaining scores: `(memory * 0.7) + (text * 0.3)`; continue to decision |
| L2 — region mapping uncertain | Combined score ≥ threshold but `getRegions()` returns empty list | Identify dominant content panel (largest non-chrome `View` rect); apply blur to that rect only |
| L3 — all classifiers fail | All three scorers throw or return null | Full-screen dim overlay (`#99000000`) + non-blocking sheet: "Content uncertain — tap to dismiss" |
| L4 — bitmap capture fails | `createVirtualDisplay` returns null or OOM on downsample retry | No overlay; show snackbar "Could not read screen" — silent, no crash |

Levels are tried in sequence. L3 and L4 never co-occur; capture failure triggers L4 directly.

### Overlay Dismissal

- Tap anywhere on blurred overlay → dismiss overlay (not the app underneath)
- Auto-dismiss after 8 seconds if no interaction
- FAB returns to idle state after dismissal

---

## F. Permissions

### Core tap-to-scan flow — required permissions

| Permission | Declared in | User action required | Purpose |
|---|---|---|---|
| `SYSTEM_ALERT_WINDOW` | `AndroidManifest.xml` | Must grant via Settings > Special app access | Floating overlay button |
| `FOREGROUND_SERVICE` | `AndroidManifest.xml` | No runtime prompt | Keeps OverlayService alive |
| `FOREGROUND_SERVICE_MEDIA_PROJECTION` | `AndroidManifest.xml` (API 34+ required) | No runtime prompt | Declares foreground service type for projection |
| MediaProjection consent | OS system dialog | Shown on first tap; one-time per session | Screen capture |

**No camera. No microphone. No contacts. No location.**

### Accessibility Service — explicitly optional

The core tap-to-scan loop **does not require** Accessibility Service.
Accessibility is not declared in the default manifest.
It may be added in a future version to provide app-context signals (current foreground package name).
If offered to users, it must be presented as an opt-in enhancement with a clear description of exactly what it reads — never as a requirement to use the app.

### Overlay behaviour caveats

- `SYSTEM_ALERT_WINDOW` is a sensitive permission requiring a Settings deep-link redirect; it cannot be granted via `requestPermissions()`.
- Android 12+ allows apps to set `HIDE_OVERLAY_WINDOWS` in their manifest, which hides overlays from third-party apps. This means the Guardian FAB may not appear over apps that set this flag. Document as a known limitation in onboarding.
- The OS MediaProjection consent dialog cannot be bypassed, pre-granted, or re-used across reboots. A new consent is required after device restart.

---

## G. Runtime Lifecycle

### Manifest declarations required

```xml
<!-- AndroidManifest.xml -->
<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<!-- Required on API 34+ for MediaProjection foreground service type -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" />

<service
    android:name=".overlay.OverlayService"
    android:foregroundServiceType="mediaProjection"
    android:exported="false" />
```

### Lifecycle flow

```
App installed
    │
    ▼
MainActivity launched
    ├─ Check Settings.canDrawOverlays() → if false: show onboarding + deep-link to Settings
    └─ if true: startForegroundService(Intent(this, OverlayService::class.java))
    │
    ▼
OverlayService.onCreate()
    ├─ startForeground(NOTIFICATION_ID, buildNotification())
    │     Notification: "Content Guardian active" + "Stop" action
    │     Must be called within 5 seconds of service start (ANR risk if delayed)
    │     On API 34+: startForeground() must specify type FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
    ├─ WindowManager.addView(fabView, overlayLayoutParams)
    ├─ CaptureManager.init() — projection NOT started here
    └─ LocalLearner.load() — Room query on IO dispatcher
    │
    ▼
Service runs in foreground — FAB visible, no capture active
    │
    ▼
User taps FAB
    ├─ First tap in session:
    │     startActivityForResult(mediaProjectionManager.createScreenCaptureIntent(), RC_PROJECTION)
    │     → OS shows system consent dialog
    │     → onActivityResult: if resultCode == RESULT_OK, store projection token
    │     → CaptureManager.start(token) — creates VirtualDisplay
    └─ Subsequent taps in same session: CaptureManager.capture() using existing VirtualDisplay
    │
    ▼
    Projection scope: per-session (token held until service stops or user revokes)
    VirtualDisplay is created once per session, not once per tap
    A new consent is required after device reboot
    │
    ▼
Detection pipeline runs (see Section B)
    │
    ▼
User dismisses overlay / provides feedback
    │
    ▼
OverlayService returns to idle — FAB visible, VirtualDisplay held open
    │
    ▼
User stops Guardian (notification action or Settings toggle)
    ├─ CaptureManager.stop() — release VirtualDisplay + projection token
    ├─ WindowManager.removeView(fabView)
    └─ stopSelf()
```

---

## H. Failure Handling

| Failure | Detection | Response |
|---|---|---|
| `SYSTEM_ALERT_WINDOW` denied | `Settings.canDrawOverlays()` returns false | Show in-app explanation screen; cannot start service |
| MediaProjection consent denied | `onActivityResult` with null intent | Toast "Screen capture permission needed"; retry on next tap |
| MediaProjection token expired | `SecurityException` on `createVirtualDisplay` | Re-request consent silently on next tap |
| TFLite model load failure | `IOException` in `Interpreter()` | Disable ImageClassifier; fallback L1 |
| OCR timeout (> 500ms) | `Task.addOnFailureListener` timeout | textScore = 0.0; continue with other scores |
| Out of memory on bitmap | `OutOfMemoryError` catch | Downsample to 480p and retry once; if fails → fallback L3 |
| OverlayService killed by OS | `onDestroy()` | Restart via `START_STICKY`; FAB re-added |
| Room DB corrupt | `IllegalStateException` | Delete and recreate DB; reset local learning state |

---

## I. Performance Targets

| Metric | Target | Measurement point |
|---|---|---|
| Tap to blur visible | ≤ 800ms | FAB tap → overlay drawn |
| ImageClassifier inference | ≤ 150ms | `Interpreter.run()` duration |
| OCR extraction | ≤ 300ms | ML Kit task completion |
| VisualAnalyser | ≤ 50ms | Pixel analysis on bitmap |
| pHash lookup (2000 rows) | ≤ 10ms | Room query |
| Memory overhead (service idle) | ≤ 40MB | Android Profiler RSS |
| Memory overhead (during inference) | ≤ 120MB | Peak during `analyse()` |
| Battery (per tap) | < 50mJ | Estimated, validate on device |
| TFLite model size | ≤ 5MB | APK assets |

Target device: Snapdragon 665 / 4GB RAM (2022 mid-range baseline).

---

## J. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Google Play policy: NSFW classifier in APK | High | App removed from Play Store | Distribute via sideload / alternative stores; review Play policy before submission |
| MediaProjection API changes (Android 15+) | Medium | Capture breaks | Abstract behind `CaptureManager` interface; maintain API-level adapters |
| OS killing foreground service on low memory | Medium | FAB disappears | `START_STICKY` + user notification to re-enable; document in onboarding |
| False positives alienating users | High | Low retention | pHash learning + threshold nudging; expose sensitivity slider in Settings |
| False negatives on novel content | Medium | Trust loss | Token frequency learning; clear "miss? tap to report" affordance |
| `SYSTEM_ALERT_WINDOW` friction (Android 10+) | High | Low conversion | Onboarding flow with step-by-step Settings guide + deep link |
| Accessibility service misuse concern | Low | User trust | Accessibility service is optional in v1; document exactly what it reads |
| pHash collision producing wrong boost | Low | Wrong blur decision | Cap boost at ±0.15; hard threshold floor at 0.40 |

---

## File Structure (v1)

```
app/
├── src/main/
│   ├── java/com/contentguardian/
│   │   ├── overlay/
│   │   │   ├── OverlayService.kt          # Foreground service + FAB
│   │   │   └── FeedbackSheet.kt           # Bottom sheet UI
│   │   ├── capture/
│   │   │   └── CaptureManager.kt          # MediaProjection wrapper
│   │   ├── inference/
│   │   │   ├── InferenceModule.kt             # Orchestrates all scorers
│   │   │   ├── MemorySimilarityScorer.kt      # pHash lookup + pixel heuristics
│   │   │   ├── ImageClassifier.kt             # TFLite MobileNetV3
│   │   │   └── TextExtractor.kt               # ML Kit OCR + token scoring
│   │   ├── decision/
│   │   │   └── DecisionEngine.kt          # Weighted score + threshold
│   │   ├── blur/
│   │   │   └── BlurRenderer.kt            # RenderEffect (API 31+) / StackBlur / scrim fallback
│   │   ├── learning/
│   │   │   ├── LocalLearner.kt            # pHash + token freq logic
│   │   │   └── PHashUtils.kt              # 64-bit pHash computation
│   │   ├── storage/
│   │   │   ├── AppDatabase.kt             # Room DB definition
│   │   │   ├── PHashDao.kt
│   │   │   └── TokenDao.kt
│   │   └── ui/
│   │       └── MainActivity.kt            # Permission onboarding only
│   └── assets/
│       └── nsfw_v1.tflite                 # Quantised INT8 model (~4MB)
```

---

## Open Questions (v1 scope)

1. **Play Store distribution** — Is sideload acceptable, or must this pass Play policy review? Determines whether the NSFW model can be bundled in the APK.
2. **Sensitivity default** — Is 0.65 the right out-of-the-box threshold, or should onboarding ask the user to set it?
3. **Notification UX** — Should the persistent foreground notification show last-detection stats, or remain minimal?
4. **FAB position** — Fixed bottom-right, or user-draggable? Draggable adds complexity but reduces obstruction complaints.
5. **Re-blur on scroll** — If the user scrolls after a blur is applied, should the overlay auto-dismiss or persist? V1 assumption: auto-dismiss.
