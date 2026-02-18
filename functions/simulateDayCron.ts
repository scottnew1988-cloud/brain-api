import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const EFL_TIERS = ['championship', 'league_one', 'league_two'];
const MATCHES_PER_MD = 12;
const TOTAL_MATCHDAYS = 46;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function retryWrite(fn: () => Promise<any>, retries = 3, delayMs = 500): Promise<any> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === retries) throw err;
      console.warn(`[retry] Attempt ${i + 1} failed: ${err.message} — retrying in ${delayMs}ms`);
      await sleep(delayMs * (i + 1));
    }
  }
}

function getRoundRobinPairings(clubIds: string[], matchday: number): [string, string][] {
  const n = clubIds.length;
  const half = n - 1;
  const isSecondHalf = matchday > half;
  const rIdx = isSecondHalf ? matchday - half - 1 : matchday - 1;
  const fixed = clubIds[0];
  const rest = clubIds.slice(1);
  const rot = rIdx % rest.length;
  const rotated = rot === 0 ? rest : [...rest.slice(rest.length - rot), ...rest.slice(0, rest.length - rot)];
  const all = [fixed, ...rotated];
  const pairs: [string, string][] = [];
  for (let i = 0; i < n / 2; i++) {
    let h = all[i], a = all[n - 1 - i];
    if (i === 0 && rIdx % 2 === 1) [h, a] = [a, h];
    if (isSecondHalf) [h, a] = [a, h];
    pairs.push([h, a]);
  }
  return pairs;
}

