// ──────────────────────────────────────────────────────────────────────
// COACHING SQUADS (Clash-of-Clans model)
//
// Rules:
//   - One squad per user (enforced)
//   - privacy: "open" (join immediately) | "request" (leader approves)
//              | "closed" (no new members)
//   - Squad points are earned by member career completions
//   - Unspent points can be spent to upgrade facilities (leader/co-leader only)
//   - Squad level = 1 + floor(sum of facility levels / 4)
// ──────────────────────────────────────────────────────────────────────

import {
  store,
  genId,
  nowISO,
  getSquadFacilities,
  computeSquadLevel,
  initSquadFacilities,
  getUserSquadMembership,
  getSquadMembers,
  isSquadLeaderOrCoLeader,
  FACILITY_TYPES,
  upgradeCost,
} from "./data-store.js";

// ── SQUAD FORMATTING ───────────────────────────────────────────────────

function formatSquad(squad, rank = null) {
  const level       = computeSquadLevel(squad.id);
  const memberCount = getSquadMembers(squad.id).length;
  return {
    ...(rank !== null ? { rank } : {}),
    id:             squad.id,
    name:           squad.name,
    tag:            squad.tag,
    description:    squad.description,
    privacy:        squad.privacy,
    total_points:   squad.total_points,
    unspent_points: squad.unspent_points,
    level,
    member_count:   memberCount,
    created_at:     squad.created_at,
    updated_at:     squad.updated_at,
  };
}

// ── SORT COMPARATOR ────────────────────────────────────────────────────

function compareSquads(a, b) {
  // 1. Most total points first
  if (b.total_points !== a.total_points) return b.total_points - a.total_points;
  // 2. Higher level first
  const lvA = computeSquadLevel(a.id);
  const lvB = computeSquadLevel(b.id);
  if (lvB !== lvA) return lvB - lvA;
  // 3. Earlier update wins (stable tiebreak)
  return new Date(a.updated_at) - new Date(b.updated_at);
}

// ── SQUAD LEADERBOARD ──────────────────────────────────────────────────

/**
 * Return the top squads ranked by total_points DESC.
 *
 * @param {Object} [opts]
 * @param {number} [opts.limit=50]
 * @returns {Object[]}
 */
export function getSquadLeaderboard({ limit = 50 } = {}) {
  return [...store.squads.values()]
    .sort(compareSquads)
    .slice(0, limit)
    .map((s, i) => formatSquad(s, i + 1));
}

// ── SEARCH SQUADS ──────────────────────────────────────────────────────

/**
 * Search squads by name or tag (case-insensitive partial match).
 *
 * @param {Object} [opts]
 * @param {string} [opts.query=""]
 * @param {number} [opts.limit=20]
 * @returns {Object[]}
 */
export function searchSquads({ query = "", limit = 20 } = {}) {
  const q = query.toLowerCase().trim();
  return [...store.squads.values()]
    .filter((s) =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      (s.tag && s.tag.toLowerCase().includes(q))
    )
    .sort(compareSquads)
    .slice(0, limit)
    .map((s, i) => formatSquad(s, i + 1));
}

// ── CREATE SQUAD ───────────────────────────────────────────────────────

/**
 * Create a new coaching squad. The creator becomes the leader.
 *
 * Enforces one-squad-per-user.
 *
 * @param {string} userId
 * @param {Object} opts
 * @param {string}  opts.name
 * @param {string}  [opts.tag]         - Up to 5 uppercase alphanumeric chars
 * @param {string}  [opts.description]
 * @param {string}  [opts.privacy="open"]
 * @returns {{ squad, member }}
 */
