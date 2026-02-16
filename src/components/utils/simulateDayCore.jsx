/**
 * simulateDayCore — Base44-safe matchday simulation
 *
 * Runs one matchday across all EFL tiers simultaneously.
 * Guarantees: results + standings are confirmed before matchday advances.
 * Safe for double-fire: checks fixture status before simulating.
 */

const EFL_TIERS = ['championship', 'league_one', 'league_two'];
const EXPECTED_FIXTURES_PER_MATCHDAY = 12;

export async function simulateDayCore(base44, options = {}) {
  const { tierFilter = null, isCron = false } = options;
  const tiersToProcess = tierFilter ? [tierFilter] : EFL_TIERS;
  const summary = { tiers: {}, isCron, timestamp: new Date().toISOString() };

  for (const tier of tiersToProcess) {
    try {
      console.log(`[simulateDay][${tier}] Starting tier processing`);

      // ── 1. Load active season ──────────────────
      const season = await base44.asServiceRole.entities.Season.findFirst({
        where: { efl_tier: tier, status: 'ACTIVE' },
      });

      if (!season) {
        console.warn(`[simulateDay][${tier}] No active season found — skipping`);
        summary.tiers[tier] = { skipped: 'no active season' };
        continue;
      }

      console.log(`[simulateDay][${tier}] Active season: ${season.id}`);

      // ── 2. Load or create SeasonProgress ───────
      let progress = await base44.asServiceRole.entities.SeasonProgress.findFirst({
        where: { season_id: season.id },
      });

      if (!progress) {
        console.log(`[simulateDay][${tier}] No SeasonProgress found — creating at matchday 1`);
        progress = await base44.asServiceRole.entities.SeasonProgress.create({
          season_id: season.id,
          current_matchday: 1,
        });
      }

      const matchday = progress.current_matchday;
      console.log(`[simulateDay][${tier}] Current matchday: ${matchday}`);

      // ── 3. Load fixtures for this matchday ─────
      const fixtures = await base44.asServiceRole.entities.Fixture.findMany({
        where: {
          season_id: season.id,
          matchday,
        },
      });

      // ── IDEMPOTENCY GUARD ──────────────────────
      // If cron fires twice, fixtures may already be PLAYED.
      const scheduledFixtures = fixtures.filter(f => f.status === 'SCHEDULED');
      const playedFixtures = fixtures.filter(f => f.status === 'PLAYED');

      if (playedFixtures.length === EXPECTED_FIXTURES_PER_MATCHDAY && scheduledFixtures.length === 0) {
        console.warn(`[simulateDay][${tier}] Matchday ${matchday} already fully played (${playedFixtures.length} PLAYED fixtures) — skipping simulation, advancing matchday`);

        // Standings should already be written. Just advance matchday.
        await base44.asServiceRole.entities.SeasonProgress.update(progress.id, {
          current_matchday: matchday + 1,
        });
        await base44.asServiceRole.entities.Season.update(season.id, {
          current_matchday: matchday + 1,
        });

        summary.tiers[tier] = { ok: true, matchday, alreadyPlayed: true };
        continue;
      }

      if (scheduledFixtures.length !== EXPECTED_FIXTURES_PER_MATCHDAY) {
        console.error(`[simulateDay][${tier}] Expected ${EXPECTED_FIXTURES_PER_MATCHDAY} SCHEDULED fixtures for matchday ${matchday}, got ${scheduledFixtures.length} (total fixtures: ${fixtures.length}, played: ${playedFixtures.length})`);
        summary.tiers[tier] = {
          skipped: `expected ${EXPECTED_FIXTURES_PER_MATCHDAY} SCHEDULED fixtures, got ${scheduledFixtures.length}`,
          totalFixtures: fixtures.length,
          playedFixtures: playedFixtures.length,
        };
        continue;
      }

      // ── 4. Simulate results ────────────────────
      const results = [];
      for (const fixture of scheduledFixtures) {
        const homeGoals = Math.floor(Math.random() * 4);
        const awayGoals = Math.floor(Math.random() * 4);

        results.push({
          fixtureId: fixture.id,
          homeTeamId: fixture.home_team_id,
          awayTeamId: fixture.away_team_id,
          home_goals: homeGoals,
          away_goals: awayGoals,
        });
      }

      console.log(`[simulateDay][${tier}] Generated ${results.length} results for matchday ${matchday}`);

      // ── 5. Write fixture results ───────────────
      // FIX: Do NOT include `id` in the update payload.
      // Base44 .update(id, data) requires `data` to contain only writable fields.
      let fixtureWriteFailures = 0;

      for (const r of results) {
        try {
          await base44.asServiceRole.entities.Fixture.update(r.fixtureId, {
            // Only writable fields — no `id`, no system fields
            home_goals: r.home_goals,
            away_goals: r.away_goals,
            status: 'PLAYED',
            played_at: new Date().toISOString(),
          });
        } catch (err) {
          fixtureWriteFailures++;
          console.error(`[simulateDay][${tier}] Fixture.update FAILED for fixture ${r.fixtureId}:`, err.message || err);
        }
      }

      if (fixtureWriteFailures > 0) {
        console.error(`[simulateDay][${tier}] ${fixtureWriteFailures}/${results.length} fixture writes failed — ABORTING tier (matchday NOT advanced)`);
        summary.tiers[tier] = {
          error: `${fixtureWriteFailures} fixture writes failed`,
          matchday,
          aborted: true,
        };
        continue; // Do NOT advance matchday
      }

      // ── 6. Verify fixture results persisted ────
      const verifyFixtures = await base44.asServiceRole.entities.Fixture.findMany({
        where: {
          season_id: season.id,
          matchday,
          status: 'PLAYED',
        },
      });

      if (verifyFixtures.length !== EXPECTED_FIXTURES_PER_MATCHDAY) {
        console.error(`[simulateDay][${tier}] VERIFICATION FAILED: expected ${EXPECTED_FIXTURES_PER_MATCHDAY} PLAYED fixtures after write, got ${verifyFixtures.length} — ABORTING tier`);
        summary.tiers[tier] = {
          error: `fixture verification failed: ${verifyFixtures.length}/${EXPECTED_FIXTURES_PER_MATCHDAY} confirmed PLAYED`,
          matchday,
          aborted: true,
        };
        continue; // Do NOT advance matchday
      }

      console.log(`[simulateDay][${tier}] All ${verifyFixtures.length} fixture results verified`);

      // ── 7. Update standings ────────────────────
      // FIX: Build explicit delta objects with ONLY the writable fields that changed.
      // Do NOT pass the full entity object (it contains id, created_at, etc.).
      const teamSeasons = await base44.asServiceRole.entities.TeamSeason.findMany({
        where: { season_id: season.id },
      });

      // Index by team_id for fast lookup
      const teamMap = {};
      for (const ts of teamSeasons) {
        teamMap[ts.team_id] = ts;
      }

      // Calculate deltas from results
      const standingDeltas = {}; // keyed by TeamSeason.id

      for (const r of results) {
        const home = teamMap[r.homeTeamId];
        const away = teamMap[r.awayTeamId];

        if (!home) {
          console.warn(`[simulateDay][${tier}] No TeamSeason found for home team ${r.homeTeamId} — skipping`);
          continue;
        }
        if (!away) {
          console.warn(`[simulateDay][${tier}] No TeamSeason found for away team ${r.awayTeamId} — skipping`);
          continue;
        }

        // Initialize deltas from current DB values (only writable fields)
        if (!standingDeltas[home.id]) {
          standingDeltas[home.id] = {
            played: home.played || 0,
            won: home.won || 0,
            drawn: home.drawn || 0,
            lost: home.lost || 0,
            goals_for: home.goals_for || 0,
            goals_against: home.goals_against || 0,
            points: home.points || 0,
          };
        }
        if (!standingDeltas[away.id]) {
          standingDeltas[away.id] = {
            played: away.played || 0,
            won: away.won || 0,
            drawn: away.drawn || 0,
            lost: away.lost || 0,
            goals_for: away.goals_for || 0,
            goals_against: away.goals_against || 0,
            points: away.points || 0,
          };
        }

        const hd = standingDeltas[home.id];
        const ad = standingDeltas[away.id];

        hd.played += 1;
        ad.played += 1;

        hd.goals_for += r.home_goals;
        hd.goals_against += r.away_goals;
        ad.goals_for += r.away_goals;
        ad.goals_against += r.home_goals;

        if (r.home_goals > r.away_goals) {
          hd.won += 1;
          hd.points += 3;
          ad.lost += 1;
        } else if (r.home_goals < r.away_goals) {
          ad.won += 1;
          ad.points += 3;
          hd.lost += 1;
        } else {
          hd.drawn += 1;
          ad.drawn += 1;
          hd.points += 1;
          ad.points += 1;
        }
      }

      // Write standings — clean payloads only (no id, no system fields)
      let standingsWriteFailures = 0;

      for (const [tsId, delta] of Object.entries(standingDeltas)) {
        try {
          await base44.asServiceRole.entities.TeamSeason.update(tsId, {
            played: delta.played,
            won: delta.won,
            drawn: delta.drawn,
            lost: delta.lost,
            goals_for: delta.goals_for,
            goals_against: delta.goals_against,
            points: delta.points,
          });
        } catch (err) {
          standingsWriteFailures++;
          console.error(`[simulateDay][${tier}] TeamSeason.update FAILED for ${tsId}:`, err.message || err);
        }
      }

      if (standingsWriteFailures > 0) {
        console.error(`[simulateDay][${tier}] ${standingsWriteFailures}/${Object.keys(standingDeltas).length} standings writes failed — ABORTING tier (matchday NOT advanced)`);
        summary.tiers[tier] = {
          error: `${standingsWriteFailures} standings writes failed`,
          matchday,
          fixturesWritten: true,
          standingsAborted: true,
        };
        continue; // Do NOT advance matchday
      }

      console.log(`[simulateDay][${tier}] All ${Object.keys(standingDeltas).length} standings updated`);

      // ── 8. Advance matchday (ONLY after results + standings confirmed) ──
      await base44.asServiceRole.entities.SeasonProgress.update(progress.id, {
        current_matchday: matchday + 1,
      });

      await base44.asServiceRole.entities.Season.update(season.id, {
        current_matchday: matchday + 1,
      });

      console.log(`[simulateDay][${tier}] Matchday advanced: ${matchday} → ${matchday + 1}`);

      summary.tiers[tier] = {
        ok: true,
        matchday,
        fixturesSimulated: results.length,
        standingsUpdated: Object.keys(standingDeltas).length,
      };

    } catch (err) {
      console.error(`[simulateDay][${tier}] UNCAUGHT ERROR:`, err.message || err, err.stack || '');
      summary.tiers[tier] = { error: err.message || String(err), matchday: null };
    }
  }

  // ── Summary log ────────────────────────────────
  const tierResults = Object.entries(summary.tiers).map(([t, r]) => {
    if (r.ok) return `  ${t}: OK (matchday ${r.matchday}${r.alreadyPlayed ? ', already played' : ''})`;
    if (r.skipped) return `  ${t}: SKIPPED (${r.skipped})`;
    return `  ${t}: FAILED (${r.error})`;
  });
  console.log(`[simulateDay] Run complete:\n${tierResults.join('\n')}`);

  return summary;
}
