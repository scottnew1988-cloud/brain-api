# AI Guardian — Full Technical & Product Specification

**App Name:** AI Guardian
**Platforms:** iOS & Android
**Purpose:** A floating overlay button that a user taps while scrolling social media. It scans what's on screen, blurs harmful content, and gets smarter over time — all on-device, no data ever leaves the phone.

---

## What This App Does (Plain English)

1. A small floating "Help" button sits on top of every other app.
2. User is scrolling Instagram/TikTok/Twitter and sees something upsetting.
3. They tap the button. The app takes a screenshot, analyses it on-device, and blurs anything harmful.
4. Over time the app learns what triggers *this specific user* and starts blurring proactively — before the user even has to tap.
5. If someone keeps getting triggered in one session, the app gently offers mental health resources.

---

## 1. Architecture

### The Simple Mental Model

```
[User taps Help button]
        ↓
[Screenshot captured]
        ↓
[On-device AI analyses image + text]
        ↓
[Harmful content? → Blur it]
        ↓
[User confirms: "Yes that was harmful" or "No, show it"]
        ↓
[Model updates locally — learns for next time]
```

### Tech Stack (Keep It Simple)

| Layer | iOS | Android |
|-------|-----|---------|
| Overlay UI | `UIWindow` always-on-top | `WindowManager` OVERLAY permission |
| Screen capture | `UIScreen` / ReplayKit | `MediaProjection` API |
| Accessibility (read screen text) | Accessibility API | `AccessibilityService` |
| On-device AI | Core ML (`.mlmodel` file) | TensorFlow Lite (`.tflite` file) |
| Local database | SQLite via SQLCipher (encrypted) | Same |
| Cross-platform UI | React Native or Flutter (your choice) |

### Project Folder Structure

```
ai-guardian/
├── app/
│   ├── overlay/          # The floating button + blur UI
│   ├── ml/               # Model files + inference code
│   ├── learning/         # The personal learning logic
│   ├── database/         # Encrypted local storage
│   ├── accessibility/    # Screen reading helpers
│   └── screens/          # Settings, onboarding, help resources
├── models/
│   ├── base_model.mlmodel  (iOS)
│   └── base_model.tflite   (Android)
└── docs/
```

---

## 2. The Learning Algorithm

### How It Works (No Jargon)

Think of it like this: every time a user taps "Help", the app saves a fingerprint of that content. Over time it builds a personal "harm map" for that user. No two harm maps are the same.

### What Gets Saved Locally Per Trigger Event

```json
{
  "timestamp": "2026-03-26T14:22:00",
  "content_features": {
    "visual_hash": "abc123",        // perceptual hash of image
    "text_snippet": "hashed text",  // hashed, not raw text
    "account_handle_hash": "xyz",   // hashed username
    "dominant_colours": ["#FF0000"],
    "detected_emotion": "anger"     // from on-device face/emotion model
  },
  "user_confirmed_harmful": true,
  "session_id": "session_042"
}
```

### Clustering (How It Groups Similar Content)

The app groups past triggers into clusters. When new content matches a cluster, it blurs automatically.

Four cluster types:

| Cluster Type | What It Looks At | Example |
|---|---|---|
| Visual | Image similarity (perceptual hash) | Same meme template repeated |
| Semantic | Text meaning (on-device embeddings) | Different words, same toxic message |
| Account | Same account keeps appearing | Repeat offender account |
| Emotional | Emotional tone detected | Content that always makes user anxious |

**Implementation:** Use k-means clustering locally. Start with k=5 clusters. Re-cluster every 50 new trigger events. Store cluster centroids in the local DB.

### Federated Learning Note

