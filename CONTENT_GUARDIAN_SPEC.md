# AI Content Guardian — Product Specification

**Version:** 1.0
**Status:** Draft
**Last Updated:** 2026-03-28
**Repo:** scottnew1988-cloud/brain-api

---

## 1. Overview

AI Content Guardian is a moderation and safety layer built into the Brain API platform. It intercepts all inbound user messages and outbound AI responses, classifying content in real time and enforcing configurable policies — blocking, flagging, or rewriting content before it reaches the player or the AI model.

The system is designed to be **transparent in safe cases** (zero latency impact for clean content) and **decisive in harmful cases** (block or sanitise before delivery).

---

## 2. Problem Statement

The Brain API exposes an AI agent chat endpoint (`POST /api/agent/chat`) that accepts free-text input from players. As the user base scales, several risks emerge:

| Risk | Example |
|---|---|
| Prompt injection | Player sends instructions to override the agent's persona |
| Abusive / toxic content | Slurs, threats, harassment directed at the agent or other users |
| Personal data leakage | Player accidentally sends PII (email, card number) |
| Age-inappropriate content | Explicit language in a game environment targeted at minors |
| Spam / bot flooding | High-frequency identical or near-identical messages |

Without a guardian layer, these risks are handled ad-hoc (or not at all) inside individual response builders — creating fragile, inconsistent behaviour.

---

## 3. Goals

- **Protect players** from receiving harmful or inappropriate AI-generated content.
- **Protect the platform** from prompt injection, data exfiltration, and abuse.
- **Give operators control** via a configurable policy engine — no hard-coded rules.
- **Maintain response quality** — the guardian must not degrade legitimate replies.
- **Be auditable** — every moderation decision is logged with reason codes.

---

## 4. Non-Goals

- Full human moderation review queue (out of scope for v1; designed to accommodate in v2).
- Image / media moderation (text only for v1).
- Cross-platform content moderation outside of brain-api.

---

## 5. Architecture

```
Player
  │
  ▼
[Inbound Guardian]  ◄─── Policy Engine
  │  classify + enforce
  ▼
[AI Agent Router]   (existing /api/agent/chat logic)
  │
  ▼
[Outbound Guardian] ◄─── Policy Engine
  │  classify + enforce
  ▼
Player (response delivered)
  │
  ▼
[Audit Log]
```

The guardian runs as **Express middleware**, wrapping the existing agent endpoint. No changes are required to the response builders.

---

## 6. Content Classification

### 6.1 Categories

| ID | Category | Description | Default Action |
|---|---|---|---|
| `SAFE` | Safe | No issues detected | Pass through |
| `PROMPT_INJECTION` | Prompt injection | Attempts to override system prompt or agent persona | Block |
| `TOXIC` | Toxic / abusive | Hate speech, slurs, threats, severe profanity | Block |
| `MILD_PROFANITY` | Mild profanity | Casual swearing not directed at anyone | Warn / Pass |
| `PII` | Personal data | Email, phone, card numbers, passwords | Redact + Warn |
| `SPAM` | Spam / flood | Repeated identical messages, nonsense strings | Rate-limit |
| `OFF_TOPIC_SEVERE` | Severely off-topic | Illegal activity, explicit adult content | Block |
| `JAILBREAK` | Jailbreak attempt | "Ignore previous instructions", DAN-style prompts | Block |

### 6.2 Classifier Pipeline

Each message passes through the following classifiers in order. Processing stops at the first `Block` verdict.

```
1. Rate-limit check       → SPAM if threshold exceeded
2. Length check           → SPAM if > MAX_MESSAGE_LENGTH chars
3. PII detector           → regex patterns (email, phone, card)
4. Injection detector     → keyword + pattern matching (rule-based)
5. Toxicity classifier    → ML model (configurable: local or API)
6. Off-topic classifier   → keyword list + similarity threshold
```

The classifier is **modular** — each stage is a standalone function with a consistent interface:

```js
// classifier interface
async function classify(text, context) {
  // returns: { category, confidence, matchedPatterns }
}
```

---

## 7. Policy Engine

