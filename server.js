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
// ENGAGEMENT ASSESSMENT
// ──────────────────────────────────────────────

function assessEngagement(player, engagementData) {
  // If the frontend sends engagement metrics, use those
  if (engagementData) {
    const {
      training_sessions_completed = 0,
      hours_since_last_training = 999,
      hours_since_last_login = 999,
      total_logins = 0,
      days_active = 0,
    } = engagementData;

    let score = 0;

    // Training frequency (every 3 hours is the cycle)
    if (hours_since_last_training <= 6) score += 3;       // trained recently
    else if (hours_since_last_training <= 12) score += 2;
    else if (hours_since_last_training <= 24) score += 1;

    // Login recency
    if (hours_since_last_login <= 4) score += 3;
    else if (hours_since_last_login <= 12) score += 2;
    else if (hours_since_last_login <= 24) score += 1;

    // Training volume
    if (training_sessions_completed >= 20) score += 3;
    else if (training_sessions_completed >= 10) score += 2;
    else if (training_sessions_completed >= 3) score += 1;

    // Consistency
    if (total_logins >= 14) score += 2;
    else if (total_logins >= 7) score += 1;

    if (score >= 8) return "high";
    if (score >= 4) return "medium";
    return "low";
  }

  // Fallback: infer engagement from player stats
  let score = 0;
  if (player.fitness >= 90) score += 2;
  else if (player.fitness >= 75) score += 1;

  if (player.morale === "high") score += 2;
  else if (player.morale === "medium") score += 1;

  if (player.matches_played >= 20) score += 2;
  else if (player.matches_played >= 10) score += 1;

  if (player.form_rating >= 7.5) score += 2;
  else if (player.form_rating >= 6.0) score += 1;

  if (score >= 6) return "high";
  if (score >= 3) return "medium";
  return "low";
}

// ──────────────────────────────────────────────
// INTENT DETECTION
// ──────────────────────────────────────────────