This app does NOT need a central server for learning. Each phone learns independently. If you later want to improve the base model across all users without sharing data, you can implement Federated Learning (Google's FL library works on Android). For v1, skip this — pure on-device is fine.

---

## 3. Content Detection — 3 Layers

### Layer 1: Reactive (User Taps Help)

- Triggered manually by user tap.
- Capture screenshot → run through ML model → blur anything flagged.
- Must complete in under 1 second. User should see blur appear almost instantly.

**Steps:**
1. Capture current screen as bitmap.
2. Run image through on-device classifier (harmful / not harmful).
3. Run OCR on visible text → run text through sentiment/toxicity classifier.
4. Any region scoring above threshold (0.7) gets blurred.
5. Show "Was this right?" prompt.

### Layer 2: Proactive (App Learns Your Patterns)

- Runs in background when the overlay is active.
- Every 3 seconds, silently captures screen and compares to known harmful clusters.
- If match confidence > 0.8, auto-blur without user needing to tap.
- Show a small notification: "I blurred something — tap to review."

**Battery note:** Run this check only when the user is in a known social media app. Detect foreground app and pause checks when it's not a social app.

### Layer 3: Account Trust Scoring

- Every account that has appeared in a harmful trigger gets a strike.
- After 3 strikes: that account is blacklisted locally.
- Any content from a blacklisted account gets auto-blurred instantly.
- User can review and whitelist accounts in Settings.

**Trust Score Formula (keep it simple):**
```
trust_score = 1.0 - (strikes / 10)
// Below 0.7 = auto-blur content from this account
// Below 0.3 = blacklist (hide entirely)
```

---

## 4. The Blur System

### Blur Levels

| Level | What It Looks Like | When It's Used |
|---|---|---|
| Soft blur (Level 1) | Gaussian blur, content still vaguely visible | First-time trigger, low confidence |
| Hard blur (Level 2) | Fully opaque blur | High confidence harmful, repeat offender |
| Content replacement | Replaced with calming image (nature, etc.) | User turns on "zen mode" in settings |

### How to Implement the Blur

On both platforms, the blur is an overlay view placed on top of the screenshot region:

```
// Pseudocode
blurView = createBlurView(region: detectedHarmfulRegion)
blurView.blurRadius = 20  // soft
blurView.opacity = 0.9
overlay.addSubview(blurView)
```

Use `UIVisualEffectView` on iOS and `RenderScript` blur on Android.

### The "Was This Right?" Feedback Loop

After every blur, show a small floating card:

```
┌─────────────────────────────┐
│ I blurred something          │
│ Was that the right call?     │
│                              │
│  ✓ Yes, thanks    ✗ Show it  │
└─────────────────────────────┘
```

- "Yes" → reinforces the model (positive training signal stored locally).
- "Show it" → removes blur, stores as false positive, updates model.

---

## 5. Privacy & Security

### Rules (Non-Negotiable)

1. **No personal data ever leaves the device.** Ever. Not screenshots, not text, not trigger history.
2. **All local data is encrypted.** Use SQLCipher for the database. Key is derived from device biometric/PIN.
3. **No social media API.** We never talk to Instagram, TikTok, or Twitter servers. We read the screen through accessibility — that's it.
4. **Model weights are stored encrypted** in the app's private sandbox directory.
5. **No analytics SDK** that phones home with user behaviour (no Firebase Analytics, no Mixpanel).

### What You CAN Send to a Server (Optional, Opt-In Only)

- Anonymous crash reports (no user data, just stack traces).
- Aggregate stats: "X% of users blurred content today" — no individual data, no content.
- Model improvement: only with explicit user consent, and only differential privacy-protected gradients (not raw data).

### Database Schema (SQLite, Encrypted)

```sql
-- Stores each time user triggered a blur
CREATE TABLE trigger_events (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  timestamp INTEGER,
  visual_hash TEXT,         -- perceptual hash, not the image
  text_hash TEXT,           -- hashed text snippet
  account_hash TEXT,        -- hashed account handle
  emotion_label TEXT,
  user_confirmed INTEGER,   -- 1 = yes harmful, 0 = false positive
  cluster_id INTEGER
);

-- Stores learned clusters
CREATE TABLE clusters (
  id INTEGER PRIMARY KEY,
  cluster_type TEXT,        -- 'visual', 'semantic', 'account', 'emotional'
  centroid BLOB,            -- serialised vector
  size INTEGER,
  last_updated INTEGER
);

-- Account trust scores
CREATE TABLE account_trust (
  account_hash TEXT PRIMARY KEY,
  strikes INTEGER DEFAULT 0,
  trust_score REAL DEFAULT 1.0,
  blacklisted INTEGER DEFAULT 0
);
```

---

## 6. The Help Button UX

### Visual Design

- Small circular button, 56dp diameter.
- Default position: bottom-right corner, 16dp from edge.
- User can drag it anywhere — position saves between sessions.
- Semi-transparent when idle (70% opacity), fully opaque on hover/tap.
- Icon: a simple shield or hand icon.

### Tap Behaviour

```
Single tap → trigger scan (Layer 1)
Long press → open quick settings (toggle proactive mode on/off)
Double tap → emergency escalation (see below)
```

### Haptic Feedback

| Event | Haptic Pattern |
|---|---|
| Button tap | Light impact |
| Blur applied | Medium impact |
| Content cleared (show it) | Soft notification |
| Emergency escalation | Heavy impact × 3 |

### Emergency Escalation

**Trigger:** 5 or more harmful triggers in a single session.

**What happens:**
1. Button pulses with a gentle glow animation.
2. After 5th trigger, a soft banner appears at top of screen:

```
┌──────────────────────────────────────┐
│ You've seen a lot of difficult        │
│ content today. You okay?             │
│                                      │
│  I'm fine    →  See support options  │
└──────────────────────────────────────┘
```

3. "See support options" opens an in-app resource screen with:
   - Crisis Text Line
   - Samaritans (UK) / local equivalent
   - "Take a break" button that locks the user out of social apps for 10 minutes (using Screen Time API on iOS / Digital Wellbeing on Android).

**No data is sent anywhere when this triggers.** The resource screen is fully local.

---

## 7. Platform Compatibility

### iOS Implementation

**Overlay Button:**
```swift
// Create a window at the highest level
let overlayWindow = UIWindow(windowScene: scene)
overlayWindow.windowLevel = .statusBar + 1
overlayWindow.isHidden = false
overlayWindow.rootViewController = OverlayViewController()
```

**Screen Capture:**
```swift
// Capture current screen
let renderer = UIGraphicsImageRenderer(bounds: UIScreen.main.bounds)
let screenshot = renderer.image { _ in
    UIApplication.shared.windows.first?.drawHierarchy(in: UIScreen.main.bounds, afterScreenUpdates: true)
}
```

**Read Screen Text (Accessibility):**
Use `AXUIElement` API to read text from the current app's accessibility tree. No screenshot needed for text — faster and less battery.

**Required Permissions (Info.plist):**
```xml
<key>NSAccessibilityUsageDescription</key>
<string>Needed to read screen content to protect you from harmful posts</string>
```

---

### Android Implementation

**Overlay Button:**
```kotlin
// Add floating view over all apps
val params = WindowManager.LayoutParams(
    WindowManager.LayoutParams.WRAP_CONTENT,
    WindowManager.LayoutParams.WRAP_CONTENT,
    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
    PixelFormat.TRANSLUCENT
)
windowManager.addView(floatingButton, params)
```

**Screen Capture:**
```kotlin
// Request MediaProjection permission (user must approve once)
val mediaProjectionManager = getSystemService(MediaProjectionManager::class.java)
startActivityForResult(mediaProjectionManager.createScreenCaptureIntent(), REQUEST_CODE)
```

**Read Screen Text (Accessibility Service):**
```xml
<!-- res/xml/accessibility_service_config.xml -->
<accessibility-service
    android:accessibilityEventTypes="typeWindowContentChanged|typeWindowStateChanged"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:canRetrieveWindowContent="true" />
```

**Required Permissions (AndroidManifest.xml):**
```xml
<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
```

---

### Fallback Strategy (If Accessibility Is Denied)

If user denies accessibility permissions:
- Fall back to screenshot-only mode (manual tap only, no text reading).
- Show onboarding prompt explaining why accessibility helps.
- App still works, just less accurate on text-based harm.

---

## 8. The ML Models

### What Models You Need

| Model | Job | Size Target | Format |
|---|---|---|---|
| Image classifier | Is this image harmful? (yes/no + confidence) | < 5MB | CoreML / TFLite |
| Text toxicity | Is this text toxic/harmful? | < 3MB | CoreML / TFLite |
| Emotion detector | What emotion does this content provoke? | < 4MB | CoreML / TFLite |
| Embedding model | Convert text to vector for clustering | < 8MB | CoreML / TFLite |

### Where to Get Pre-Built Models (Don't Train From Scratch)

- **Image classifier:** Start with MobileNetV3 (available in TFLite Model Hub). Fine-tune on a harmful content dataset (use Jigsaw Toxic Comment dataset + NSFW image datasets).
- **Text toxicity:** Use Google's pre-trained TFLite text classification model.
- **Emotion:** Use FER (Facial Expression Recognition) model from TFLite examples.
- **Embeddings:** Use MobileBERT (TFLite) — small enough for mobile, good enough for clustering.

### On-Device Model Update Flow

```
[Base model ships with app]
        ↓
[User generates trigger events]
        ↓
[Every 50 events: local fine-tuning run]
        ↓
[New weights saved encrypted to local storage]
        ↓
[Next inference uses updated weights]
```

Fine-tune using Core ML's `updatableModel` feature (iOS) or TFLite Model Maker (Android). This runs in the background when phone is charging and on WiFi.

---

## 9. Monetisation

### Free Tier

- Manual tap to blur (Layer 1).
- Basic image detection.
- Up to 100 trigger events stored.
- Emergency escalation resources.

### Premium Tier ($4.99/month or $39.99/year)

- Proactive background scanning (Layer 2).
- Account trust scoring + blacklist (Layer 3).
- Unlimited trigger history.
- Advanced clustering (all 4 cluster types).
- Content replacement (zen mode).
- Export your harm profile (local export only, as encrypted file).
- Priority model updates.

### Implementation

Use RevenueCat SDK — it handles subscriptions on both iOS and Android with one API. Much simpler than implementing StoreKit + Play Billing separately.

```javascript
// RevenueCat setup (React Native example)
import Purchases from 'react-native-purchases';
Purchases.configure({ apiKey: 'your_key' });

const offerings = await Purchases.getOfferings();
// Show paywall UI
await Purchases.purchasePackage(offering.monthly);
```

---

## 10. Onboarding Flow (Keep It Short)

```
Screen 1: "Meet your Guardian"
→ One sentence what it does
→ "Get Started" button

Screen 2: "Give it one permission"
→ Explain overlay permission (Android) or Accessibility (iOS)
→ Deep link straight to Settings page for the permission
→ "Done, let's go" once detected

Screen 3: "Your first blur"
→ Quick demo showing the blur in action (fake feed, no real content)
→ "I get it" → drops into Settings/home

Screen 4 (optional): "Stay safe, stay private"
→ One screen explaining no data leaves the device
→ "I trust it" → done
```

---

## 11. Settings Screen

| Setting | Default | Notes |
|---|---|---|
| Proactive scanning | OFF | Premium only |
| Blur level | Soft | Soft / Hard / Replace |
| Zen mode content | Nature | Nature / Abstract / Blank |
| Account blacklisting | ON | Premium only |
| Session sensitivity | Medium | Low / Medium / High (affects trigger threshold) |
| Emergency escalation | ON | Triggers after 5 hits/session |
| Break duration | 10 min | How long "take a break" locks apps |
| Clear all learned data | — | Wipes local DB and resets model |

---

## 12. What to Build First (Suggested Order)

1. **Floating overlay button** — get this working on both platforms first. Everything else depends on it.
2. **Screenshot capture** — when button is tapped, capture screen. Log the bitmap. Nothing fancy yet.
3. **Basic image classifier** — plug in MobileNet TFLite model, run inference on captured bitmap.
4. **Blur UI** — overlay a blur view on the flagged region. Hard-coded position is fine for now.
5. **"Was this right?" feedback card** — show it after every blur. Store the response in SQLite.
6. **Text reading via accessibility** — read visible text from screen, run through toxicity model.
7. **Learning/clustering** — once you have 50+ test events, build the clustering logic.
8. **Proactive background scanning** — add the 3-second polling loop.
9. **Account trust scoring** — track account hashes and apply trust scores.
10. **Emergency escalation** — count session triggers, show resource screen at threshold.
11. **Monetisation** — add RevenueCat, gate premium features.
12. **Polish** — haptics, animations, onboarding flow.

---

## 13. Third-Party Libraries (Recommended)

| Library | Purpose | Platform |
|---|---|---|
| RevenueCat | Subscriptions | Both |
| SQLCipher | Encrypted SQLite | Both |
| TensorFlow Lite | On-device ML | Android |
| Core ML | On-device ML | iOS |
| React Native or Flutter | Cross-platform UI | Both |
| react-native-vision-camera | Camera/screen access helper | Both |
| expo-haptics | Haptic feedback | Both (if using Expo) |

---

## 14. Key Numbers to Target

| Metric | Target |
|---|---|
| Blur appears after tap | < 800ms |
| Background scan interval | Every 3 seconds |
| Model size (total on disk) | < 25MB |
| Battery usage (background) | < 3% per hour |
| Cold start (app launch) | < 2 seconds |
| Local DB size (1 year of use) | < 50MB |

---

*Spec version: 1.0 — March 2026*
