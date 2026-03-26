# AI Guardian — V2 Spec (Realistic, Buildable, Android-First)

**Version:** 2.0 — March 2026
**Platform:** Android (v1). iOS excluded from core loop — see Section H.
**Built with:** Android native + Base44 frontend/functions

---

## Why This Spec Replaces V1

V1 had three fatal assumptions:
1. iOS supports a global floating button over other apps — it does not.
2. On-device model fine-tuning and k-means clustering are practical for a small team — they are not for v1.
3. Proactive 3-second background capture is acceptable — it will drain battery and get the app pulled from the Play Store.

This spec fixes all three.

---

## A. Final V1 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ANDROID DEVICE                           │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   OVERLAY LAYER                          │   │
│  │   FloatingButtonService (TYPE_APPLICATION_OVERLAY)       │   │
│  │   → User taps → triggers capture pipeline               │   │
│  └─────────────────────────┬───────────────────────────────┘   │
│                             │ tap event                         │
│  ┌─────────────────────────▼───────────────────────────────┐   │
│  │                 CAPTURE LAYER                            │   │
│  │   MediaProjection (user-consented session)               │   │
│  │   → single bitmap on tap, nothing in background          │   │
│  └─────────────────────────┬───────────────────────────────┘   │
│                             │ bitmap                            │
│  ┌─────────────────────────▼───────────────────────────────┐   │
│  │               DETECTION PIPELINE                         │   │
│  │   1. pHash → compare to local harm store                 │   │
│  │   2. Image model (MobileNetV3 TFLite) → harm score       │   │
│  │   3. OCR / AccessibilityService → text tokens            │   │
│  │   4. Text keyword match → text score                     │   │
│  │   5. Decision engine → blur or pass                      │   │
│  └─────────────────────────┬───────────────────────────────┘   │
│                             │ regions to blur                   │
│  ┌─────────────────────────▼───────────────────────────────┐   │
│  │                  BLUR LAYER                              │   │
│  │   RenderEffect (API 31+) / fallback paint overlay        │   │
│  │   Overlay rectangles drawn on top of flagged regions     │   │
│  └─────────────────────────┬───────────────────────────────┘   │
│                             │ user sees blur                    │
│  ┌─────────────────────────▼───────────────────────────────┐   │
│  │               FEEDBACK + STORAGE LAYER                   │   │
│  │   "Was this right?" card → Yes / Show it                 │   │
│  │   Store derived features only (no raw screenshot)        │   │
│  │   Encrypted via Android Keystore + EncryptedSharedPrefs  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└──────────────────────────────┬──────────────────────────────────┘
                               │ non-sensitive only
              ┌────────────────▼─────────────────┐
              │            BASE44                 │
              │  - Settings UI                    │
              │  - Onboarding screens             │
              │  - Feature flags                  │
              │  - Anonymous aggregate analytics  │
              │  - Remote keyword/config updates  │
              └───────────────────────────────────┘
```

### What Runs Where

| Component | Location | Reason |
|---|---|---|
| Screen capture | On device | Never leaves device |
| ML inference | On device | Privacy + latency |
| pHash comparison | On device | Privacy |
| Local harm store | On device (encrypted) | Privacy |
| Decision engine | On device | Speed |
| Settings UI | Base44 | Easy to iterate |
| Onboarding | Base44 | Easy to update copy |
| Feature flags | Base44 Functions | Control rollout |
| Keyword lists | Base44 (fetched on sync) | Update without app release |
| Crash reports | Base44 (opt-in, no user data) | Debugging |

---

## B. Core Detection System

### Step-by-Step Pipeline (triggered on every tap)

```
Step 1 — Capture
  MediaProjection.createVirtualDisplay()
  → capture single frame as Bitmap
  → target resolution: 720p (scale down if higher)
  → time budget: 100ms

Step 2 — pHash
  Compute perceptual hash of full bitmap (8x8 DCT hash, 64-bit)
  Query local harm store: SELECT visual_hash FROM harm_events WHERE user_feedback = 1
  Compute Hamming distance to each stored hash
  If min_distance ≤ 10 → visual_match = true, visual_score = 1.0
  Else visual_score = 0.0
  → time budget: 30ms

Step 3 — Image Model
  Resize bitmap to 224x224
  Run MobileNetV3 TFLite inference
  Output: harm_probability (float 0.0–1.0)
  image_score = harm_probability
  → time budget: 200ms

