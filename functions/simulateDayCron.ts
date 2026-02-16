/**
 * simulateDayCron — Base44 Function (Deno)
 *
 * Triggered every 24 hours at 22:00 UK time.
 * Simulates one matchday across all EFL tiers.
 *
 * Returns per-tier status so the cron dashboard can surface failures.
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { simulateDayCore } from '../src/components/utils/simulateDayCore.jsx';

const CRON_SECRET = Deno.env.get('CRON_SECRET');

Deno.serve(async (req) => {
  // ── Auth guard ────────────────────────────────
  if (req.headers.get('x-cron-secret') !== CRON_SECRET) {
    console.warn('[simulateDayCron] Unauthorized request — missing or wrong x-cron-secret');
    return new Response('Unauthorized', { status: 401 });
  }

  const startTime = Date.now();
  console.log('[simulateDayCron] Cron triggered at', new Date().toISOString());

  try {
    const base44 = createClientFromRequest(req);

    const result = await simulateDayCore(base44, {
      tierFilter: null,
      isCron: true,
    });

    const elapsed = Date.now() - startTime;
    console.log(`[simulateDayCron] Completed in ${elapsed}ms`);

    // Check if any tier failed — return 207 (Multi-Status) if partial failure
    const tierEntries = Object.entries(result.tiers || {});
    const failures = tierEntries.filter(([, v]) => v.error || v.aborted);
    const status = failures.length > 0 ? 207 : 200;

    if (failures.length > 0) {
      console.error(`[simulateDayCron] ${failures.length}/${tierEntries.length} tiers had failures`);
    }

    return Response.json(
      { ok: failures.length === 0, result, elapsed_ms: elapsed },
      { status }
    );
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error('[simulateDayCron] FATAL ERROR after', elapsed, 'ms:', err.message || err, err.stack || '');

    return Response.json(
      { ok: false, error: err.message || String(err), elapsed_ms: elapsed },
      { status: 500 }
    );
  }
});