export function createSquad(userId, { name, tag, description = "", privacy = "open" }) {
  if (!name || name.trim().length < 2) {
    throw new Error("Squad name must be at least 2 characters");
  }
  if (!["open", "request", "closed"].includes(privacy)) {
    throw new Error("privacy must be one of: open | request | closed");
  }

  // One squad per user
  const existing = getUserSquadMembership(userId);
  if (existing) {
    throw new Error("You are already in a squad. Leave your current squad first.");
  }

  // Sanitise & deduplicate tag
  let cleanTag = null;
  if (tag) {
    cleanTag = tag.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
    if (cleanTag.length < 2) throw new Error("Tag must be 2–5 alphanumeric characters");
    const tagTaken = [...store.squads.values()].some((s) => s.tag === cleanTag);
    if (tagTaken) throw new Error(`Tag "${cleanTag}" is already taken`);
  }

  const squad = {
    id:             genId(),
    name:           name.trim(),
    tag:            cleanTag,
    description:    description.trim(),
    leader_user_id: userId,
    privacy,
    total_points:   0,
    unspent_points: 0,
    level:          1,
    created_at:     nowISO(),
    updated_at:     nowISO(),
  };
  store.squads.set(squad.id, squad);
  initSquadFacilities(squad.id);

  const member = {
    id:                 genId(),
    squad_id:           squad.id,
    user_id:            userId,
    role:               "leader",
    points_contributed: 0,
    status:             "active",
    joined_at:          nowISO(),
  };
  store.squadMembers.push(member);

  return { squad: formatSquad(squad), member };
}

// ── JOIN SQUAD ─────────────────────────────────────────────────────────

/**
 * Immediately join an open squad.
 * Will throw if the squad is not open.
 *
 * @param {string} userId
 * @param {string} squadId
 * @returns {{ squad, member }}
 */
export function joinOpenSquad(userId, squadId) {
  const existing = getUserSquadMembership(userId);
  if (existing) throw new Error("You are already in a squad");

  const squad = store.squads.get(squadId);
  if (!squad) throw new Error("Squad not found");
  if (squad.privacy !== "open") {
    throw new Error("This squad is not open to direct joins — try requesting to join");
  }

  const member = {
    id:                 genId(),
    squad_id:           squadId,
    user_id:            userId,
    role:               "member",
    points_contributed: 0,
    status:             "active",
    joined_at:          nowISO(),
  };
  store.squadMembers.push(member);
  squad.updated_at = nowISO();

  return { squad: formatSquad(squad), member };
}

/**
 * Submit a join request for a "request" privacy squad.
 * For open squads, joins immediately (delegates to joinOpenSquad).
 *
 * @param {string} userId
 * @param {string} squadId
 * @returns {{ request?, member?, already_requested?: boolean }}
 */
export function requestJoinSquad(userId, squadId) {
  const existing = getUserSquadMembership(userId);
  if (existing) throw new Error("You are already in a squad");

  const squad = store.squads.get(squadId);
  if (!squad) throw new Error("Squad not found");

  if (squad.privacy === "closed") {
    throw new Error("This squad is not accepting new members");
  }
  if (squad.privacy === "open") {
    // Redirect to direct join
    return joinOpenSquad(userId, squadId);
  }

  // privacy === "request"
  const existingReq = store.squadJoinRequests.find(
    (r) => r.squad_id === squadId && r.user_id === userId && r.status === "pending"
  );
  if (existingReq) return { request: existingReq, already_requested: true };

  const request = {
    id:          genId(),
    squad_id:    squadId,
    user_id:     userId,
    status:      "pending",
    created_at:  nowISO(),
    resolved_at: null,
    resolved_by: null,
  };
  store.squadJoinRequests.push(request);

  return { request, already_requested: false };
}

// ── MY SQUAD ───────────────────────────────────────────────────────────

/**
 * Return the requesting user's squad dashboard, or null if not in one.
 *
 * Includes: squad metadata, facilities with upgrade costs, members with
 * contribution, and the user's own membership row.
 *
 * @param {string} userId
 * @returns {Object|null}
 */
export function getMySquad(userId) {
  const membership = getUserSquadMembership(userId);
  if (!membership) return null;

  const squad = store.squads.get(membership.squad_id);
  if (!squad) return null;

  return buildSquadProfile(squad, userId, membership);
}

