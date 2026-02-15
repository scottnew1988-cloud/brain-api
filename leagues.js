// ──────────────────────────────────────────────
// EFL LEAGUE SYSTEM
// Championship, League One, League Two
//
// All three leagues share a single matchday counter
// so they can NEVER go out of sync.
// ──────────────────────────────────────────────

// ── TEAM DATA ─────────────────────────────────

const TEAMS = {
  championship: [
    "Burnley", "Leeds United", "Sheffield United", "Sunderland",
    "Norwich City", "Middlesbrough", "West Brom", "Coventry City",
    "Bristol City", "Millwall", "Watford", "Swansea City",
    "Preston North End", "Blackburn Rovers", "QPR", "Hull City",
    "Stoke City", "Sheffield Wednesday", "Cardiff City", "Oxford United",
    "Portsmouth", "Southampton", "Plymouth Argyle", "Wrexham",
  ],
  league1: [
    "Wigan Athletic", "Barnsley", "Peterborough United", "Huddersfield Town",
    "Reading", "Bolton Wanderers", "Stockport County", "Derby County",
    "Charlton Athletic", "Leyton Orient", "Lincoln City", "Stevenage",
    "Wycombe Wanderers", "Exeter City", "Burton Albion", "Mansfield Town",
    "Northampton Town", "Shrewsbury Town", "Cambridge United", "Luton Town",
    "Rotherham United", "Crawley Town", "Port Vale", "Blackpool",
  ],
  league2: [
    "Gillingham", "Carlisle United", "Fleetwood Town", "MK Dons",
    "Bradford City", "Chesterfield", "Doncaster Rovers", "Salford City",
    "Crewe Alexandra", "Notts County", "Swindon Town", "AFC Wimbledon",
    "Harrogate Town", "Tranmere Rovers", "Morecambe", "Barrow",
    "Colchester United", "Newport County", "Oldham Athletic", "Bristol Rovers",
    "Cheltenham Town", "Bromley", "Rochdale", "Accrington Stanley",
  ],
};

// ── SEASON STATE (in-memory) ──────────────────

const SEASON = {
  currentMatchday: 0,
  totalMatchdays: 46, // 24 teams → 23 home rounds + 23 away rounds
  startDate: null,
  initialized: false,
  leagues: {},
};

// ── FIXTURE GENERATION (round-robin) ──────────

function generateFixtures(teams) {
  const n = teams.length; // 24
  const fixtures = [];

  // Circle method: fix team[0], rotate teams[1..23]
  const rotating = [];
  for (let i = 1; i < n; i++) rotating.push(i);

  // First half: 23 rounds
  for (let round = 0; round < n - 1; round++) {
    const matchday = round + 1;

    // Match 1: fixed team vs first in rotating
    fixtures.push({
      home: teams[0],
      away: teams[rotating[0]],
      matchday,
      played: false,
      homeGoals: null,
      awayGoals: null,
    });

    // Remaining 11 matches: pair from outside in
    for (let i = 1; i < n / 2; i++) {
      fixtures.push({
        home: teams[rotating[i]],
        away: teams[rotating[n - 1 - i]],
        matchday,
        played: false,
        homeGoals: null,
        awayGoals: null,
      });
    }

    // Rotate: move last to front
    rotating.unshift(rotating.pop());
  }

  // Second half: mirror with home/away swapped (matchdays 24-46)
  const firstHalfCount = fixtures.length;
  for (let i = 0; i < firstHalfCount; i++) {
    const orig = fixtures[i];
    fixtures.push({
      home: orig.away,
      away: orig.home,
      matchday: orig.matchday + (n - 1),
      played: false,
      homeGoals: null,
      awayGoals: null,
    });
  }

  return fixtures;
}

// ── MATCH SIMULATION ──────────────────────────

function poissonRandom(lambda) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return Math.min(k - 1, 7); // cap at 7 goals
}

function simulateMatch(fixture) {
  fixture.homeGoals = poissonRandom(1.45); // slight home advantage
  fixture.awayGoals = poissonRandom(1.15);
  fixture.played = true;
  return fixture;
}

// ── LEAGUE TABLE CALCULATION ──────────────────