Step 4 — Text Extraction
  Option A (preferred): Read AccessibilityService node tree → extract visible text strings
  Option B (fallback): Run MLKit on-device OCR on bitmap
  → time budget: 150ms

Step 5 — Text Scoring
  Normalise text to lowercase
  Match against local keyword list (loaded from Base44 on last sync, stored locally)
  keyword_score = (matched_keywords / total_keywords_checked), capped at 1.0
  → time budget: 20ms

Step 6 — Decision Engine
  (see Section D)
  → time budget: 10ms

Step 7 — Blur
  If decision = blur:
    Identify regions (full screen for v1, region detection in v2)
    Draw RenderEffect blur overlay on top
  → time budget: 50ms

Step 8 — Feedback Card
  Show card immediately after blur
  User taps Yes or Show It
  Store result (see Section C)
  → non-blocking, async
```

**Total target: < 600ms steps 1–7. < 800ms with render.**

---

## C. Local Learning System (Simple)

### Data Model — Local Storage Only

```sql
-- Stored in Room DB, encrypted via Android Keystore

CREATE TABLE harm_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   INTEGER NOT NULL,
  visual_hash TEXT NOT NULL,       -- 64-bit pHash (hex string)
  text_tokens TEXT,                -- space-separated normalised tokens, NOT raw text
  app_package TEXT NOT NULL,       -- e.g. com.instagram.android
  user_feedback INTEGER NOT NULL,  -- 1 = confirmed harmful, 0 = false positive
  score_at_time REAL               -- what score triggered it
);

-- No raw screenshots. No raw text. Never.
```

### How It Learns (No ML Training Required)

After every confirmed harmful event (user_feedback = 1):
- The pHash is added to the local harm store.
- Text tokens are appended to a local frequency map (token → count).

After every false positive (user_feedback = 0):
- The pHash is flagged as a known safe hash. Future exact matches are skipped.
- The text tokens involved are down-weighted in the frequency map.

The decision engine uses this evolving store. No model weights change. No training loop. It just gets a better database of known-bad and known-safe fingerprints.

### Token Frequency Map (in-memory, persisted on change)

```json
{
  "hate": 14,
  "kill": 8,
  "loser": 3,
  "delete_me": -2
}
```
Negative weight = user said it was a false positive. Used to reduce future score for that token.

---

## D. Decision Engine (Exact Logic)

```
WEIGHTS (configurable via Base44 feature flag):
  W_visual  = 0.5
  W_image   = 0.3
  W_text    = 0.2

SCORE:
  score = (visual_score × W_visual) + (image_score × W_image) + (keyword_score × W_text)

THRESHOLD:
  Default = 0.55
  User sensitivity setting:
    Low    → 0.70  (fewer blurs, less annoying)
    Medium → 0.55  (default)
    High   → 0.40  (more blurs, more protective)

REPEAT EXPOSURE BOOST:
  If same pHash seen 3+ times in last 7 days, regardless of prior feedback:
    score += 0.15  (user keeps seeing the same thing — probably worth flagging)

DECISION:
  if score >= threshold → BLUR
  else → PASS (do nothing, no UI shown)

SAFE HASH BYPASS:
  If pHash is in confirmed safe list (user said "Show it") → PASS immediately, skip scoring
```

---

## E. Permission Flow UX

### Android Permissions Required

| Permission | What For | When Requested |
|---|---|---|
| `SYSTEM_ALERT_WINDOW` | Floating button overlay | Onboarding Step 2 |
| `FOREGROUND_SERVICE` | Keep overlay alive | Granted automatically with above |
| `MediaProjection` | Screen capture (per session) | First tap of session |
| `AccessibilityService` | Read screen text | Onboarding Step 3 (optional) |

### Onboarding Flow (4 Screens, No Skipping Core Steps)

```
Screen 1 — "What AI Guardian does"
  One sentence. One image showing blur demo.
  → Next

Screen 2 — "It needs one permission to float"
  Explain SYSTEM_ALERT_WINDOW in plain English:
  "This lets the Help button appear on top of other apps.
   Without it, the app cannot work."
  → Button: "Open Settings" (deep links to Settings > Apps > Special access > Appear on top)
  App polls every 500ms. When permission granted → auto-advance.
  If user comes back without granting → show blocker screen, cannot proceed.