/**
 * Get a squad's public profile (viewable by non-members).
 *
 * @param {string} squadId
 * @returns {Object}
 */
export function getSquadProfile(squadId) {
  const squad = store.squads.get(squadId);
  if (!squad) throw new Error("Squad not found");
  return buildSquadProfile(squad, null, null);
}

function buildSquadProfile(squad, viewerUserId, viewerMembership) {
  const level    = computeSquadLevel(squad.id);
  const members  = getSquadMembers(squad.id)
    .map((m) => {
      const stats = store.coachStats.get(m.user_id);
      return {
        user_id:            m.user_id,
        role:               m.role,
        points_contributed: m.points_contributed,
        display_name:       stats?.display_name ?? `Coach_${m.user_id.slice(0, 8)}`,
        completions_count:  stats?.completions_count ?? 0,
        joined_at:          m.joined_at,
      };
    })
    .sort((a, b) => b.points_contributed - a.points_contributed);

  const facilities = Object.values(getSquadFacilities(squad.id)).map((f) => ({
    ...f,
    upgrade_cost: upgradeCost(f.facility_type, f.level),
  }));

  return {
    squad:         { ...squad, level },
    my_membership: viewerMembership ?? null,
    members,
    facilities,
  };
}

// ── JOIN REQUESTS ──────────────────────────────────────────────────────

/**
 * Return pending join requests for a squad (leader/co-leader only).
 *
 * @param {string} squadId
 * @param {string} requestingUserId
 * @returns {Object[]}
 */
export function getSquadJoinRequests(squadId, requestingUserId) {
  if (!isSquadLeaderOrCoLeader(requestingUserId, squadId)) {
    throw new Error("Only squad leaders and co-leaders can view join requests");
  }

  return store.squadJoinRequests
    .filter((r) => r.squad_id === squadId && r.status === "pending")
    .map((r) => {
      const stats = store.coachStats.get(r.user_id);
      return {
        ...r,
        display_name:      stats?.display_name      ?? `Coach_${r.user_id.slice(0, 8)}`,
        completions_count: stats?.completions_count ?? 0,
      };
    });
}

/**
 * Approve or reject a pending join request.
 *
 * @param {string} requestId
 * @param {string} resolvingUserId  - Must be leader or co-leader
 * @param {"approve"|"reject"} action
 * @returns {{ request, member?: Object }}
 */
export function resolveSquadJoinRequest(requestId, resolvingUserId, action) {
  if (!["approve", "reject"].includes(action)) {
    throw new Error("action must be 'approve' or 'reject'");
  }

  const request = store.squadJoinRequests.find((r) => r.id === requestId);
  if (!request) throw new Error("Join request not found");
  if (request.status !== "pending") throw new Error("Request has already been resolved");

  if (!isSquadLeaderOrCoLeader(resolvingUserId, request.squad_id)) {
    throw new Error("Only squad leaders and co-leaders can resolve join requests");
  }

  request.resolved_at = nowISO();
  request.resolved_by = resolvingUserId;

  let member = null;
  if (action === "approve") {
    // Guard: applicant may have joined another squad since requesting
    const existingMembership = getUserSquadMembership(request.user_id);
    if (existingMembership) {
      request.status = "rejected";
      throw new Error("Applicant is already in a squad — request rejected automatically");
    }

    request.status = "approved";
    member = {
      id:                 genId(),
      squad_id:           request.squad_id,
      user_id:            request.user_id,
      role:               "member",
      points_contributed: 0,
      status:             "active",
      joined_at:          nowISO(),
    };
    store.squadMembers.push(member);

    const squad = store.squads.get(request.squad_id);
    if (squad) squad.updated_at = nowISO();
  } else {
    request.status = "rejected";
  }

  return { request, member };
}

// ── LEAVE SQUAD ────────────────────────────────────────────────────────

/**
 * Remove the user from their current squad.
 *
 * A leader must either be the last member or promote someone first.
 *
 * @param {string} userId
 * @returns {{ success: true }}
 */
