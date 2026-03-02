// ─────────────────────────────────────────────────────────────────────────────
// runTransferSweepBatch  (Base44 / Deno serverless function)
//
// Triggered by cron every ~2 minutes.  Processes one page of active players
// per invocation and evaluates each for a transfer.  Progress is persisted
// in the TransferSweepJob entity so each cron call picks up where the last
// one left off.  The job is only marked "completed" when the DB returns fewer
// rows than BATCH_SIZE, proving we have exhausted all eligible players.
// ─────────────────────────────────────────────────────────────────────────────

/** How many players to fetch per cron invocation. Tune to stay under 50 s. */
const BATCH_SIZE = 25;

/**
 * Hard stop at 50 s to leave a comfortable buffer before Base44's 60 s Deno
 * timeout.  We never mark the job complete because of a timeout — only because
 * the DB returned an empty or partial page.
 */
const TIMEOUT_MS = 50_000;

// Expose the Base44 runtime client as a module-level type so TypeScript knows
// it exists.  Base44 injects `base44` into Deno's global scope at runtime.
declare const base44: any;

export default async function runTransferSweepBatch(
  _data: Record<string, unknown>,
  context: { req: Request; user?: { role: string } },
): Promise<unknown> {
  const { req, user } = context;

  // ── 1. Auth ─────────────────────────────────────────────────────────────
  // Accept:  valid x-cron-secret header  OR  an admin user.
  // Reject:  everything else (public callers, regular users, etc.).
  const cronSecret = req.headers.get("x-cron-secret");
  const isValidCron =
    cronSecret != null && cronSecret === Deno.env.get("CRON_SECRET");
  const isAdmin = user?.role === "admin";

  if (!isValidCron && !isAdmin) {
    return { error: "Unauthorized", status: 401 };
  }

  const startTime = Date.now();

  // ── 2. Find the most-recent running TransferSweepJob ────────────────────
  // IMPORTANT: sort by created_at DESC so we always pick up the latest job,
  // not an old stale one that happened to be inserted first.
  const jobs: any[] = await base44.entities.TransferSweepJob.list({
    filters: [{ field: "status", operator: "eq", value: "running" }],
    sort: [{ field: "created_at", direction: "desc" }],
    limit: 1,
  });

  if (!jobs || jobs.length === 0) {
    return {
      message: "No running TransferSweepJob found — nothing to process.",
    };
  }

  const job = jobs[0];
  // batch_offset tracks how many players have been processed across all prior
  // invocations of this job.
  const offset: number =
    typeof job.batch_offset === "number" ? job.batch_offset : 0;
  // window_id comes from the job's mode field (set when the job was created).
  const windowId: string = job.mode ?? "regular";

  console.log(
    `[TransferSweep] Job ${job.id} | mode=${windowId} | offset=${offset}`,
  );

  // ── 3. Fetch one page of active players ─────────────────────────────────
  // We rely on Base44's filter operator support to push the is_active=true
  // predicate server-side.  Sort by id asc gives stable, gap-free pagination.
  // If Base44 does not support these operators in your environment, remove the
  // filters array and manually filter the returned array — but keep the sort.
  const players: any[] = await base44.entities.Player.list({
    filters: [{ field: "is_active", operator: "eq", value: true }],
    sort: [{ field: "id", direction: "asc" }],
    limit: BATCH_SIZE,
    offset,
  });

  // Empty page means we have walked past the last eligible player.
  if (!players || players.length === 0) {
    await base44.entities.TransferSweepJob.update(job.id, {
      status: "completed",
      completed_at: new Date().toISOString(),
      batch_offset: offset,
    });
    console.log(
      `[TransferSweep] Job ${job.id} completed — no more players at offset ${offset}`,
    );
    return { message: "Job completed — no more eligible players", jobId: job.id };
  }

  // ── 4. Evaluate each player (with timeout guard) ─────────────────────────
  let processedThisRun = 0;

  for (const player of players) {
    // Check timeout BEFORE starting each player so we don't overrun.
    if (Date.now() - startTime > TIMEOUT_MS) {
      console.log(
        `[TransferSweep] Timeout reached after ${processedThisRun} players. ` +
          `Will resume at offset ${offset + processedThisRun} next run.`,
      );
      break;
    }

    try {
      // IMPORTANT: invoke as service role so evaluatePlayerTransfers'
      // auth guard does not block this internal call.  Using plain
      // base44.functions.invoke would fail because this function does not
      // carry an admin user or x-cron-secret that evaluatePlayerTransfers
      // would accept.
      await base44.asServiceRole.functions.invoke("evaluatePlayerTransfers", {
        playerId: player.id,
        jobId: job.id,
        windowId,
      });
    } catch (err) {
      // Log but never abort the batch — one bad player must not stop the rest.
      console.error(
        `[TransferSweep] Error evaluating player ${player.id}:`,
        err,
      );
    }

    processedThisRun++;
  }

  // ── 5. Determine job completion ──────────────────────────────────────────
  // A full page (players.length === BATCH_SIZE) means the DB may have more
  // rows — we cannot mark the job complete yet.
  // A partial page (players.length < BATCH_SIZE) proves we fetched the last
  // available row; the job is now complete.
  //
  // CRITICAL: Do NOT use (processedThisRun < BATCH_SIZE) here — that would
  // incorrectly mark the job complete on a timeout, even when rows remain.
  const reachedEnd = players.length < BATCH_SIZE;
  const newOffset = offset + processedThisRun;

  if (reachedEnd) {
    await base44.entities.TransferSweepJob.update(job.id, {
      status: "completed",
      completed_at: new Date().toISOString(),
      batch_offset: newOffset,
    });
    console.log(
      `[TransferSweep] Job ${job.id} completed — all eligible players processed`,
    );
  } else {
    // Persist the new offset so the next cron invocation continues from here.
    await base44.entities.TransferSweepJob.update(job.id, {
      batch_offset: newOffset,
    });
    console.log(
      `[TransferSweep] Job ${job.id} partial run — new offset ${newOffset}`,
    );
  }

  return {
    jobId: job.id,
    windowId,
    offset,
    processedThisRun,
    newOffset,
    reachedEnd,
  };
}
