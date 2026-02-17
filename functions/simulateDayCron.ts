/**
 * simulateDayCron — Base44 Function (Deno)
 *
 * Triggered every 24 hours at 22:00 UK time.
 * Simulates one matchday across all EFL tiers.
 *
 * IMPORTANT: Imports from ./_lib/ only — NOT from /src/components/.
 * Base44 Functions (Deno) cannot resolve imports outside functions/.
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { simulateDayCore } from './_lib/simulateDayCore.ts';

Deno.serve(async (req) => {
  // TEMP: allow Test Function runs — set false after testing
  const MANUAL_TEST_MODE = true;

  // Optional cron secret check (only enforced when MANUAL_TEST_MODE = false)
  const provided = req.headers.get('x-cron-secret') || '';
  const expected = Deno.env.get('CRON_SECRET') || '';
  if (!MANUAL_TEST_MODE) {
    if (!expected || provided !== expected) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
  }

  const startTime = Date.now();
  console.log('[cron] Triggered at', new Date().toISOString());

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const result = await simulateDayCore(base44, {
      tierFilter: (body as any).tier ?? null,
      isCron: true,
    });

    const elapsed = Date.now() - startTime;

    // Surface partial failures with 207
    const tierEntries = Object.entries(result.tiers || {});
    const failures = tierEntries.filter(([, v]: any) => v?.error || v?.aborted);
    const httpStatus = failures.length > 0 ? 207 : 200;

    if (failures.length > 0) {
      console.error(`[cron] ${failures.length}/${tierEntries.length} tiers had failures`);
      for (const [t, v] of failures) {
        console.error(`[cron]   ${t}: ${(v as any).error || 'aborted'}`);
      }
    }

    console.log(`[cron] Done in ${elapsed}ms — status ${httpStatus}`);

    return Response.json(
      { ok: failures.length === 0, result, elapsed_ms: elapsed },
      { status: httpStatus }
    );
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    console.error('[cron] FATAL after', elapsed, 'ms:', err.message || err, err.stack || '');

    return Response.json(
      { ok: false, error: err.message || String(err), elapsed_ms: elapsed },
      { status: 500 }
    );
  }
});