export function leaveSquad(userId) {
  const membership = getUserSquadMembership(userId);
  if (!membership) throw new Error("You are not in a squad");

  // Leaders cannot leave if they are the sole leader with other members
  if (membership.role === "leader") {
    const allMembers   = getSquadMembers(membership.squad_id);
    const otherLeaders = allMembers.filter(
      (m) => m.user_id !== userId && (m.role === "leader" || m.role === "co_leader")
    );
    const hasOthers    = allMembers.some((m) => m.user_id !== userId);
    if (hasOthers && otherLeaders.length === 0) {
      throw new Error(
        "Promote another member to leader or co-leader before leaving"
      );
    }
  }

  membership.status = "inactive";
  const squad = store.squads.get(membership.squad_id);
  if (squad) squad.updated_at = nowISO();

  return { success: true };
}

// ── FACILITY UPGRADES ──────────────────────────────────────────────────

/**
 * Upgrade a squad facility by one level, spending unspent_points.
 *
 * Only leaders and co-leaders can upgrade.
 * Cost = base_cost[facilityType] * (currentLevel + 1)
 *
 * @param {string} userId
 * @param {string} squadId
 * @param {string} facilityType  - One of FACILITY_TYPES
 * @returns {{ facility, transaction, squad: { total_points, unspent_points, level } }}
 */
export function upgradeSquadFacility(userId, squadId, facilityType) {
  if (!FACILITY_TYPES.includes(facilityType)) {
    throw new Error(
      `Unknown facility type. Valid options: ${FACILITY_TYPES.join(", ")}`
    );
  }
  if (!isSquadLeaderOrCoLeader(userId, squadId)) {
    throw new Error("Only squad leaders and co-leaders can upgrade facilities");
  }

  const squad = store.squads.get(squadId);
  if (!squad) throw new Error("Squad not found");

  const facilities  = getSquadFacilities(squadId);
  const facility    = facilities[facilityType];
  const cost        = upgradeCost(facilityType, facility.level);

  if (squad.unspent_points < cost) {
    throw new Error(
      `Insufficient points. Upgrade costs ${cost} pts, you have ${squad.unspent_points} pts.`
    );
  }

  const fromLevel    = facility.level;
  facility.level    += 1;
  facility.updated_at = nowISO();

  squad.unspent_points -= cost;
  squad.level           = computeSquadLevel(squadId);  // persist computed level
  squad.updated_at      = nowISO();

  // Audit transaction
  const tx = {
    id:            genId(),
    squad_id:      squadId,
    user_id:       userId,
    points_spent:  cost,
    facility_type: facilityType,
    from_level:    fromLevel,
    to_level:      facility.level,
    created_at:    nowISO(),
  };
  store.squadSpendTransactions.push(tx);

  return {
    facility,
    transaction: tx,
    squad: {
      total_points:   squad.total_points,
      unspent_points: squad.unspent_points,
      level:          squad.level,
    },
  };
}

// ── PROMOTE MEMBER ROLE ────────────────────────────────────────────────

/**
 * Change a member's role (leader-only action).
 * Useful before a leader leaves so someone can take over.
 *
 * @param {string} leaderId
 * @param {string} targetUserId
 * @param {string} squadId
 * @param {"co_leader"|"member"} newRole
 * @returns {{ member }}
 */
export function setMemberRole(leaderId, targetUserId, squadId, newRole) {
  if (!["co_leader", "member"].includes(newRole)) {
    throw new Error("newRole must be 'co_leader' or 'member'");
  }
  const leaderMembership = store.squadMembers.find(
    (m) => m.squad_id === squadId && m.user_id === leaderId && m.status === "active"
  );
  if (!leaderMembership || leaderMembership.role !== "leader") {
    throw new Error("Only the squad leader can change member roles");
  }

  const targetMembership = store.squadMembers.find(
    (m) => m.squad_id === squadId && m.user_id === targetUserId && m.status === "active"
  );
  if (!targetMembership) throw new Error("Target user is not in this squad");

  targetMembership.role = newRole;
  return { member: targetMembership };
}
