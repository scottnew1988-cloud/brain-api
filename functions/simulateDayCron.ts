/**
 * simulateDayCron — Base44 Function (Deno)
 *
 * Triggered every 24 hours at 22:00 UK time.
 * Simulates one matchday across all EFL tiers.
 *
 * Returns per-tier status so failures are visible in Base44 Function logs.
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { simulateDayCore } from '../src/components/utils/simulateDayCore.jsx';

const CRON_SECRET = Deno.env.get('CRON_SECRET');

Deno.serve(async (req) => {
  // ── Auth guard ────────────────────────────────
  if (req.headers.get('x-cron-secret') !== CRON_SECRET) {
    console.warn('[cron] Unauthorized — bad or missing x-cron-secret');
    return new Response('Unauthorized', { status: 401 });
  }

  const startTime = Date.now();
  console.log('[cron] Triggered at', new Date().toISOString());

  try {
    const base44 = createClientFromRequest(req);

    const result = await simulateDayCore(base44, {
      tierFilter: null,
      isCron: true,
    });

    const elapsed = Date.now() - startTime;

    // Surface partial failures with 207
    const tierEntries = Object.entries(result.tiers || {});
    const failures = tierEntries.filter(([, v]) => v.error || v.aborted);
    const httpStatus = failures.length > 0 ? 207 : 200;

    if (failures.length > 0) {
      console.error(`[cron] ${failures.length}/${tierEntries.length} tiers had failures`);
      for (const [t, v] of failures) {
        console.error(`[cron]   ${t}: ${v.error || 'aborted'}`);
      }
    }

    console.log(`[cron] Done in ${elapsed}ms — status ${httpStatus}`);

    return Response.json(
      { ok: failures.length === 0, result, elapsed_ms: elapsed },
      { status: httpStatus }
    );
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error('[cron] FATAL after', elapsed, 'ms:', err.message || err, err.stack || '');

    return Response.json(
      { ok: false, error: err.message || String(err), elapsed_ms: elapsed },
      { status: 500 }
    );
  }
});
