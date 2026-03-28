# AI Content Guardian — Android App Specification

**Version:** 2.0
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
│  InferenceModule                                     │
│    ├─ VisualAnalyser   (TFLite — layout heuristics)  │
│    ├─ ImageClassifier  (TFLite — MobileNetV3 quant.) │
│    └─ TextExtractor    (ML Kit OCR → token scorer)   │
│       │  scores                                      │
│       ▼                                              │
│  DecisionEngine  (weighted score + local rules)      │
│       │  blur regions / pass                         │
│       ▼                                              │
│  BlurRenderer    (Canvas overlay, RenderScript)      │
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
        ├─ VisualAnalyser.score(bitmap)      → visualScore  [0.0–1.0]
        ├─ ImageClassifier.score(bitmap)     → imageScore   [0.0–1.0]
        └─ TextExtractor.extractAndScore()   → textScore    [0.0–1.0]
        │
4.  DecisionEngine.decide(visualScore, imageScore, textScore)
        │  combined = (visual * 0.5) + (image * 0.3) + (text * 0.2)
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
        │  → pHash of bitmap stored
        │  → text tokens updated in frequency table
        │  → threshold nudged ±0.02 per feedback signal
```

**Target total latency (tap → blur visible): ≤ 800ms on mid-range device.**

---

## C. Scoring Logic

### Formula

```
combinedScore = (visualScore * 0.5) + (imageScore * 0.3) + (textScore * 0.2)
```

### VisualAnalyser (weight 0.5)

Rule-based heuristics applied to the bitmap without a model:

| Signal | Score contribution |
|---|---|
| Skin-tone pixel ratio > 40% of frame | +0.4 |
| High-contrast region with face-shaped contour | +0.3 |
| Large central region with no UI chrome | +0.2 |
| Dominant red/pink saturation cluster | +0.1 |

Output clamped to [0.0, 1.0].

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

| Level | Value | Behaviour |
|---|---|---|
| Default | 0.65 | Blur triggered |
| Nudged up | +0.02 per false-positive feedback | Less sensitive |
| Nudged down | -0.02 per false-negative feedback | More sensitive |
| Hard floor | 0.40 | Never drops below |
| Hard ceiling | 0.90 | Never rises above |

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
2. BlurRenderer applies Gaussian blur (radius 25) to each rect using RenderScript (API 21+) or fallback `Stack Blur` implementation
3. Blurred regions are drawn onto a transparent overlay `View` anchored to the window via `WindowManager`
4. Original app content is untouched — overlay sits above it

### Fallback Rules

If InferenceModule throws or times out (> 1000ms):

| Fallback level | Trigger | Action |
|---|---|---|
| L1 | ImageClassifier fails | Use VisualAnalyser + TextExtractor scores only (reweight 0.7 / 0.3) |
| L2 | All classifiers fail | Blur centre 60% of screen |
| L3 | Bitmap capture fails | Show toast "Could not analyse screen" — no blur |

### Overlay Dismissal

- Tap anywhere on blurred overlay → dismiss overlay (not the app underneath)
- Auto-dismiss after 8 seconds if no interaction
- FAB returns to idle state after dismissal

---

## F. Permissions

| Permission | When requested | Required for |
|---|---|---|
| `SYSTEM_ALERT_WINDOW` | First launch — direct user to Settings | Floating overlay button |
| `FOREGROUND_SERVICE` | Manifest (no runtime prompt) | OverlayService persistence |
| `FOREGROUND_SERVICE_MEDIA_PROJECTION` | Manifest (Android 14+) | Service type declaration |
| MediaProjection consent | On first tap (system dialog) | Screen capture |
| `RECEIVE_BOOT_COMPLETED` | Manifest | Optional: restart service on reboot |
| Accessibility Service | Optional — Settings prompt | Reading app context (not required for v1) |

**No camera permission. No microphone. No contacts. No location.**

MediaProjection consent dialog is shown by Android OS — cannot be bypassed or pre-granted.

---

## G. Runtime Lifecycle

```
App installed
    │
    ▼
MainActivity launched → requests SYSTEM_ALERT_WINDOW
    │
    ▼
User grants → startForegroundService(OverlayService)
    │
    ▼
OverlayService.onCreate()
    ├─ WindowManager.addView(FAB overlay)
    ├─ CaptureManager.init() — does NOT start projection yet
    └─ LocalLearner.load() — load pHash + token tables from Room
    │
    ▼
Service runs in foreground (persistent notification: "Content Guardian active")
    │
    ▼
User taps FAB
    ├─ First tap: show MediaProjection consent dialog
    └─ Subsequent taps: reuse existing projection token
    │
    ▼
Detection pipeline runs (see Section B)
    │
    ▼
User dismisses overlay / provides feedback
    │
    ▼
OverlayService returns to idle — FAB visible, no overlay
    │
    ▼
User swipes away app from recents
    ├─ OverlayService.onTaskRemoved() → stopSelf() or persist based on user setting
    └─ Default: persist (user controls via notification action "Stop Guardian")
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
│   │   │   ├── InferenceModule.kt         # Orchestrates all classifiers
│   │   │   ├── VisualAnalyser.kt          # Heuristic pixel analysis
│   │   │   ├── ImageClassifier.kt         # TFLite MobileNetV3
│   │   │   └── TextExtractor.kt           # ML Kit OCR + token scoring
│   │   ├── decision/
│   │   │   └── DecisionEngine.kt          # Weighted score + threshold
│   │   ├── blur/
│   │   │   └── BlurRenderer.kt            # RenderScript / stack blur
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