Screen 3 — "To read text on screen (optional but better)"
  Explain AccessibilityService:
  "This lets the app read text in your feed — no content is ever stored or sent anywhere.
   You can skip this, but the app will only detect images, not text."
  → "Enable it" (deep links to Accessibility settings) OR "Skip for now"

Screen 4 — "Ready. Tap the button anytime."
  Show where the floating button is.
  Explain: "Nothing happens until you tap it."
  → "Got it"
```

### First-Tap Consent (MediaProjection)

On the very first tap of the session, Android shows its native consent dialog:
`"AI Guardian wants to capture your screen."`

Do not suppress or pre-explain this — let the OS dialog do its job. It is shown once per session, not every tap.

---

## F. Failure States

Every failure state must be handled gracefully. The app must never silently fail.

### 1. Capture Permission Denied (MediaProjection)

**What happens:** User taps Help button but denies the capture consent dialog.
**Response:** Small toast: "Screen capture needed to scan content. Tap Help again to retry."
**No crash. No loop. One clear message.**

### 2. Accessibility Not Granted

**What happens:** User skipped Step 3. Text scoring unavailable.
**Response:** App runs without text scoring. W_text weight redistributed to W_image.
```
Adjusted weights (no accessibility):
  W_visual = 0.55
  W_image  = 0.45
  W_text   = 0.0
```
No error shown to user. Degrades gracefully.

### 3. Model Inference Fails

**What happens:** TFLite runtime throws exception (OOM, model file corrupt, etc.)
**Response:**
- Log error locally (no personal data in log).
- Run without image score: W_image redistributed to W_visual.
- Show Settings indicator: "Image detection temporarily unavailable."
- Retry model load on next app launch.

### 4. False Positive Rate Too High

**What happens:** User keeps tapping "Show it" (3+ times in a session).
**Response:**
- Raise the threshold by +0.10 for the rest of the session.
- Show one soft message: "Got it — I'll be less aggressive."
- Do not penalise the user or show an error.

### 5. Device Too Slow (> 800ms)

**What happens:** Pipeline takes too long on low-end device.
**Response:**
- Skip OCR (most expensive step). Use accessibility text only.
- If still slow: disable image model, use pHash + text only.
- Flag slow device in local prefs. Apply lighter config permanently.

### 6. Storage Full

**What happens:** Local DB cannot write new harm_event.
**Response:**
- Delete oldest 20% of records (FIFO).
- Proceed with write.
- Show Settings warning: "Old detection history was cleared to free space."

---

## G. Performance Strategy

### Latency Budget Breakdown

| Step | Budget | Notes |
|---|---|---|
| Capture frame | 100ms | Scale to 720p before capture |
| pHash compute + lookup | 30ms | Simple bitwise ops |
| Image model inference | 200ms | MobileNetV3 quantised INT8 |
| Text extraction | 150ms | AccessibilityService is faster than OCR |
| Text scoring | 20ms | In-memory map lookup |
| Decision | 10ms | Simple arithmetic |
| Blur render | 50ms | RenderEffect is GPU-accelerated |
| **Total** | **560ms** | Target < 800ms with render pipeline |

### Battery Strategy

- **No background loops.** Full stop. Nothing runs until user taps.
- MediaProjection session is kept alive (so user doesn't re-consent every tap) but the virtual display only captures on tap — not on a timer.
- AccessibilityService listens for `TYPE_WINDOW_CONTENT_CHANGED` events only, not continuous polling.
- Foreground service shows a persistent notification (Android requirement). Make notification copy reassuring: "AI Guardian is ready — tap the button anytime."

### Memory

- Bitmaps are released immediately after inference.
- TFLite interpreter is initialised once at service start, reused per session.
- Room DB is the only persistent state. Keep < 1000 rows (prune oldest if exceeded).

---

## H. iOS — V1 Position

iOS cannot support the core product loop. The constraints are hard:

- `UIWindow` overlay does not appear over other apps in the foreground.
- `ReplayKit` requires explicit user interaction per recording session — it cannot be triggered silently by a button tap.
- `AccessibilityService`-style cross-app text reading does not exist.

**V1 decision: iOS is excluded from the core guardian feature.**

iOS v1 (if shipped at all) is a companion app only:

| iOS Feature | Description |
|---|---|
| Harm journal | User manually logs upsetting content they saw |
| Session tracker | User marks start/end of a social media session |
| Mental health resources | Static + curated resource screen |
| Settings sync | Syncs sensitivity/keyword prefs via Base44 |

This is a genuine, useful product for iOS users — but it does not pretend to do what Android does.

**Do not ship iOS with a blur feature that does not work. It will destroy trust.**

---

## I. Base44 Integration

### What Base44 Serves

```
Base44 App (React-style pages)
├── /onboarding        — 4-screen onboarding flow
├── /settings          — sensitivity, keyword prefs, reset data
├── /resources         — mental health links, emergency contacts
├── /session-review    — optional: review session stats (non-sensitive)
└── /paywall           — premium upsell

