import express from "express";

const app = express();
app.use(express.json());

// CORS for Base44
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ──────────────────────────────────────────────
// MOCK GAME DATA
// Replace this with real DB/API calls later
// ──────────────────────────────────────────────

const PLAYERS = {
  default: {
    name: "Marcus Reid",
    age: 22,
    position: "CAM",
    club: "Northfield United",
    overall: 74,
    potential: 86,
    form: "excellent",
    form_rating: 8.1,
    goals: 7,
    assists: 11,
    minutes_played: 1620,
    matches_played: 21,
    fitness: 92,
    morale: "high",
    contract_expires: "2027-06-30",
    wage: 18000,
    value: 4200000,
  },
  p001: {
    name: "Marcus Reid",
    age: 22,
    position: "CAM",
    club: "Northfield United",
    overall: 74,
    potential: 86,
    form: "excellent",
    form_rating: 8.1,
    goals: 7,
    assists: 11,
    minutes_played: 1620,
    matches_played: 21,
    fitness: 92,
    morale: "high",
    contract_expires: "2027-06-30",
    wage: 18000,
    value: 4200000,
  },
};

const CLUBS = {
  default: {
    name: "Northfield United",
    league: "Championship",
    position: 6,
    form_last_5: ["W", "W", "D", "W", "L"],
    manager: "Steve Hargreaves",
    next_fixture: {
      opponent: "Riverside City",
      date: "Saturday 3pm",
      venue: "Home",
      competition: "Championship",
    },
    season_goal: "Promotion playoff",
  },
};

const TRANSFER_INTEREST = {
  default: [
    { club: "Brighton & Hove Albion", likelihood: "high", offer_range: "6M-8M", league: "Premier League" },
    { club: "Freiburg", likelihood: "medium", offer_range: "5M-6.5M", league: "Bundesliga" },
    { club: "Real Sociedad", likelihood: "low", offer_range: "4.5M-5.5M", league: "La Liga" },
  ],
};

const TRAINING_FOCUS = {
  default: {
    current_focus: "Passing & Vision",
    weekly_plan: [
      { day: "Mon", session: "Ball retention drills", intensity: "medium" },
      { day: "Tue", session: "Crossing & final third delivery", intensity: "high" },
      { day: "Wed", session: "Rest / recovery", intensity: "low" },
      { day: "Thu", session: "Set piece routines", intensity: "medium" },
      { day: "Fri", session: "Match prep — tactical walkthrough", intensity: "low" },
    ],
    recommendation: "Your passing accuracy has jumped from 78% to 84% this month. Keep this focus for 2 more weeks, then rotate to shooting drills to convert those chances.",
  },
};

// ──────────────────────────────────────────────
// INTENT DETECTION
// ──────────────────────────────────────────────

const INTENT_PATTERNS = [
  { intent: "training",  keywords: ["training", "train", "practice", "drills", "session", "gym", "fitness", "workout"] },
  { intent: "match",     keywords: ["match", "fixture", "game", "next game", "opponent", "lineup", "squad", "play"] },
  { intent: "form",      keywords: ["form", "stats", "performance", "rating", "how am i", "how's my", "minutes", "goals", "assists"] },
  { intent: "transfer",  keywords: ["transfer", "scout", "interest", "offer", "move", "bid", "sign", "contract", "wage", "buy", "sell"] },
  { intent: "career",    keywords: ["career", "plan", "future", "potential", "advice", "path", "develop", "progress", "grow"] },
  { intent: "morale",    keywords: ["morale", "happy", "mood", "feeling", "confidence", "mental", "motivation"] },
];

function detectIntent(text) {
  const lower = text.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;

  for (const pattern of INTENT_PATTERNS) {
    const score = pattern.keywords.filter(kw => lower.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = pattern.intent;
    }
  }

  return bestMatch || "general";
}

// ──────────────────────────────────────────────
// GAME DATA LOOKUPS
// ──────────────────────────────────────────────

function getPlayer(playerId) {
  return PLAYERS[playerId] || PLAYERS.default;
}

function getClub(clubId) {
  return CLUBS[clubId] || CLUBS.default;
}

function getTransferInterest(playerId) {
  return TRANSFER_INTEREST[playerId] || TRANSFER_INTEREST.default;
}