async function simulateDayCore(base44: any, options: any = {}) {
  const { tierFilter = null } = options;
  const tiers = tierFilter ? [tierFilter] : EFL_TIERS;
  const ent = base44.asServiceRole.entities;
  const summary: any = { tiers: {}, timestamp: new Date().toISOString() };

  for (const tier of tiers) {
    try {
      console.log(`[sim][${tier}] -- START --`);

      // 1. Find active season
      const seasons = await ent.Season.filter({ efl_tier: tier, is_active: true });
      let season = seasons[0];

      if (!season) {
        console.log(`[sim][${tier}] No active season — creating`);
        const y = new Date().getFullYear();
        season = await ent.Season.create({
          name: `${y}/${String(y + 1).slice(-2)}`, efl_tier: tier,
          status: 'active', is_active: true,
          current_matchday: 1, total_matchdays: TOTAL_MATCHDAYS,
          current_gameweek: 1, total_gameweeks: TOTAL_MATCHDAYS,
          fixtures_generated: false,
        });
        summary.tiers[tier] = { ok: true, newSeasonCreated: true, seasonId: season.id };
        continue;
      }

      // 2. Find/create SeasonProgress
      const progList = await ent.SeasonProgress.filter({ season_id: season.id });
      let progress = progList[0];
      if (!progress) {
        progress = await ent.SeasonProgress.create({
          season_id: season.id, efl_tier: tier, current_matchday: 1, status: 'active',
        });
      }

      const matchday = Number(progress.current_matchday);
      if (isNaN(matchday) || matchday < 1) {
        summary.tiers[tier] = { error: `invalid matchday: ${progress.current_matchday}` };
        continue;
      }

      // 3. Season complete check
      if (matchday > TOTAL_MATCHDAYS) {
        console.log(`[sim][${tier}] Season complete — marking finished`);
        await ent.Season.update(season.id, { status: 'completed', is_active: false });
        await ent.SeasonProgress.update(progress.id, { status: 'completed' });
        summary.tiers[tier] = { ok: true, seasonCompleted: true };
        continue;
      }

      console.log(`[sim][${tier}] Matchday ${matchday}/${TOTAL_MATCHDAYS}`);

      // 4. Get fixtures for this matchday — generate if missing
      let fixtures = await ent.Fixture.filter({ season_id: season.id, matchday: matchday });
      console.log(`[sim][${tier}] Fixtures found: ${fixtures.length}`);

      if (fixtures.length === 0) {
        console.log(`[sim][${tier}] Generating fixtures for md ${matchday}`);
        const clubs = await ent.Club.filter({ efl_tier: tier });
        if (clubs.length !== 24) {
          summary.tiers[tier] = { error: `need 24 clubs, got ${clubs.length}` };
          continue;
        }
        const sorted = [...clubs].sort((a: any, b: any) => a.id.localeCompare(b.id));
        const ids = sorted.map((c: any) => c.id);
        const names: Record<string, string> = {};
        for (const c of sorted) names[c.id] = c.name;

        const pairings = getRoundRobinPairings(ids, matchday);
        for (const [hId, aId] of pairings) {
          await retryWrite(() => ent.Fixture.create({
            season_id: season.id, efl_tier: tier, matchday: matchday,
            home_club_id: hId, away_club_id: aId,
            home_club_name: names[hId], away_club_name: names[aId],
            status: 'UPCOMING', home_goals: null, away_goals: null, played_at: null,
            kickoff_at: new Date().toISOString(),
          }));
          await sleep(100);
        }
        fixtures = await ent.Fixture.filter({ season_id: season.id, matchday: matchday });
        console.log(`[sim][${tier}] Generated ${fixtures.length} fixtures`);
        if (!season.fixtures_generated) {
          await ent.Season.update(season.id, { fixtures_generated: true });
        }
      }

      // 5. Classify
      const upcoming = fixtures.filter((f: any) => !f.played_at && f.home_goals == null && f.away_goals == null);
      const played = fixtures.filter((f: any) => f.played_at != null || f.status === 'PLAYED');
      console.log(`[sim][${tier}] ${upcoming.length} upcoming, ${played.length} played`);

      // Idempotency: already played
      if (played.length === MATCHES_PER_MD && upcoming.length === 0) {
        console.warn(`[sim][${tier}] Already played — advancing`);
        await ent.SeasonProgress.update(progress.id, { current_matchday: matchday + 1 });
        await ent.Season.update(season.id, { current_matchday: matchday + 1, current_gameweek: matchday + 1 });
        summary.tiers[tier] = { ok: true, matchday, alreadyPlayed: true };
        continue;
      }

      if (upcoming.length !== MATCHES_PER_MD) {
        summary.tiers[tier] = { error: `expected ${MATCHES_PER_MD} unplayed, got ${upcoming.length}`, played: played.length, total: fixtures.length };
        continue;
      }

      // 6. Simulate
      const results: any[] = upcoming.map((f: any) => ({
        fixtureId: f.id, homeClubId: f.home_club_id, awayClubId: f.away_club_id,
        home_goals: Math.floor(Math.random() * 4), away_goals: Math.floor(Math.random() * 4),
      }));

      // 7. Write fixture results (with retry + throttle)
      let fixFails = 0;
      for (const r of results) {
        try {
          await retryWrite(() => ent.Fixture.update(r.fixtureId, {
            status: 'PLAYED', home_goals: r.home_goals, away_goals: r.away_goals,
            played_at: new Date().toISOString(),
          }));
          await sleep(100);
        } catch (err: any) { fixFails++; console.error(`[sim][${tier}] Fix write fail: ${err.message}`); }
      }
      if (fixFails > 0) {
        summary.tiers[tier] = { error: `${fixFails} fixture writes failed`, matchday, aborted: true };
        continue;
      }

      // 8. Verify
      const verified = await ent.Fixture.filter({ season_id: season.id, matchday: matchday });
      const confirmedPlayed = verified.filter((f: any) => f.played_at != null || f.status === 'PLAYED');
      if (confirmedPlayed.length !== MATCHES_PER_MD) {
        summary.tiers[tier] = { error: `verify: ${confirmedPlayed.length}/${MATCHES_PER_MD}`, matchday, aborted: true };
        continue;
      }
      console.log(`[sim][${tier}] ${confirmedPlayed.length} verified`);

      // 9. Get/create TeamSeason records
      let teamSeasons = await ent.TeamSeason.filter({ season_id: season.id });
      if (teamSeasons.length === 0) {
        console.log(`[sim][${tier}] Auto-creating TeamSeason records`);
        const clubIds = new Set<string>();
        for (const r of results) { clubIds.add(r.homeClubId); clubIds.add(r.awayClubId); }
        for (const cid of clubIds) {
          await retryWrite(() => ent.TeamSeason.create({
            season_id: season.id, club_id: cid, efl_tier: tier,
            played: 0, won: 0, drawn: 0, lost: 0,
            goals_for: 0, goals_against: 0, goal_difference: 0, points: 0,
          }));
          await sleep(100);
        }
        teamSeasons = await ent.TeamSeason.filter({ season_id: season.id });
        console.log(`[sim][${tier}] Created ${teamSeasons.length} TeamSeasons`);
      }

      // 10. Update standings
      const clubMap: Record<string, any> = {};
      for (const ts of teamSeasons) clubMap[ts.club_id] = ts;

      const updates: Record<string, any> = {};
      for (const r of results) {
        const home = clubMap[r.homeClubId];
        const away = clubMap[r.awayClubId];
        if (!home || !away) { console.warn(`[sim][${tier}] Missing TS for ${r.homeClubId} or ${r.awayClubId}`); continue; }

        if (!updates[home.id]) updates[home.id] = { played: home.played||0, won: home.won||0, drawn: home.drawn||0, lost: home.lost||0, goals_for: home.goals_for||0, goals_against: home.goals_against||0, points: home.points||0 };
        if (!updates[away.id]) updates[away.id] = { played: away.played||0, won: away.won||0, drawn: away.drawn||0, lost: away.lost||0, goals_for: away.goals_for||0, goals_against: away.goals_against||0, points: away.points||0 };

        const h = updates[home.id], a = updates[away.id];
        h.played++; a.played++;
        h.goals_for += r.home_goals; h.goals_against += r.away_goals;
        a.goals_for += r.away_goals; a.goals_against += r.home_goals;

        if (r.home_goals > r.away_goals) { h.won++; h.points += 3; a.lost++; }
        else if (r.home_goals < r.away_goals) { a.won++; a.points += 3; h.lost++; }
        else { h.drawn++; a.drawn++; h.points++; a.points++; }
      }

      let standFails = 0;
      for (const tsId of Object.keys(updates)) {
        const d = updates[tsId];
        try {
          await retryWrite(() => ent.TeamSeason.update(tsId, {
            played: d.played, won: d.won, drawn: d.drawn, lost: d.lost,
            goals_for: d.goals_for, goals_against: d.goals_against,
            goal_difference: d.goals_for - d.goals_against, points: d.points,
          }));
          await sleep(100);
        } catch (err: any) { standFails++; console.error(`[sim][${tier}] Standing fail: ${err.message}`); }
      }
      if (standFails > 0) {
        summary.tiers[tier] = { error: `${standFails} standings failed`, matchday, aborted: true };
        continue;
      }

      // 11. Advance matchday
      await ent.SeasonProgress.update(progress.id, { current_matchday: matchday + 1, last_simulated_at: new Date().toISOString() });
      await ent.Season.update(season.id, { current_matchday: matchday + 1, current_gameweek: matchday + 1 });

      console.log(`[sim][${tier}] DONE md ${matchday} -> ${matchday + 1}`);
      summary.tiers[tier] = { ok: true, matchday, fixturesSimulated: results.length, standingsUpdated: Object.keys(updates).length };

    } catch (err: any) {
      console.error(`[sim][${tier}] ERROR: ${err.message}`, err.stack || '');
      summary.tiers[tier] = { error: err.message || String(err) };
    }
  }
  return summary;
}

Deno.serve(async (req) => {
  const MANUAL_TEST_MODE = false;
  if (!MANUAL_TEST_MODE) {
    const p = req.headers.get('x-cron-secret') || '';
    const e = Deno.env.get('CRON_SECRET') || '';
    if (!e || p !== e) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const base44 = createClientFromRequest(req);
    const body: any = await req.json().catch(() => ({}));
    const t0 = Date.now();
    const result = await simulateDayCore(base44, { tierFilter: body.tier ?? null });
    const elapsed = Date.now() - t0;
    const entries = Object.entries(result.tiers || {});
    const fails = entries.filter(([, v]: any) => v?.error || v?.aborted);
    return Response.json({ ok: fails.length === 0, result, elapsed_ms: elapsed }, { status: fails.length ? 207 : 200 });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message || String(err) }, { status: 500 });
  }
});
