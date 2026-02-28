// ──────────────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
//
// Three distinct trust boundaries:
//
//  1. requireJwt   — User-facing endpoints.
//     Verifies a JWT issued by Base44/Supabase auth.
//     Derives req.userId from the token's `sub` claim.
//     Never trusts user_id from the request body.
//
//  2. requireHmac  — Server-to-server (Base44 server function → Brain API).
//     Used for player progress sync, where Base44 is the source of truth.
//     Request body must be signed with BRAIN_HMAC_SECRET.
//     Derives req.userId from the HMAC-verified body.
//
//  3. requireCronSecret — Render Cron Job → /api/sweep/run.
//     Simple Bearer token check; no user identity is set.
//
// Required env vars:
//   AUTH_JWT_SECRET     — Supabase JWT secret (Project Settings → API)
//   BRAIN_HMAC_SECRET   — Shared secret for server-to-server requests
//   CRON_SECRET         — Secret sent by Render Cron Job
// ──────────────────────────────────────────────────────────────────────

import jwt         from "jsonwebtoken";
import crypto      from "crypto";

// ── CONSTANTS ──────────────────────────────────────────────────────────

const JWT_SECRET     = process.env.AUTH_JWT_SECRET;
const HMAC_SECRET    = process.env.BRAIN_HMAC_SECRET;
const CRON_SECRET    = process.env.CRON_SECRET;

// Maximum clock skew allowed for HMAC-signed requests (5 minutes)
const HMAC_MAX_AGE_MS = 5 * 60 * 1000;

// ── JWT MIDDLEWARE ─────────────────────────────────────────────────────

/**
 * Verify a Base44/Supabase JWT and set req.userId.
 *
 * Expects: Authorization: Bearer <token>
 *
 * Dev bypass: set NODE_ENV=development and pass X-Dev-User-Id header
 * to skip JWT verification during local testing.
 */
export function requireJwt(req, res, next) {
  // ── Development bypass (never active in production) ──────────────────
  if (process.env.NODE_ENV !== "production") {
    const devId = req.headers["x-dev-user-id"];
    if (devId) {
      req.userId = devId;
      return next();
    }
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Missing Authorization header. Expected: Bearer <token>",
    });
  }

  if (!JWT_SECRET) {
    // Misconfigured server — fail closed
    console.error("[Auth] AUTH_JWT_SECRET is not set");
    return res.status(503).json({ error: "Auth service misconfigured" });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Supabase JWTs use `sub` for the user UUID
    const userId = payload.sub ?? payload.user_id;
    if (!userId) throw new Error("Token is missing sub/user_id claim");
    req.userId = userId;
    next();
  } catch (err) {
    res.status(401).json({ error: `Invalid or expired token: ${err.message}` });
  }
}

// ── HMAC MIDDLEWARE ────────────────────────────────────────────────────

/**
 * Verify an HMAC-SHA256 signature for server-to-server requests.
 *
 * Required headers:
 *   X-Brain-Timestamp  — Unix ms timestamp (string)
 *   X-Brain-Signature  — sha256=<hex> of HMAC(secret, timestamp + "." + rawBody)
 *
 * The request body must contain a user_id field that identifies the
 * user on behalf of whom the action is performed.
 *
 * How to generate the signature in a Base44 server function (Node.js):
 *
 *   const ts  = Date.now().toString();
 *   const body = JSON.stringify(payload);
 *   const sig  = "sha256=" + crypto
 *     .createHmac("sha256", process.env.BRAIN_HMAC_SECRET)
 *     .update(ts + "." + body)
 *     .digest("hex");
 *   fetch("/api/players/:id/progress", {
 *     method: "POST",
 *     headers: {
 *       "Content-Type": "application/json",
 *       "X-Brain-Timestamp": ts,
 *       "X-Brain-Signature": sig,
 *     },
 *     body,
 *   });
 */
export function requireHmac(req, res, next) {
  if (!HMAC_SECRET) {
    console.error("[Auth] BRAIN_HMAC_SECRET is not set");
    return res.status(503).json({ error: "Server misconfigured" });
  }

  const ts  = req.headers["x-brain-timestamp"];
  const sig = req.headers["x-brain-signature"];

  if (!ts || !sig) {
    return res.status(401).json({
      error: "Missing X-Brain-Timestamp or X-Brain-Signature headers",
    });
  }

  // Replay protection — reject requests older than 5 minutes
  const tsMs = parseInt(ts, 10);
  if (!isFinite(tsMs) || Math.abs(Date.now() - tsMs) > HMAC_MAX_AGE_MS) {
    return res.status(401).json({ error: "Request timestamp is too old or invalid" });
  }

  const body     = JSON.stringify(req.body);
  const expected = "sha256=" +
    crypto.createHmac("sha256", HMAC_SECRET)
      .update(ts + "." + body)
      .digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length ||
        !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).json({ error: "Invalid HMAC signature" });
    }
  } catch {
    return res.status(401).json({ error: "Invalid HMAC signature format" });
  }

  // Signature verified — user_id from body is now trusted
  req.userId = req.body.user_id;
  if (!req.userId) {
    return res.status(400).json({ error: "HMAC body must include user_id" });
  }
  next();
}

// ── CRON SECRET MIDDLEWARE ─────────────────────────────────────────────

/**
 * Verify the Render Cron Job secret.
 *
 * Expects: Authorization: Bearer <CRON_SECRET>
 *
 * In Render: set the Cron Job HTTP header or pass the secret in the URL.
 * Keep CRON_SECRET ≥ 32 random bytes.
 */
export function requireCronSecret(req, res, next) {
  if (!CRON_SECRET) {
    console.error("[Auth] CRON_SECRET is not set");
    return res.status(503).json({ error: "Cron auth misconfigured" });
  }

  const authHeader = req.headers.authorization;
  const provided   = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!provided) {
    return res.status(401).json({ error: "Missing cron Authorization header" });
  }

  // Constant-time comparison
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(CRON_SECRET);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: "Invalid cron secret" });
    }
  } catch {
    return res.status(401).json({ error: "Invalid cron secret format" });
  }

  next();
}