Base44 Functions
├── getFeatureFlags()  — thresholds, weights, kill switches
├── getKeywordList()   — keyword list update (synced to device, runs locally)
├── logCrash()         — opt-in anonymous crash report
└── getConfig()        — app version, model version, forced update flag
```

### Sync Strategy

- On app launch: fetch feature flags + keyword list from Base44. Store locally.
- If fetch fails: use last cached version. Never block on network.
- Sensitive data (harm events, pHash store): never sent to Base44. Ever.

### Analytics (Non-Sensitive, Opt-In)

Only these events are sent, and only if user opted in during onboarding:

```json
{ "event": "blur_triggered", "app_package": "com.instagram.android", "session_id": "anon_hash" }
{ "event": "feedback_yes" }
{ "event": "feedback_show_it" }
{ "event": "session_start" }
{ "event": "session_end", "blur_count": 3 }
```

No content. No hashes. No text. Just counts.

---

## J. Risks + Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Play Store rejection for accessibility abuse | HIGH | Write a clear accessibility service description. Use it only for text reading, not control. Follow Google's policy exactly. |
| Over-blurring destroys user trust | HIGH | Default to Medium sensitivity (0.55 threshold). Include "less aggressive" mode prominently. Show false positive rate in settings. |
| Battery complaints | HIGH | No background loops. Foreground notification is visible. Let user quit the service from notification. |
| MediaProjection consent fatigue | MEDIUM | Session-scoped consent — ask once per session, not per tap. |
| Model is wrong for user's language | MEDIUM | Keyword list handles non-English. Image model is language-agnostic. Text model is English-first — flag this clearly. |
| App used to spy on others | MEDIUM | Permission flow is explicit. MediaProjection shows a persistent cast indicator. Cannot hide it. |
| User deletes app and wants their data | LOW | Settings screen has "Delete all local data" — wipes Room DB and shared prefs. No server data to delete. |
| pHash collision (different image, same hash) | LOW | Hamming distance threshold of 10 is conservative. Collision rate is negligible at user-scale. |

---

## K. V2 Roadmap (Only After V1 Is Stable)

Build these in order. Do not start until V1 has real users and real feedback.

### V2.1 — Smarter Region Detection
- Replace full-screen blur with bounding-box detection (YOLOv8 Nano TFLite).
- Blur only the specific post or image, not the whole screen.

### V2.2 — Account Pattern Memory
- Extract account handle from accessibility tree.
- Store account hash + strike count locally.
- Auto-blur content from repeat-offender accounts.

### V2.3 — Proactive Mode (Opt-In, Explicit)
- User explicitly enables "watch mode" — a toggle, not a default.
- Capture on `TYPE_WINDOW_CONTENT_CHANGED` events, not a timer loop.
- Rate-limited: max 1 capture per 5 seconds.
- Show persistent indicator when active so user always knows it's running.

### V2.4 — iOS Core Feature (If Apple Opens APIs)
- Monitor ScreenShield / Screen Time API evolution.
- Re-evaluate when iOS 20+ lands.

### V2.5 — On-Device Personalisation
- Lightweight fine-tuning of the text classifier using confirmed feedback.
- Only after 200+ confirmed harm events (enough signal to be useful).

### V2.6 — Federated Model Improvement (Opt-In)
- Users opt in to share differential-privacy-protected gradients.
- Improves the base model without sharing content.

---

## Quick Reference — V1 Do / Do Not

| Do | Do Not |
|---|---|
| Capture on tap only | Capture in the background |
| Store derived features | Store screenshots |
| Show what you're doing | Run silently |
| Degrade gracefully | Crash or freeze |
| Use existing pre-built models | Train models from scratch |
| Keep iOS honest | Ship iOS with a broken feature |
| Let user delete everything | Hold any data after deletion |
| Show persistent notification | Run as a hidden service |

---

*Spec version: 2.0 — March 2026. Supersedes V1.*