function calculateTable(league) {
  const table = {};

  for (const team of league.teams) {
    table[team] = {
      position: 0,
      team,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      goalDifference: 0,
      points: 0,
    };
  }

  for (const fixture of league.fixtures) {
    if (!fixture.played) continue;

    const home = table[fixture.home];
    const away = table[fixture.away];

    home.played++;
    away.played++;
    home.goalsFor += fixture.homeGoals;
    home.goalsAgainst += fixture.awayGoals;
    away.goalsFor += fixture.awayGoals;
    away.goalsAgainst += fixture.homeGoals;

    if (fixture.homeGoals > fixture.awayGoals) {
      home.won++;
      home.points += 3;
      away.lost++;
    } else if (fixture.homeGoals < fixture.awayGoals) {
      away.won++;
      away.points += 3;
      home.lost++;
    } else {
      home.drawn++;
      away.drawn++;
      home.points += 1;
      away.points += 1;
    }

    home.goalDifference = home.goalsFor - home.goalsAgainst;
    away.goalDifference = away.goalsFor - away.goalsAgainst;
  }

  // Sort: points desc → GD desc → GF desc → alphabetical
  const sorted = Object.values(table).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference;
    if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
    return a.team.localeCompare(b.team);
  });

  sorted.forEach((row, i) => (row.position = i + 1));
  return sorted;
}

// ── PUBLIC API ─────────────────────────────────

/**
 * Reset all leagues to matchday 0 and regenerate fixtures.
 * This is the SYNC function — all leagues start fresh together.
 *
 * @param {Object} [customTeams] - Optional custom team lists from Base44.
 *   { championship: ["Team A", ...], league1: [...], league2: [...] }
 *   If provided, uses these instead of defaults.
 */
export function resetAndSync(customTeams) {
  SEASON.currentMatchday = 0;
  SEASON.startDate = new Date().toISOString();
  SEASON.initialized = true;

  const LEAGUE_META = {
    championship: { name: "Championship", tier: 1 },
    league1: { name: "League One", tier: 2 },
    league2: { name: "League Two", tier: 3 },
  };

  for (const [key, meta] of Object.entries(LEAGUE_META)) {
    // Use custom teams if provided, otherwise use defaults
    const teams = (customTeams && customTeams[key]) ? customTeams[key] : TEAMS[key];

    if (!teams || teams.length < 2) continue;

    SEASON.leagues[key] = {
      name: meta.name,
      tier: meta.tier,
      teams: [...teams],
      fixtures: generateFixtures(teams),
    };
  }

  // Total matchdays depends on team count (n-1 rounds × 2)
  const firstLeague = Object.values(SEASON.leagues)[0];
  if (firstLeague) {
    SEASON.totalMatchdays = (firstLeague.teams.length - 1) * 2;
  }

  // Build full fixture list per league for Base44 to create Fixture entities
  const allFixtures = {};
  for (const [key, league] of Object.entries(SEASON.leagues)) {
    allFixtures[key] = league.fixtures.map((f) => ({
      matchday: f.matchday,
      home: f.home,
      away: f.away,
    }));
  }

  return {
    success: true,
    message: "All EFL seasons reset and synced to matchday 0",
    currentMatchday: 0,
    totalMatchdays: SEASON.totalMatchdays,
    startDate: SEASON.startDate,
    leagues: Object.entries(SEASON.leagues).map(([id, l]) => ({
      id,
      name: l.name,
      tier: l.tier,
      teams: l.teams,
      fixtureCount: l.fixtures.length,
    })),
    fixtures: allFixtures,
  };
}

/**
 * Simulate ONE matchday across ALL leagues simultaneously.
 * This guarantees they stay in sync.
 */