Operators configure per-category actions via a policy object (stored in config or DB):

```js
const DEFAULT_POLICY = {
  PROMPT_INJECTION:  { action: "block",   response: "guardian:injection_blocked" },
  TOXIC:             { action: "block",   response: "guardian:toxic_blocked" },
  MILD_PROFANITY:    { action: "pass",    log: true },
  PII:               { action: "redact",  response: "guardian:pii_redacted" },
  SPAM:              { action: "block",   response: "guardian:spam_blocked" },
  OFF_TOPIC_SEVERE:  { action: "block",   response: "guardian:offtopic_blocked" },
  JAILBREAK:         { action: "block",   response: "guardian:jailbreak_blocked" },
  SAFE:              { action: "pass" },
};
```

**Actions:**

| Action | Behaviour |
|---|---|
| `pass` | Forward to agent unchanged |
| `block` | Return a guardian-managed safe response; agent never sees message |
| `redact` | Strip matched PII, forward sanitised message to agent |
| `warn` | Tag response with a warning header; pass message through |

---

## 8. API Changes

### 8.1 Modified Endpoint

`POST /api/agent/chat` — behaviour unchanged for safe content. For blocked content, the response shape is identical to current responses so no client changes are required:

```json
{
  "reply": "I can only help with football career topics. What would you like to know about training, matches, or transfers?",
  "suggested_actions": [...],
  "conversation_id": "conv",
  "intent": "blocked",
  "metadata": {
    "agent_name": "Football Brain",
    "agent_role": "Career Advisor",
    "guardian": {
      "triggered": true,
      "category": "PROMPT_INJECTION",
      "action": "block"
    }
  }
}
```

The `metadata.guardian` field is **always present** in responses:

- Safe: `{ "triggered": false }`
- Blocked/acted on: `{ "triggered": true, "category": "...", "action": "..." }`

### 8.2 New Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/guardian/health` | Guardian status, classifier versions |
| `GET` | `/api/guardian/stats` | Moderation counts by category (last 24h) |
| `GET` | `/api/guardian/policy` | Return current active policy |
| `PUT` | `/api/guardian/policy` | Update policy (admin auth required) |
| `GET` | `/api/guardian/audit` | Paginated audit log (admin auth required) |

---

## 9. Audit Logging

Every message processed by the guardian is logged:

```js
{
  id: "uuid",
  timestamp: "ISO8601",
  conversation_id: "...",
  player_id: "...",
  direction: "inbound" | "outbound",
  original_text_hash: "sha256(text)",  // hashed — no raw PII stored
  category: "SAFE" | "TOXIC" | ...,
  action: "pass" | "block" | "redact" | "warn",
  confidence: 0.0 - 1.0,
  matched_patterns: ["..."],
  policy_version: "1.0"
}
```

**Privacy:** Raw message text is never stored. Only the SHA-256 hash is logged, enabling correlation without retaining content.

---

## 10. Rate Limiting

The guardian enforces per-player message rate limits to prevent flooding:

| Window | Limit | Action |
|---|---|---|
| 10 seconds | 5 messages | Soft warn |
| 60 seconds | 20 messages | Block for 60s |
| 10 minutes | 60 messages | Block for 10 min |

Rate limit state is stored in-memory (development) or Redis (production). The existing `conversation_id` / `player_id` fields are used as the rate limit key.

---

## 11. Guardian Responses (Canned Replies)

Blocked messages return friendly, on-brand responses that fit the Football Brain persona. Each category has three engagement-tier variants (matching the existing `low` / `medium` / `high` system):

**Example — `TOXIC` block, high engagement tier:**
> "That kind of language isn't the way we operate here. Let's keep it professional — I'm here to get you to the top, but only if we're working together properly."

**Example — `PROMPT_INJECTION` block (all tiers):**
> "I'm your football agent, not a general assistant. Let's keep the focus on your career — what do you need help with?"

**Example — `PII` redact warning:**
> "I've removed some personal details from your message for your own security. Here's what I can help with..."

Full canned response catalogue: see `src/guardian/responses.js` (to be created in implementation).