function getTraining(playerId) {
  return TRAINING_FOCUS[playerId] || TRAINING_FOCUS.default;
}

// ──────────────────────────────────────────────
// RESPONSE BUILDERS (Career Advisor personality)
// ──────────────────────────────────────────────

function buildTrainingResponse(player, training) {
  return {
    reply: `Right then, ${player.name} — here's your training breakdown.\n\nCurrent focus: **${training.current_focus}**\n\n${training.weekly_plan.map(d => `- **${d.day}**: ${d.session} (${d.intensity})`).join("\n")}\n\n${training.recommendation}`,
    suggested_actions: [
      { id: "change_focus", label: "Change Training Focus", intent: "action:change_training", icon: "settings" },
      { id: "view_form", label: "Check My Form", intent: "query:form", icon: "chart" },
      { id: "next_match", label: "Next Match", intent: "query:match", icon: "calendar" },
    ],
  };
}

function buildMatchResponse(player, club) {
  const fixture = club.next_fixture;
  const formStr = club.form_last_5.join(" ");
  return {
    reply: `Here's the latest, ${player.name}.\n\n**Next match:** ${fixture.opponent} — ${fixture.date}, ${fixture.venue} (${fixture.competition})\n\n**Club form (last 5):** ${formStr}\n**League position:** ${club.position}th in the ${club.league}\n**Season target:** ${club.season_goal}\n\nYou've played ${player.matches_played} matches this season with ${player.minutes_played} minutes. The gaffer rates you — keep pushing.`,
    suggested_actions: [
      { id: "training", label: "View Training Plan", intent: "query:training", icon: "clipboard" },
      { id: "form", label: "Check My Stats", intent: "query:form", icon: "chart" },
      { id: "career", label: "Career Advice", intent: "query:career", icon: "star" },
    ],
  };
}

function buildFormResponse(player) {
  const formEmoji = player.form === "excellent" ? "On fire" : player.form === "good" ? "Solid" : "Needs work";
  return {
    reply: `Here's where you stand, ${player.name}.\n\n**Form:** ${formEmoji} (${player.form_rating}/10)\n**Goals:** ${player.goals} | **Assists:** ${player.assists}\n**Minutes:** ${player.minutes_played} across ${player.matches_played} appearances\n**Fitness:** ${player.fitness}% | **Morale:** ${player.morale}\n**Overall:** ${player.overall} | **Potential:** ${player.potential}\n\nYou're trending upward. ${player.form_rating >= 7.5 ? "Scouts are watching — this is the window to make your mark." : "Keep grinding, the numbers will come."}`,
    suggested_actions: [
      { id: "transfer", label: "Who's Watching?", intent: "query:transfer", icon: "eye" },
      { id: "training", label: "Training Plan", intent: "query:training", icon: "clipboard" },
      { id: "career", label: "Career Path", intent: "query:career", icon: "star" },
    ],
  };
}

function buildTransferResponse(player, interest) {
  const lines = interest.map(t => `- **${t.club}** (${t.league}) — likelihood: ${t.likelihood}, range: ${t.offer_range}`);
  return {
    reply: `Transfer talk for ${player.name}.\n\nContract expires: **${player.contract_expires}**\nCurrent value: **${(player.value / 1_000_000).toFixed(1)}M**\nWage: **${(player.wage).toLocaleString()}/wk**\n\n**Clubs showing interest:**\n${lines.join("\n")}\n\n${interest.some(t => t.likelihood === "high") ? "There's genuine heat here. Think about what step makes sense for your development." : "Nothing concrete yet — focus on form and the right move will come."}`,
    suggested_actions: [
      { id: "form", label: "Check My Form", intent: "query:form", icon: "chart" },
      { id: "career", label: "Career Advice", intent: "query:career", icon: "star" },
      { id: "match", label: "Next Match", intent: "query:match", icon: "calendar" },
    ],
  };
}

