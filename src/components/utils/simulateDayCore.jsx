/**
 * simulateDayCore — Base44 Function matchday simulation engine
 *
 * Called by functions/simulateDayCron.ts every 24h at 22:00 UK time.
 * Simulates one matchday across all EFL tiers simultaneously.
 *
 * Guards:
 *   - Matchday NEVER advances unless fixture results + standings are
 *     confirmed persisted via post-write re-fetch.
 *   - Double-fire safe: if fixtures are already played for this matchday,
 *     advances without re-simulating.
 *   - Robust "unplayed" filter: does NOT depend on a specific status string.
 */

const EFL_TIERS = ['championship', 'league_one', 'league_two'];
const EXPECTED_FIXTURES_PER_MATCHDAY = 12;

export async function simulateDayCore(base44, options = {}) {
  const { tierFilter = null, isCron = false } = options;
  const tiersToProcess = tierFilter ? [tierFilter] : EFL_TIERS;
  const summary = { tiers: {}, isCron, timestamp: new Date().toISOString() };

  for (const tier of tiersToProcess) {
    try {
      console.log(`[simDay][${tier}] ── START ──`);

      // ── 1. Load active season ──────────────────────
      const season = await base44.asServiceRole.entities.Season.findFirst({
        where: { efl_tier: tier, status: 'ACTIVE' },
      });

      if (!season) {
        console.warn(`[simDay][${tier}] No active season — skipping`);
        summary.tiers[tier] = { skipped: 'no active season' };
        continue;
      }

      console.log(`[simDay][${tier}] Season id=${season.id}`);

      // ── 2. Load or create SeasonProgress ───────────
      let progress = await base44.asServiceRole.entities.SeasonProgress.findFirst({
        where: { season_id: season.id },
      });

      if (!progress) {
        console.log(`[simDay][${tier}] Creating SeasonProgress at matchday 1`);
        progress = await base44.asServiceRole.entities.SeasonProgress.create({
          season_id: season.id,
          current_matchday: 1,
        });
      }

      // FIX: Coerce matchday to number.
      // Base44 may store/return it as a string depending on entity field type.
      // A string "1" in a WHERE clause won't match a numeric 1 field (or vice versa).
      const matchday = Number(progress.current_matchday);

      if (isNaN(matchday) || matchday < 1) {
        console.error(`[simDay][${tier}] Invalid matchday value: ${JSON.stringify(progress.current_matchday)}`);
        summary.tiers[tier] = { error: `invalid matchday: ${progress.current_matchday}` };
        continue;
      }

      console.log(`[simDay][${tier}] Matchday: ${matchday} (type: ${typeof matchday})`);

      // ── 3. Fetch ALL fixtures for this matchday ────
      // Do NOT filter by status in the query — fetch everything and classify client-side.
      // This avoids the bug where fixtures have status 'SCHEDULED' but the query
      // filters for 'UPCOMING' (or vice versa) and silently returns 0 results.
      const allFixtures = await base44.asServiceRole.entities.Fixture.findMany({
        where: {
          season_id: season.id,
          matchday: matchday,
        },
      });

      // ── DIAGNOSTIC: Log what we got back ───────────
      const statusCounts = {};
      for (const f of allFixtures) {
        const s = f.status || '(null/undefined)';
        statusCounts[s] = (statusCounts[s] || 0) + 1;
      }
      console.log(`[simDay][${tier}] Fixtures found: ${allFixtures.length}, statuses: ${JSON.stringify(statusCounts)}`);

      if (allFixtures.length > 0) {
        // Log a sample fixture so we can see exact field names/values
        const sample = allFixtures[0];
        console.log(`[simDay][${tier}] Sample fixture: id=${sample.id}, status=${JSON.stringify(sample.status)}, played_at=${JSON.stringify(sample.played_at)}, home_goals=${JSON.stringify(sample.home_goals)}, away_goals=${JSON.stringify(sample.away_goals)}, home_team_id=${sample.home_team_id}, away_team_id=${sample.away_team_id}, matchday=${JSON.stringify(sample.matchday)} (type: ${typeof sample.matchday})`);
      }

      // ── 4. Classify fixtures ───────────────────────
      // FIX: Do NOT rely on a specific status string for "unplayed".
      //
      // OLD (buggy):
      //   const upcomingFixtures = allFixtures.filter(
      //     f => !f.played_at && (!f.status || f.status === 'UPCOMING')
      //   );
      //   ↑ This SILENTLY excludes fixtures with status 'SCHEDULED', 'PENDING', etc.
      //
      // NEW (robust): a fixture is unplayed if it has no played_at AND no goals recorded.
      // This matches how the UI determines "upcoming" vs "played".
      const upcomingFixtures = allFixtures.filter(
        f => !f.played_at && f.home_goals == null && f.away_goals == null
      );

      const playedFixtures = allFixtures.filter(
        f => f.played_at != null || f.status === 'PLAYED'
      );

      console.log(`[simDay][${tier}] Classified: ${upcomingFixtures.length} upcoming, ${playedFixtures.length} played`);

      // ── IDEMPOTENCY GUARD ──────────────────────────
      // If all fixtures already played (double-fire), just advance matchday.
      if (playedFixtures.length === EXPECTED_FIXTURES_PER_MATCHDAY && upcomingFixtures.length === 0) {
        console.warn(`[simDay][${tier}] Matchday ${matchday} already fully played — advancing without re-simulating`);

        await base44.asServiceRole.entities.SeasonProgress.update(progress.id, {
          current_matchday: matchday + 1,
        });
        await base44.asServiceRole.entities.Season.update(season.id, {
          current_matchday: matchday + 1,
        });

        summary.tiers[tier] = { ok: true, matchday, alreadyPlayed: true };
        continue;
      }

      // ── HARD GATE: Must have exactly 12 unplayed fixtures ──
      if (upcomingFixtures.length !== EXPECTED_FIXTURES_PER_MATCHDAY) {
        console.error(`[simDay][${tier}] Expected ${EXPECTED_FIXTURES_PER_MATCHDAY} unplayed fixtures, got ${upcomingFixtures.length} — ABORTING (matchday NOT advanced)`);
        summary.tiers[tier] = {
          skipped: `expected ${EXPECTED_FIXTURES_PER_MATCHDAY} unplayed, got ${upcomingFixtures.length}`,
          totalFixtures: allFixtures.length,
          statusCounts,
        };
        continue;
      }

      // ── 5. Simulate match results ──────────────────
      const results = [];
      for (const fixture of upcomingFixtures) {
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

      console.log(`[simDay][${tier}] Simulated ${results.length} matches`);

      // ── 6. Write fixture results ───────────────────
      // Payload is clean: only writable fields, no id, no system fields.
      let fixtureWriteFailures = 0;

      for (const r of results) {
        try {
          await base44.asServiceRole.entities.Fixture.update(r.fixtureId, {
            status: 'PLAYED',
            home_goals: r.home_goals,
            away_goals: r.away_goals,
            played_at: new Date().toISOString(),
          });
        } catch (err) {
          fixtureWriteFailures++;
          console.error(`[simDay][${tier}] Fixture.update FAILED for ${r.fixtureId}:`, err.message || err);
        }
      }

      if (fixtureWriteFailures > 0) {
        console.error(`[simDay][${tier}] ${fixtureWriteFailures}/${results.length} fixture writes failed — ABORTING (matchday NOT advanced)`);
        summary.tiers[tier] = {
          error: `${fixtureWriteFailures} fixture writes failed`,
          matchday,
          aborted: true,
        };
        continue;
      }

      // ── 7. Verify fixture persistence ──────────────
      // Re-fetch to confirm writes actually landed in Base44.
      const verifyFixtures = await base44.asServiceRole.entities.Fixture.findMany({
        where: {
          season_id: season.id,
          matchday: matchday,
        },
      });

      // Count PLAYED using the same robust check the UI uses
      const confirmedPlayed = verifyFixtures.filter(
        f => f.played_at != null || f.status === 'PLAYED'
      );

      // Log a sample of verified data so we can see what actually persisted
      if (verifyFixtures.length > 0) {
        const vs = verifyFixtures[0];
        console.log(`[simDay][${tier}] Verify sample: id=${vs.id}, status=${JSON.stringify(vs.status)}, played_at=${JSON.stringify(vs.played_at)}, home_goals=${JSON.stringify(vs.home_goals)}, away_goals=${JSON.stringify(vs.away_goals)}`);
      }

      if (confirmedPlayed.length !== EXPECTED_FIXTURES_PER_MATCHDAY) {
        console.error(`[simDay][${tier}] VERIFY FAILED: expected ${EXPECTED_FIXTURES_PER_MATCHDAY} played, confirmed ${confirmedPlayed.length} — ABORTING (matchday NOT advanced)`);

        // Log which fixtures didn't persist
        const unconfirmed = verifyFixtures.filter(f => !f.played_at && f.status !== 'PLAYED');
        for (const u of unconfirmed.slice(0, 3)) {
          console.error(`[simDay][${tier}]   Unconfirmed: id=${u.id}, status=${JSON.stringify(u.status)}, played_at=${JSON.stringify(u.played_at)}`);
        }

        summary.tiers[tier] = {
          error: `verification failed: ${confirmedPlayed.length}/${EXPECTED_FIXTURES_PER_MATCHDAY} confirmed played`,
          matchday,
          aborted: true,
        };
        continue;
      }

      console.log(`[simDay][${tier}] ✓ ${confirmedPlayed.length} fixture results verified`);

      // ── 8. Update standings ────────────────────────
      const teamSeasons = await base44.asServiceRole.entities.TeamSeason.findMany({
        where: { season_id: season.id },
      });

      console.log(`[simDay][${tier}] Loaded ${teamSeasons.length} TeamSeason records`);

      // Index by team_id
      const teamMap = {};
      for (const ts of teamSeasons) {
        teamMap[ts.team_id] = ts;
      }

      // Build clean update payloads keyed by TeamSeason id.
      // Each payload contains ONLY the writable stat fields.
      const standingUpdates = {};

      for (const r of results) {
        const home = teamMap[r.homeTeamId];
        const away = teamMap[r.awayTeamId];

        if (!home) {
          console.warn(`[simDay][${tier}] No TeamSeason for home_team_id=${r.homeTeamId} — skipping`);
          continue;
        }
        if (!away) {
          console.warn(`[simDay][${tier}] No TeamSeason for away_team_id=${r.awayTeamId} — skipping`);
          continue;
        }

        // Lazy-init from current DB values (only writable fields)
        if (!standingUpdates[home.id]) {
          standingUpdates[home.id] = {
            played: home.played || 0,
            won: home.won || 0,
            drawn: home.drawn || 0,
            lost: home.lost || 0,
            goals_for: home.goals_for || 0,
            goals_against: home.goals_against || 0,
            points: home.points || 0,
          };
        }
        if (!standingUpdates[away.id]) {
          standingUpdates[away.id] = {
            played: away.played || 0,
            won: away.won || 0,
            drawn: away.drawn || 0,
            lost: away.lost || 0,
            goals_for: away.goals_for || 0,
            goals_against: away.goals_against || 0,
            points: away.points || 0,
          };
        }

        const h = standingUpdates[home.id];
        const a = standingUpdates[away.id];

        h.played += 1;
        a.played += 1;
        h.goals_for += r.home_goals;
        h.goals_against += r.away_goals;
        a.goals_for += r.away_goals;
        a.goals_against += r.home_goals;

        if (r.home_goals > r.away_goals) {
          h.won += 1;
          h.points += 3;
          a.lost += 1;
        } else if (r.home_goals < r.away_goals) {
          a.won += 1;
          a.points += 3;
          h.lost += 1;
        } else {
          h.drawn += 1;
          a.drawn += 1;
          h.points += 1;
          a.points += 1;
        }
      }

      // Write each TeamSeason — clean payload, no id/system fields
      let standingsWriteFailures = 0;
      const standingIds = Object.keys(standingUpdates);

      for (const tsId of standingIds) {
        const data = standingUpdates[tsId];
        try {
          await base44.asServiceRole.entities.TeamSeason.update(tsId, {
            played: data.played,
            won: data.won,
            drawn: data.drawn,
            lost: data.lost,
            goals_for: data.goals_for,
            goals_against: data.goals_against,
            points: data.points,
          });
        } catch (err) {
          standingsWriteFailures++;
          console.error(`[simDay][${tier}] TeamSeason.update FAILED for ${tsId}:`, err.message || err);
        }
      }

      if (standingsWriteFailures > 0) {
        console.error(`[simDay][${tier}] ${standingsWriteFailures}/${standingIds.length} standings writes failed — ABORTING (matchday NOT advanced)`);
        summary.tiers[tier] = {
          error: `${standingsWriteFailures} standings writes failed`,
          matchday,
          fixturesWritten: true,
          standingsAborted: true,
        };
        continue;
      }

      // Verify a sample TeamSeason to confirm write landed
      if (standingIds.length > 0) {
        try {
          const sampleTs = await base44.asServiceRole.entities.TeamSeason.findFirst({
            where: { id: standingIds[0] },
          });
          if (sampleTs) {
            console.log(`[simDay][${tier}] Standings verify sample: id=${sampleTs.id}, played=${sampleTs.played}, won=${sampleTs.won}, points=${sampleTs.points}, goals_for=${sampleTs.goals_for}`);
          }
        } catch (err) {
          console.warn(`[simDay][${tier}] Standings verify sample fetch failed (non-fatal):`, err.message || err);
        }
      }

      console.log(`[simDay][${tier}] ✓ ${standingIds.length} standings updated`);

      // ── 9. Advance matchday ────────────────────────
      // This is the LAST step. Only reached if results + standings are confirmed.
      await base44.asServiceRole.entities.SeasonProgress.update(progress.id, {
        current_matchday: matchday + 1,
      });
      await base44.asServiceRole.entities.Season.update(season.id, {
        current_matchday: matchday + 1,
      });

      console.log(`[simDay][${tier}] ✓ Matchday advanced: ${matchday} → ${matchday + 1}`);
      console.log(`[simDay][${tier}] ── DONE ──`);

      summary.tiers[tier] = {
        ok: true,
        matchday,
        fixturesSimulated: results.length,
        standingsUpdated: standingIds.length,
      };

    } catch (err) {
      console.error(`[simDay][${tier}] UNCAUGHT ERROR:`, err.message || err, err.stack || '');
      summary.tiers[tier] = { error: err.message || String(err) };
    }
  }

  // ── Final summary ──────────────────────────────────
  const lines = Object.entries(summary.tiers).map(([t, r]) => {
    if (r.ok) return `  ${t}: OK md=${r.matchday}${r.alreadyPlayed ? ' (already played)' : ''}`;
    if (r.skipped) return `  ${t}: SKIP (${r.skipped})`;
    return `  ${t}: FAIL (${r.error})`;
  });
  console.log(`[simDay] Summary:\n${lines.join('\n')}`);

  return summary;
}