---

## 12. Implementation Plan

### Phase 1 — Core Infrastructure (Week 1)

- [ ] `src/guardian/index.js` — middleware entry point
- [ ] `src/guardian/classifiers/pii.js` — regex-based PII detection
- [ ] `src/guardian/classifiers/injection.js` — prompt injection / jailbreak detection
- [ ] `src/guardian/classifiers/rateLimit.js` — in-memory rate limiter
- [ ] `src/guardian/policy.js` — policy loader and enforcer
- [ ] `src/guardian/audit.js` — audit log writer
- [ ] Wire middleware into `server.js`

### Phase 2 — Toxicity & Responses (Week 2)

- [ ] `src/guardian/classifiers/toxicity.js` — keyword list classifier (v1), Claude API classifier (v2)
- [ ] `src/guardian/responses.js` — canned response catalogue with engagement-tier variants
- [ ] `GET /api/guardian/health` and `GET /api/guardian/stats` endpoints

### Phase 3 — Admin & Observability (Week 3)

- [ ] `GET/PUT /api/guardian/policy` — runtime policy management
- [ ] `GET /api/guardian/audit` — paginated audit log query
- [ ] Admin auth middleware (API key header `X-Guardian-Admin-Key`)
- [ ] Integration tests covering all 8 content categories

### Phase 4 — ML Upgrade (Future)

- [ ] Replace keyword toxicity classifier with Claude API (`claude-haiku-4-5`) call
- [ ] Confidence thresholds configurable per category
- [ ] Redis-backed rate limiting for multi-instance deployments

---

## 13. Configuration

All guardian settings are driven by environment variables, with safe defaults:

```env
# Guardian on/off (default: true)
GUARDIAN_ENABLED=true

# Max message length in characters (default: 2000)
GUARDIAN_MAX_MESSAGE_LENGTH=2000

# Rate limit: messages per 60s window (default: 20)
GUARDIAN_RATE_LIMIT_PER_MIN=20

# Admin API key for /api/guardian/policy and /api/guardian/audit
GUARDIAN_ADMIN_KEY=change-me-in-production

# Toxicity classifier: "keyword" (default) or "claude"
GUARDIAN_TOXICITY_CLASSIFIER=keyword

# Claude model for AI classifier (used when TOXICITY_CLASSIFIER=claude)
GUARDIAN_CLAUDE_MODEL=claude-haiku-4-5-20251001

# Log level: "none" | "blocked_only" | "all" (default: blocked_only)
GUARDIAN_LOG_LEVEL=blocked_only
```

---

## 14. Security Considerations

- Admin endpoints require `X-Guardian-Admin-Key` header. Key must be a minimum 32-character random string in production.
- Audit logs hash message content — raw text is never persisted.
- Policy updates are logged with a timestamp and requestor IP.
- The guardian itself must not be bypassable via `Content-Type` tricks or chunked encoding — input normalisation happens before classification.
- Classifier patterns should not be publicly exposed via the API (audit log shows `matched_patterns` only to admins).

---

## 15. Testing Strategy

| Test Type | Coverage Target |
|---|---|
| Unit — classifiers | Each classifier tested with ≥10 positive + ≥10 negative samples |
| Unit — policy engine | All 4 actions (pass, block, redact, warn) verified |
| Integration — middleware | Full request/response cycle for all 8 categories |
| Integration — rate limiter | Burst threshold and window reset behaviour |
| E2E — agent endpoint | Clean messages pass through unchanged; blocked messages return correct shape |

---

## 16. Open Questions

1. **Outbound moderation scope** — Should the guardian also scan AI-generated responses, or is inbound-only sufficient for v1?
2. **Human review queue** — At what volume does a manual review queue become necessary? Define the threshold.
3. **Toxicity ML model** — Is a Claude API call (with latency/cost) acceptable for v1, or do we start with keyword-only and upgrade in Phase 4?
4. **Multi-language support** — The current platform is English-only. Should the PII and toxicity classifiers handle other languages from launch?
5. **Player appeals** — Should blocked players receive any mechanism to contest a block decision?