function buildCareerResponse(player) {
  const gapToFulfil = player.potential - player.overall;
  return {
    reply: `Let's talk about where you're headed, ${player.name}.\n\n**Current overall:** ${player.overall} | **Potential ceiling:** ${player.potential}\n**Gap to close:** ${gapToFulfil} rating points\n**Age:** ${player.age} — ${player.age <= 23 ? "you've got time on your side" : "the window is now"}\n\nHere's my honest take:\n${player.form_rating >= 7.5 ? "Your form is strong. If a bigger club comes knocking, it could accelerate your growth — but only if you'll get minutes." : "Focus on being the best player at your current level first. Consistent form opens every door."}\n\n${gapToFulfil >= 10 ? "There's a big ceiling above you. Stay disciplined, train smart, and you'll get there." : "You're close to your peak — it's about fine margins now. Every session counts."}`,
    suggested_actions: [
      { id: "transfer", label: "Transfer Interest", intent: "query:transfer", icon: "eye" },
      { id: "training", label: "Training Plan", intent: "query:training", icon: "clipboard" },
      { id: "form", label: "View Stats", intent: "query:form", icon: "chart" },
    ],
  };
}

function buildMoraleResponse(player) {
  return {
    reply: `Mental check-in for ${player.name}.\n\n**Morale:** ${player.morale}\n**Fitness:** ${player.fitness}%\n**Form:** ${player.form} (${player.form_rating}/10)\n\n${player.morale === "high" ? "You're in a good headspace. Confidence is high — feed it with more strong performances." : player.morale === "medium" ? "You're steady but not buzzing. A good result or a goal could flip the switch." : "Morale's low. Talk to the gaffer, focus on the basics, and remember why you love this game."}`,
    suggested_actions: [
      { id: "training", label: "Training Plan", intent: "query:training", icon: "clipboard" },
      { id: "career", label: "Career Advice", intent: "query:career", icon: "star" },
      { id: "match", label: "Next Match", intent: "query:match", icon: "calendar" },
    ],
  };
}

function buildGeneralResponse(player, text) {
  return {
    reply: `Alright ${player.name}, I'm here. You asked: "${text}"\n\nI can help you with any of these — just ask or tap a button:\n\n- **Training** — your weekly plan and focus areas\n- **Match** — next fixture, form, and squad info\n- **Stats** — goals, assists, rating, minutes\n- **Transfers** — who's interested and what you're worth\n- **Career** — development path and honest advice\n\nWhat's on your mind?`,
    suggested_actions: [
      { id: "form", label: "My Stats", intent: "query:form", icon: "chart" },
      { id: "training", label: "Training", intent: "query:training", icon: "clipboard" },
      { id: "match", label: "Next Match", intent: "query:match", icon: "calendar" },
      { id: "transfer", label: "Transfer Talk", intent: "query:transfer", icon: "eye" },
    ],
  };
}

// ──────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "brain", version: "2.0.0" });
});

// MAIN AGENT ENDPOINT
app.post("/api/agent/chat", async (req, res) => {
  const { message, conversation_id, player_id, club_id } = req.body || {};
  const text = (message || "").toString().trim();

  if (!text) {
    return res.status(400).json({
      reply: "Send me a message and I'll get to work.",
      suggested_actions: [],
      metadata: { agent_name: "Football Brain" },
    });
  }

  // Detect intent from the user's message
  const intent = detectIntent(text);

  // Load game context
  const player = getPlayer(player_id);
  const club = getClub(club_id);

  // Build intent-specific response
  let response;
  switch (intent) {
    case "training":
      response = buildTrainingResponse(player, getTraining(player_id));
      break;
    case "match":
      response = buildMatchResponse(player, club);
      break;
    case "form":
      response = buildFormResponse(player);
      break;
    case "transfer":
      response = buildTransferResponse(player, getTransferInterest(player_id));
      break;
    case "career":
      response = buildCareerResponse(player);
      break;
    case "morale":
      response = buildMoraleResponse(player);
      break;
    default:
      response = buildGeneralResponse(player, text);
  }

  return res.json({
    ...response,
    conversation_id: conversation_id || "conv",
    intent,
    metadata: {
      agent_name: "Football Brain",
      agent_role: "Career Advisor",
      player_context: {
        name: player.name,
        club: player.club,
        position: player.position,
        overall: player.overall,
      },
      thinking: false,
    },
  });
});

// Player context endpoint — lets the UI fetch player data directly
app.get("/api/player/:id", (req, res) => {
  const player = getPlayer(req.params.id);
  res.json({ ok: true, player });
});

// Player transfer interest endpoint
app.get("/api/player/:id/transfers", (req, res) => {
  const interest = getTransferInterest(req.params.id);
  res.json({ ok: true, interest });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Brain API v2.0 running on port", PORT));