export function simulateMatchday() {
  if (!SEASON.initialized) {
    resetAndSync(); // auto-init if not done yet
  }

  if (SEASON.currentMatchday >= SEASON.totalMatchdays) {
    return {
      success: false,
      message: "Season complete (matchday 46/46). Call reset-sync to start a new season.",
      currentMatchday: SEASON.currentMatchday,
      totalMatchdays: SEASON.totalMatchdays,
      seasonComplete: true,
    };
  }

  SEASON.currentMatchday++;
  const results = {};

  for (const [key, league] of Object.entries(SEASON.leagues)) {
    const matchdayFixtures = league.fixtures.filter(
      (f) => f.matchday === SEASON.currentMatchday
    );

    for (const fixture of matchdayFixtures) {
      simulateMatch(fixture);
    }

    results[key] = {
      name: league.name,
      matchday: SEASON.currentMatchday,
      results: matchdayFixtures.map((f) => ({
        home: f.home,
        away: f.away,
        score: `${f.homeGoals}-${f.awayGoals}`,
      })),
    };
  }

  return {
    success: true,
    currentMatchday: SEASON.currentMatchday,
    totalMatchdays: SEASON.totalMatchdays,
    results,
  };
}

/**
 * Get the full league table for a specific league.
 */
export function getLeagueTable(leagueId) {
  if (!SEASON.initialized) resetAndSync();

  const league = SEASON.leagues[leagueId];
  if (!league) {
    return { success: false, message: `Unknown league: ${leagueId}. Use: championship, league1, league2` };
  }

  return {
    success: true,
    league: league.name,
    leagueId,
    currentMatchday: SEASON.currentMatchday,
    table: calculateTable(league),
  };
}

/**
 * Get fixtures for a specific league (optionally filtered by matchday).
 */
export function getFixtures(leagueId, matchday) {
  if (!SEASON.initialized) resetAndSync();

  const league = SEASON.leagues[leagueId];
  if (!league) {
    return { success: false, message: `Unknown league: ${leagueId}. Use: championship, league1, league2` };
  }

  let fixtures = league.fixtures;
  if (matchday) {
    fixtures = fixtures.filter((f) => f.matchday === matchday);
  }

  return {
    success: true,
    league: league.name,
    leagueId,
    currentMatchday: SEASON.currentMatchday,
    requestedMatchday: matchday || "all",
    fixtures,
  };
}

/**
 * Get only completed results for a league (optionally filtered by matchday).
 */
export function getResults(leagueId, matchday) {
  if (!SEASON.initialized) resetAndSync();

  const league = SEASON.leagues[leagueId];
  if (!league) {
    return { success: false, message: `Unknown league: ${leagueId}. Use: championship, league1, league2` };
  }

  let results = league.fixtures.filter((f) => f.played);
  if (matchday) {
    results = results.filter((f) => f.matchday === matchday);
  }

  return {
    success: true,
    league: league.name,
    leagueId,
    currentMatchday: SEASON.currentMatchday,
    results: results.map((f) => ({
      matchday: f.matchday,
      home: f.home,
      away: f.away,
      score: `${f.homeGoals}-${f.awayGoals}`,
    })),
  };
}

/**
 * Get overall season status across all leagues.
 */
export function getSeasonStatus() {
  if (!SEASON.initialized) {
    return {
      success: true,
      initialized: false,
      message: "Season not initialized. Call POST /api/seasons/reset-sync to start.",
    };
  }

  const leaguesSummary = {};
  for (const [key, league] of Object.entries(SEASON.leagues)) {
    const table = calculateTable(league);
    leaguesSummary[key] = {
      name: league.name,
      tier: league.tier,
      leader: table[0] ? { team: table[0].team, points: table[0].points, played: table[0].played } : null,
      matchesPlayed: league.fixtures.filter((f) => f.played).length,
      matchesRemaining: league.fixtures.filter((f) => !f.played).length,
    };
  }

  return {
    success: true,
    initialized: true,
    currentMatchday: SEASON.currentMatchday,
    totalMatchdays: SEASON.totalMatchdays,
    seasonComplete: SEASON.currentMatchday >= SEASON.totalMatchdays,
    startDate: SEASON.startDate,
    leagues: leaguesSummary,
  };
}

/**
 * Get all three league tables at once (convenience endpoint).
 */
export function getAllTables() {
  if (!SEASON.initialized) resetAndSync();

  const tables = {};
  for (const [key, league] of Object.entries(SEASON.leagues)) {
    tables[key] = {
      name: league.name,
      table: calculateTable(league),
    };
  }

  return {
    success: true,
    currentMatchday: SEASON.currentMatchday,
    totalMatchdays: SEASON.totalMatchdays,
    tables,
  };
}
