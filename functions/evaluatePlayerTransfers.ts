// ─────────────────────────────────────────────────────────────────────────────
// evaluatePlayerTransfers  (Base44 / Deno serverless function)
//
// Evaluates whether a player should be transferred this sweep window, then
// finalises the move in the correct order:
//   1. Compute window_id
//   2. Dedup check BEFORE any writes
//   3. Update player.current_club_id  (finalize transfer)
//   4. Create TransferEvent
//   5. If player.user_id exists:
//        a. Create PlayerNotification (dedup last 24 h)
//        b. Create CareerEvent agent message
//
// Auth:  service-role callers (from runTransferSweepBatch) are always allowed.
//        External callers must supply a valid x-cron-secret OR be admin.
// ─────────────────────────────────────────────────────────────────────────────

// Base44 injects `base44` into Deno's global scope at runtime.
declare const base44: any;

interface EvaluateInput {
  /** ID of the player to evaluate. Required. */
  playerId: string;
  /** ID of the currently running TransferSweepJob. Optional. */
  jobId?: string;
  /**
   * Transfer window identifier passed from runTransferSweepBatch.
   * If omitted, the function will derive it from the job record, or
   * fall back to "regular".
   */
  windowId?: string;
}

export default async function evaluatePlayerTransfers(
  data: EvaluateInput,
  context: {
    req: Request;
    user?: { role: string };
    /**
     * Base44 sets this to true when the function is invoked via
     * base44.asServiceRole.functions.invoke, bypassing user-level auth.
     */
    isServiceRole?: boolean;
  },
): Promise<unknown> {
  const { req, user, isServiceRole } = context;

  // ── 1. Auth ─────────────────────────────────────────────────────────────
  // Service-role callers (i.e. runTransferSweepBatch) must pass without
  // requiring an admin user or cron secret — they already run under elevated
  // internal permissions.  External callers still need admin or cron secret.
  const cronSecret = req.headers.get("x-cron-secret");
  const isValidCron =
    cronSecret != null && cronSecret === Deno.env.get("CRON_SECRET");
  const isAdmin = user?.role === "admin";

  if (!isServiceRole && !isAdmin && !isValidCron) {
    return { error: "Unauthorized", status: 401 };
  }

  const { playerId, jobId, windowId: inputWindowId } = data;

  if (!playerId) {
    return { error: "playerId is required", status: 400 };
  }

  // ── 2. Fetch player ──────────────────────────────────────────────────────
  // SCHEMA: Player.current_club_id  (NOT "club_id")
  const player = await base44.entities.Player.get(playerId);
  if (!player) {
    return { error: `Player ${playerId} not found`, status: 404 };
  }

  // ── 3. Compute window_id ─────────────────────────────────────────────────
  // Priority: value passed in data → value from job record → default "regular"
  let windowId: string = inputWindowId ?? "regular";
  if (!inputWindowId && jobId) {
    try {
      const job = await base44.entities.TransferSweepJob.get(jobId);
      if (job?.mode) windowId = job.mode;
    } catch {
      // If the job lookup fails, stay with the default.
    }
  }

  // ── 4. Fetch interested clubs via service-role helper ────────────────────
  // IMPORTANT: use base44.asServiceRole.functions.invoke — NOT ent.functions
  // — so the helper function receives elevated permissions and can read all
  // club data regardless of the calling user's role.
  let interestedClubs: any[] = [];
  try {
    const result = await base44.asServiceRole.functions.invoke(
      "updateInterestedClubsForPlayer",
      { playerId, windowId },
    );
    interestedClubs = result?.clubs ?? [];
  } catch (err) {
    console.error(
      `[EvaluateTransfer] updateInterestedClubsForPlayer failed for ${playerId}:`,
      err,
    );
    return {
      skipped: true,
      reason: "interested_clubs_fetch_failed",
      playerId,
    };
  }

  if (!interestedClubs.length) {
    return { skipped: true, reason: "no_interested_clubs", playerId };
  }

  // Pick the best offer.  updateInterestedClubsForPlayer is expected to return
  // clubs sorted by desirability (highest offer / best tier) descending.
  const bestClub = interestedClubs[0];
  const toClubId: string = bestClub.id;
  const fee: number = bestClub.offer_fee ?? 0;

  // SCHEMA: Player.current_club_id  (NOT "club_id")
  const fromClubId: string = player.current_club_id;

  if (!fromClubId) {
    return {
      skipped: true,
      reason: "player_has_no_current_club",
      playerId,
    };
  }

  if (toClubId === fromClubId) {
    return { skipped: true, reason: "same_club", playerId };
  }

  // Enforce upward-tier-only moves (lower club_tier = higher prestige).
  // SCHEMA: Club.club_tier
  try {
    const [fromClubData, toClubData] = await Promise.all([
      base44.entities.Club.get(fromClubId),
      base44.entities.Club.get(toClubId),
    ]);
    if (
      toClubData?.club_tier != null &&
      fromClubData?.club_tier != null &&
      toClubData.club_tier >= fromClubData.club_tier
    ) {
      return {
        skipped: true,
        reason: "lateral_or_downward_tier_move",
        playerId,
        fromTier: fromClubData.club_tier,
        toTier: toClubData.club_tier,
      };
    }
  } catch (err) {
    // If tier data is unavailable, log and continue — don't block the transfer.
    console.warn(
      `[EvaluateTransfer] Could not verify club tiers for ${playerId}:`,
      err,
    );
  }

  // ── 5. Dedup check BEFORE any writes ────────────────────────────────────
  // TransferEvent dedup key: (player_id, to_club_id, window_id).
  // If a record already exists we've already processed this transfer (e.g.
  // after a retry) — skip safely.
  // SCHEMA: TransferEvent.player_id, .to_club_id, .window_id
  const existingTransfers: any[] = await base44.entities.TransferEvent.list({
    filters: [
      { field: "player_id", operator: "eq", value: playerId },
      { field: "to_club_id", operator: "eq", value: toClubId },
      { field: "window_id", operator: "eq", value: windowId },
    ],
    limit: 1,
  });

  if (existingTransfers && existingTransfers.length > 0) {
    return {
      skipped: true,
      reason: "transfer_already_recorded",
      playerId,
      windowId,
    };
  }

  // ── 6. Fetch club display names for notifications ────────────────────────
  let fromClub: any = null;
  let toClub: any = null;
  try {
    [fromClub, toClub] = await Promise.all([
      base44.entities.Club.get(fromClubId),
      base44.entities.Club.get(toClubId),
    ]);
  } catch (err) {
    // Names are only used for human-readable messages — don't abort.
    console.warn(
      `[EvaluateTransfer] Could not fetch club names for ${playerId}:`,
      err,
    );
  }

  const now = new Date().toISOString();

  // ── 7. Finalize transfer: update player.current_club_id ─────────────────
  // SCHEMA: Player.current_club_id  (NOT "club_id")
  await base44.entities.Player.update(playerId, {
    current_club_id: toClubId,
  });

  // ── 8. Create TransferEvent ──────────────────────────────────────────────
  // SCHEMA fields: player_id, to_club_id, window_id  (plus from_club_id, fee)
  await base44.entities.TransferEvent.create({
    player_id: playerId,
    from_club_id: fromClubId,
    to_club_id: toClubId,
    window_id: windowId,
    fee,
    created_at: now,
  });

  // ── 9. User-owned player notifications ──────────────────────────────────
  if (player.user_id) {
    const twentyFourHoursAgo = new Date(
      Date.now() - 24 * 60 * 60 * 1000,
    ).toISOString();

    // Dedup PlayerNotification: only create one notification per transfer per
    // 24-hour window so users aren't spammed on retries.
    // SCHEMA: PlayerNotification.user_id, .player_id, .to_club_id,
    //         .created_at, .shown_at
    const recentNotifications: any[] =
      await base44.entities.PlayerNotification.list({
        filters: [
          { field: "user_id", operator: "eq", value: player.user_id },
          { field: "player_id", operator: "eq", value: playerId },
          { field: "to_club_id", operator: "eq", value: toClubId },
          { field: "created_at", operator: "gte", value: twentyFourHoursAgo },
        ],
        limit: 1,
      });

    if (!recentNotifications || recentNotifications.length === 0) {
      // a) Create PlayerNotification (shown_at stays null until the user views it)
      await base44.entities.PlayerNotification.create({
        user_id: player.user_id,
        player_id: playerId,
        from_club_id: fromClubId,
        to_club_id: toClubId,
        window_id: windowId,
        fee,
        created_at: now,
        shown_at: null,
      });

      // b) Enqueue CareerEvent agent message referencing fromClub/toClub/fee
      const fromClubName = fromClub?.name ?? fromClubId;
      const toClubName = toClub?.name ?? toClubId;
      const feeDisplay =
        fee > 0 ? `£${(fee / 1_000_000).toFixed(1)}M` : "free transfer";

      await base44.entities.CareerEvent.create({
        user_id: player.user_id,
        player_id: playerId,
        type: "transfer",
        message:
          `Your player has been transferred from ${fromClubName} to ` +
          `${toClubName} for ${feeDisplay}. ` +
          `This is a ${windowId} window move — a fresh chapter begins!`,
        from_club_id: fromClubId,
        to_club_id: toClubId,
        fee,
        window_id: windowId,
        created_at: now,
        // Signals the agent comment pipeline to generate a personalised reply.
        requires_agent_response: true,
      });
    }
  }

  console.log(
    `[EvaluateTransfer] Player ${playerId}: ${fromClubId} → ${toClubId} ` +
      `| window=${windowId} | fee=${fee}`,
  );

  return {
    success: true,
    playerId,
    fromClubId,
    toClubId,
    fee,
    windowId,
  };
}