const INTENT_PATTERNS = [
  { intent: "greeting",  keywords: ["hello", "hi", "hey", "yo", "sup", "what's up", "whats up", "good morning", "good evening", "alright"] },
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
// RESPONSE BUILDERS (Dynamic personality)
//
// Engagement tiers:
//   low    → Supportive mentor. Explains game mechanics,
//            encourages the user to train & engage more.
//   medium → Balanced advisor. Mix of encouragement and
//            tactical career guidance.
//   high   → Ambitious super-agent. Hungry, driven,
//            talks like a top-tier football agent pushing
//            for the best deals and performances.
// ──────────────────────────────────────────────

// ── GREETING / WELCOME ────────────────────────

function buildGreetingResponse(player, engagement) {
  if (engagement === "low") {
    return {
      reply: `Hey ${player.name}, good to see you! I'm your agent — Football Brain — and I'm here to help you build a proper career.\n\nListen, I'll be straight with you: the more time you put into your player, the better things get. Here's how it works:\n\n- **Train every 3 hours** — each session boosts your attributes and keeps your fitness sharp\n- **Matches are played every 24 hours at 10pm** — the better your stats and morale, the more game time you'll get from the gaffer\n- **Transfer sweeps happen every 4 days** — if you're performing well, bigger clubs will come knocking\n\nIt's a simple loop: **train hard → play better → get noticed → move up.** I'm here to guide you through it all.\n\nWhere do you want to start?`,
      suggested_actions: [
        { id: "training", label: "Start Training", intent: "query:training", icon: "clipboard" },
        { id: "form", label: "Check My Stats", intent: "query:form", icon: "chart" },
        { id: "career", label: "Career Advice", intent: "query:career", icon: "star" },
        { id: "match", label: "Next Match", intent: "query:match", icon: "calendar" },
      ],
    };
  }

  if (engagement === "medium") {
    return {
      reply: `${player.name}, welcome back. Good to have you.\n\nYou've been putting in some decent work and it shows — but there's more in the tank. Remember, you can train every 3 hours and every session counts toward your next match performance.\n\nThe transfer sweep is coming up — if we keep building momentum, we could attract some serious interest. Let's make sure you're match-ready.\n\nWhat do you need from me?`,
      suggested_actions: [
        { id: "training", label: "Training Plan", intent: "query:training", icon: "clipboard" },
        { id: "transfer", label: "Transfer Interest", intent: "query:transfer", icon: "eye" },
        { id: "form", label: "My Stats", intent: "query:form", icon: "chart" },
        { id: "match", label: "Next Match", intent: "query:match", icon: "calendar" },
      ],
    };
  }

  // high engagement
  return {
    reply: `${player.name}! The man of the hour. Right, let's not waste time — you've been grafting and the numbers are backing it up.\n\nScouts are watching, the form is there, and the next transfer sweep could be your ticket to a bigger stage. I've got my ear to the ground and there are whispers. Let's keep this momentum rolling.\n\nWhat's the play?`,
    suggested_actions: [
      { id: "transfer", label: "Who's Watching?", intent: "query:transfer", icon: "eye" },
      { id: "form", label: "My Form", intent: "query:form", icon: "chart" },
      { id: "training", label: "Training", intent: "query:training", icon: "clipboard" },
      { id: "career", label: "Career Path", intent: "query:career", icon: "star" },
    ],
  };
}

// ── TRAINING ──────────────────────────────────

function buildTrainingResponse(player, training, engagement) {
  let opener, closer;

  if (engagement === "low") {
    opener = `Hey ${player.name}, let's get you training — this is where the magic happens.\n\nA quick reminder: you can train **every 3 hours**, and each session improves your attributes. The better your stats, the more game time the gaffer gives you, and the more scouts will take notice.\n\nHere's your current plan:`;
    closer = `\n\nEven short sessions add up over time. Try to get a few training sessions in today — your future self will thank you for it.`;
  } else if (engagement === "medium") {
    opener = `Right then, ${player.name} — here's your training breakdown. You've been fairly consistent, but let's step it up.\n\nCurrent focus: **${training.current_focus}**`;
    closer = `\n\nYou're on the right track. Try to hit every 3-hour training window you can — the next transfer sweep rewards players who've been putting in the work.`;
  } else {
    opener = `${player.name}, training intel. No messing about.\n\nCurrent focus: **${training.current_focus}**`;
    closer = `\n\nYou're in a rhythm. Keep smashing these sessions and the attributes will keep climbing. I want you in peak condition for when the right offer lands.`;
  }

  const plan = training.weekly_plan.map(d => `- **${d.day}**: ${d.session} (${d.intensity})`).join("\n");

  return {
    reply: `${opener}\n\n${engagement === "low" ? `Current focus: **${training.current_focus}**\n\n` : ""}${plan}\n\n${training.recommendation}${closer}`,
    suggested_actions: [
      { id: "change_focus", label: "Change Training Focus", intent: "action:change_training", icon: "settings" },
      { id: "view_form", label: "Check My Form", intent: "query:form", icon: "chart" },
      { id: "next_match", label: "Next Match", intent: "query:match", icon: "calendar" },
    ],
  };
}

// ── MATCH ─────────────────────────────────────

function buildMatchResponse(player, club, engagement) {
  const fixture = club.next_fixture;
  const formStr = club.form_last_5.join(" ");

  let insight;
  if (engagement === "low") {
    insight = `\n\nMatches are played **every 24 hours at 10pm**. Your performance depends on your attributes, fitness, and morale — so the more you train and look after your player, the better you'll do on match day. A good run of form can put you on the radar of bigger clubs in the next transfer sweep.`;
  } else if (engagement === "medium") {
    insight = `\n\nYou've played ${player.matches_played} matches this season with ${player.minutes_played} minutes. Solid presence. Keep your fitness high with regular training and you'll hold down that starting spot. The gaffer rewards consistency.`;
  } else {
    insight = `\n\nYou've played ${player.matches_played} matches, racked up ${player.minutes_played} minutes, and the gaffer knows what he's got in you. This is about maintaining dominance now — every match is a shop window. Scouts from higher leagues are clocking these performances.`;
  }

  return {
    reply: `**Next match:** ${fixture.opponent} — ${fixture.date}, ${fixture.venue} (${fixture.competition})\n\n**Club form (last 5):** ${formStr}\n**League position:** ${club.position}th in the ${club.league}\n**Season target:** ${club.season_goal}${insight}`,
    suggested_actions: [
      { id: "training", label: "View Training Plan", intent: "query:training", icon: "clipboard" },
      { id: "form", label: "Check My Stats", intent: "query:form", icon: "chart" },
      { id: "career", label: "Career Advice", intent: "query:career", icon: "star" },
    ],
  };
}

// ── FORM / STATS ──────────────────────────────

function buildFormResponse(player, engagement) {
  const formLabel = player.form === "excellent" ? "On fire" : player.form === "good" ? "Solid" : "Needs work";

  let commentary;
  if (engagement === "low") {
    commentary = player.form_rating >= 7.5
      ? "You're actually in decent form — imagine how good these numbers could be with more regular training! Every training session (available every 3 hours) pushes these stats higher."
      : "These numbers have room to grow, and that's exciting. Regular training sessions boost your attributes, which directly improves your match performances. Try to train as often as you can — every 3 hours counts.";
  } else if (engagement === "medium") {
    commentary = player.form_rating >= 7.5
      ? "Scouts are starting to pay attention. The next transfer sweep is a real opportunity — keep training and these numbers will only go up."
      : "The foundation is there. A few more consistent performances and training sessions will shift these numbers. The transfer sweep rewards upward trends.";
  } else {
    commentary = player.form_rating >= 7.5
      ? "These are the numbers that get agents' phones ringing. I've been making calls — this form combined with the upcoming transfer sweep could change everything. Don't take your foot off the gas."
      : "The raw talent is there but we need the stats to match. I need you training every window and performing when it matters. Clubs look at these numbers before they make a move.";
  }

  return {
    reply: `**Form:** ${formLabel} (${player.form_rating}/10)\n**Goals:** ${player.goals} | **Assists:** ${player.assists}\n**Minutes:** ${player.minutes_played} across ${player.matches_played} appearances\n**Fitness:** ${player.fitness}% | **Morale:** ${player.morale}\n**Overall:** ${player.overall} | **Potential:** ${player.potential}\n\n${commentary}`,
    suggested_actions: [
      { id: "transfer", label: "Who's Watching?", intent: "query:transfer", icon: "eye" },
      { id: "training", label: "Training Plan", intent: "query:training", icon: "clipboard" },
      { id: "career", label: "Career Path", intent: "query:career", icon: "star" },
    ],
  };
}

// ── TRANSFERS ─────────────────────────────────

function buildTransferResponse(player, interest, engagement) {
  const lines = interest.map(t => `- **${t.club}** (${t.league}) — likelihood: ${t.likelihood}, range: ${t.offer_range}`);
  const hasHeat = interest.some(t => t.likelihood === "high");

  let commentary;
  if (engagement === "low") {
    commentary = hasHeat
      ? "There's genuine interest here — but clubs want to see consistency. The transfer sweep runs every 4 days and clubs look at your recent form, attributes, and morale. If you train regularly and keep your player in good shape, these offers could turn into real moves."
      : "No strong offers yet, but that's normal — it takes time. Here's the key: train your player regularly (every 3 hours), keep morale up, and when the next transfer sweep happens in a few days, better attributes and form will attract bigger clubs. The system rewards the players who put in the work.";
  } else if (engagement === "medium") {
    commentary = hasHeat
      ? "Clubs are watching. The transfer sweep is coming up and your form puts you in a strong position. Stay consistent with your training and we could see a real move materialize."
      : "Nothing concrete yet, but the market moves fast. Keep your form up and the next transfer sweep could bring new interest. A few strong performances change everything.";
  } else {
    commentary = hasHeat
      ? "Right, this is what we've been building toward. There's serious interest and I'm working the phones. The next transfer sweep could be the one — I want your stats peaking when that window opens. This is your moment."
      : "The market's quiet for now, but I know what you're capable of. We need a run of big performances to force their hand. When the transfer sweep lands, I want clubs fighting over you. Let's make that happen.";
  }

  return {
    reply: `**Contract expires:** ${player.contract_expires}\n**Current value:** ${(player.value / 1_000_000).toFixed(1)}M\n**Wage:** ${(player.wage).toLocaleString()}/wk\n\n**Clubs showing interest:**\n${lines.join("\n")}\n\n${commentary}`,
    suggested_actions: [
      { id: "form", label: "Check My Form", intent: "query:form", icon: "chart" },
      { id: "career", label: "Career Advice", intent: "query:career", icon: "star" },
      { id: "match", label: "Next Match", intent: "query:match", icon: "calendar" },
    ],
  };
}

// ── CAREER ────────────────────────────────────

function buildCareerResponse(player, engagement) {
  const gapToFulfil = player.potential - player.overall;

  let advice;
  if (engagement === "low") {
    advice = `Here's what I want you to understand, ${player.name}: your potential is **${player.potential}** — that's a seriously high ceiling. But potential means nothing without the work.\n\nHere's the path:\n1. **Train regularly** — every 3 hours you can boost your attributes\n2. **Play matches** — every night at 10pm, your stats determine your performance\n3. **Build form** — consistent training + match performance = better morale and fitness\n4. **Attract interest** — the transfer sweep runs every 4 days. Better players get offers from bigger clubs\n\nYou've got ${gapToFulfil} rating points between where you are and where you could be. That gap closes every time you train and play. I believe in you — let's start building.`;
  } else if (engagement === "medium") {
    advice = `You've got ${gapToFulfil} points between your current level (${player.overall}) and your ceiling (${player.potential}). ${player.age <= 23 ? "Age is on your side" : "The window is open right now"} — but the gap only closes with consistent effort.\n\n${player.form_rating >= 7.5 ? "Your form is strong. A bigger club could accelerate your development — but only if you'd get minutes there." : "Focus on being the best player at this level first. Consistent form opens every door."}\n\nKeep hitting those training sessions and the next transfer sweep could bring a real opportunity. You're closer than you think.`;
  } else {
    advice = `Right ${player.name}, let's talk business.\n\n**Current level:** ${player.overall} | **Ceiling:** ${player.potential} | **Gap:** ${gapToFulfil} points\n**Age:** ${player.age} — ${player.age <= 23 ? "you've got time, but I don't want to waste it" : "this is prime time, every decision matters"}\n\n${player.form_rating >= 7.5 ? "Your form is screaming for a move. If a top club comes in at the next transfer sweep, we should seriously consider it — but only if they guarantee minutes. I'm not parking you on a bench." : "The form needs to match the talent. I need you dominating every training session and every match. When the numbers are right, I'll get you the move."}\n\n${gapToFulfil >= 10 ? "There's a massive ceiling above you. With the right move and the right development plan, we're talking top-flight football. That's what I'm working toward." : "You're close to your peak — it's about fine margins now. Every session, every match, every detail. That's what separates the good from the elite."}`;
  }

  return {
    reply: advice,
    suggested_actions: [
      { id: "transfer", label: "Transfer Interest", intent: "query:transfer", icon: "eye" },
      { id: "training", label: "Training Plan", intent: "query:training", icon: "clipboard" },
      { id: "form", label: "View Stats", intent: "query:form", icon: "chart" },
    ],
  };
}

// ── MORALE ────────────────────────────────────

function buildMoraleResponse(player, engagement) {
  let commentary;

  if (engagement === "low") {
    if (player.morale === "high") {
      commentary = "Your morale is high — that's great! Morale affects everything: your match performance, your training gains, and how scouts rate you. To keep it high, try to train regularly and stay active. Even logging in to check on your player helps keep things ticking.";
    } else if (player.morale === "medium") {
      commentary = "Morale is sitting at medium. Here's the thing — morale goes up when you train, when you play well, and when you're consistent with your player. Try to get a training session in (they're available every 3 hours) and you should see this improve. Better morale means better performances on match day.";
    } else {
      commentary = "Morale's low at the moment, and that's going to affect your match performances and how attractive you look to scouts. The good news? It's fixable. Get some training sessions done — they're available every 3 hours — and start building a routine. Consistency is key. Your player needs you.";
    }
  } else if (engagement === "medium") {
    if (player.morale === "high") {
      commentary = "You're in a good headspace. Confidence is high — keep feeding it with training sessions and strong performances. This momentum heading into the next transfer sweep is exactly what we want.";
    } else if (player.morale === "medium") {
      commentary = "You're steady but not buzzing. A good match result or a solid training streak could flip this. Try to stay on top of your training windows — that consistency compounds fast.";
    } else {
      commentary = "Morale's dipped. Let's get it back up — hit some training sessions, focus on the basics. A good performance tonight at 10pm could turn this around quickly.";
    }
  } else {
    if (player.morale === "high") {
      commentary = "Mentally sharp, confidence through the roof. This is where deals get done. Clubs don't just look at stats — they look at a player's mentality. You're radiating quality right now. Keep it there.";
    } else if (player.morale === "medium") {
      commentary = "Morale's decent but I've seen you at your best and this isn't it. I need you locked in. Smash the next training session, put in a big performance tonight, and get that swagger back. The scouts need to see a player who believes in himself.";
    } else {
      commentary = "Right, morale's taken a hit and I'm not going to sugarcoat it — clubs notice this. We need to turn it around fast. Get into training, get a rhythm going, and trust the process. I've seen players bounce back from worse. Let's go.";
    }
  }

  return {
    reply: `**Morale:** ${player.morale}\n**Fitness:** ${player.fitness}%\n**Form:** ${player.form} (${player.form_rating}/10)\n\n${commentary}`,
    suggested_actions: [
      { id: "training", label: "Training Plan", intent: "query:training", icon: "clipboard" },
      { id: "career", label: "Career Advice", intent: "query:career", icon: "star" },
      { id: "match", label: "Next Match", intent: "query:match", icon: "calendar" },
    ],
  };
}

// ── GENERAL / FALLBACK ────────────────────────

function buildGeneralResponse(player, text, engagement) {
  let intro;

  if (engagement === "low") {
    intro = `Hey ${player.name}, I'm your football agent — Football Brain. I'm here to help you navigate your career and make the most of your potential.\n\nQuick tip: the more you interact with your player, the better things get. Training is available every 3 hours, matches play out at 10pm daily, and a transfer sweep runs every 4 days. Stay active and the rewards come.\n\nHere's what I can help with:`;
  } else if (engagement === "medium") {
    intro = `Alright ${player.name}, I'm here. What do you need?\n\nI can help you with any of these — just ask or tap a button:`;
  } else {
    intro = `${player.name}, what's the play? You know the drill — I'm on it whatever you need:`;
  }

  return {
    reply: `${intro}\n\n- **Training** — your plan, focus areas, and how to improve\n- **Match** — next fixture, form, and squad info\n- **Stats** — goals, assists, rating, minutes\n- **Transfers** — who's interested and what you're worth\n- **Career** — development path and honest advice\n\nWhat's on your mind?`,
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
  res.json({ ok: true, service: "brain", version: "3.0.0" });
});

// MAIN AGENT ENDPOINT
app.post("/api/agent/chat", async (req, res) => {
  const { message, conversation_id, player_id, club_id, engagement: engagementData } = req.body || {};
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

  // Assess user engagement level (drives personality tone)
  const engagement = assessEngagement(player, engagementData);

  // Build intent-specific response with engagement-aware personality
  let response;
  switch (intent) {
    case "greeting":
      response = buildGreetingResponse(player, engagement);
      break;
    case "training":
      response = buildTrainingResponse(player, getTraining(player_id), engagement);
      break;
    case "match":
      response = buildMatchResponse(player, club, engagement);
      break;
    case "form":
      response = buildFormResponse(player, engagement);
      break;
    case "transfer":
      response = buildTransferResponse(player, getTransferInterest(player_id), engagement);
      break;
    case "career":
      response = buildCareerResponse(player, engagement);
      break;
    case "morale":
      response = buildMoraleResponse(player, engagement);
      break;
    default:
      response = buildGeneralResponse(player, text, engagement);
  }

  return res.json({
    ...response,
    conversation_id: conversation_id || "conv",
    intent,
    metadata: {
      agent_name: "Football Brain",
      agent_role: "Career Advisor",
      engagement_level: engagement,
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
app.listen(PORT, () => console.log("Brain API v3.0 running on port", PORT));
