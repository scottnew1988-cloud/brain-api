// ──────────────────────────────────────────────────────────────────────
// COACHING SQUADS
//
// All user_id values derive from JWT middleware (req.userId).
// Clients cannot forge identity.
//
// Concurrency-critical operations (upgrade, approve request) use
// SELECT … FOR UPDATE inside transactions to prevent races.
// ──────────────────────────────────────────────────────────────────────

import { query, withTransaction } from "./db.js";
import { FACILITY_TYPES, upgradeCost } from "./data-store.js";
import crypto from "crypto";

// ── SHARED HELPERS ─────────────────────────────────────────────────────

/** Compute squad level from the sum of all its facility levels */
async function computeSquadLevel(client, squadId) {
  const { rows: [r] } = await client.query(
    `SELECT COALESCE(SUM(level), 0)::integer AS total
     FROM squad_facilities WHERE squad_id = $1`,
    [squadId]
  );
  return 1 + Math.floor(r.total / 4);
}

/** Assert user is leader or co-leader of the squad (throws otherwise) */
async function assertLeaderOrCoLeader(client, userId, squadId) {
  const { rows } = await client.query(
    `SELECT role FROM coaching_squad_members
     WHERE squad_id = $1 AND user_id = $2 AND status = 'active'`,
    [squadId, userId]
  );
  if (!rows.length || !["leader", "co_leader"].includes(rows[0].role)) {
    throw new Error("Only squad leaders and co-leaders can perform this action");
  }
  return rows[0].role;
}

/** Check if user is already in any active squad */
async function getUserActiveMembership(client, userId) {
  const { rows } = await client.query(
    `SELECT csm.*, cs.name AS squad_name
     FROM coaching_squad_members csm
     JOIN coaching_squads cs ON cs.id = csm.squad_id
     WHERE csm.user_id = $1 AND csm.status = 'active'
     LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

/** Initialise all 4 facility slots at level 0 for a new squad */
async function initFacilities(client, squadId) {
  const values = FACILITY_TYPES.map((ft, i) => `($1, $${i + 2})`).join(", ");
  await client.query(
    `INSERT INTO squad_facilities (squad_id, facility_type)
     VALUES ${values}
     ON CONFLICT (squad_id, facility_type) DO NOTHING`,
    [squadId, ...FACILITY_TYPES]
  );
}

/** Attach facilities + upgrade costs to a squad response */
async function fetchFacilitiesWithCosts(squadId) {
  const { rows } = await query(
    "SELECT * FROM squad_facilities WHERE squad_id = $1 ORDER BY facility_type",
    [squadId]
  );
  return rows.map((f) => ({
    ...f,
    level:        Number(f.level),
    upgrade_cost: upgradeCost(f.facility_type, Number(f.level)),
  }));
}

/** Members of a squad sorted by contribution */
async function fetchMembers(squadId) {
  const { rows } = await query(
    `SELECT
       csm.user_id,
       csm.role,
       csm.points_contributed,
       csm.joined_at,
       COALESCE(cs.display_name, 'Coach_' || LEFT(csm.user_id, 8)) AS display_name,
       COALESCE(cs.completions_count, 0) AS completions_count
     FROM coaching_squad_members csm
     LEFT JOIN coach_stats cs ON cs.user_id = csm.user_id
     WHERE csm.squad_id = $1 AND csm.status = 'active'
     ORDER BY csm.points_contributed DESC`,
    [squadId]
  );
  return rows;
}

// ── LEADERBOARD ────────────────────────────────────────────────────────

// Shared ORDER BY used in both leaderboard and search queries
const SQUAD_ORDER = "ORDER BY total_points DESC, level DESC, updated_at ASC";

// Base SELECT that joins member count in one pass (eliminates N+1 subquery)
const SQUAD_SELECT = `
  SELECT
    s.*,
    ROW_NUMBER() OVER (${SQUAD_ORDER}) AS rank,
    COUNT(csm.id) AS member_count
  FROM coaching_squads s
  LEFT JOIN coaching_squad_members csm
    ON csm.squad_id = s.id AND csm.status = 'active'`;

const SQUAD_GROUP = `GROUP BY s.id`;

export async function getSquadLeaderboard({ limit = 50 } = {}) {
  const cap = Math.min(limit, 100);
  const { rows } = await query(
    `${SQUAD_SELECT}
     ${SQUAD_GROUP}
     ${SQUAD_ORDER}
     LIMIT $1`,
    [cap]
  );
  return rows.map(formatSquad);
}

export async function searchSquads({ query: q = "", limit = 20 } = {}) {
  const cap  = Math.min(limit, 50);
  const like = `%${q.toLowerCase()}%`;
  const { rows } = await query(
    `${SQUAD_SELECT}
     WHERE $1 = '' OR LOWER(s.name) LIKE $2 OR LOWER(COALESCE(s.tag,'')) LIKE $2
     ${SQUAD_GROUP}
     ${SQUAD_ORDER}
     LIMIT $3`,
    [q, like, cap]
  );
  return rows.map(formatSquad);
}

function formatSquad(r) {
  return {
    rank:           r.rank ? Number(r.rank) : null,
    id:             r.id,
    name:           r.name,
    tag:            r.tag,
    description:    r.description,
    privacy:        r.privacy,
    total_points:   Number(r.total_points),
    unspent_points: Number(r.unspent_points),
    level:          Number(r.level),
    member_count:   r.member_count ? Number(r.member_count) : undefined,
    created_at:     r.created_at,
    updated_at:     r.updated_at,
  };
}

// ── CREATE SQUAD ───────────────────────────────────────────────────────

export async function createSquad(userId, { name, tag, description = "", privacy = "open" }) {
  if (!name || name.trim().length < 2) {
    throw new Error("Squad name must be at least 2 characters");
  }
  if (!["open", "request", "closed"].includes(privacy)) {
    throw new Error("privacy must be one of: open | request | closed");
  }

  let cleanTag = null;
  if (tag) {
    cleanTag = tag.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
    if (cleanTag.length < 2) throw new Error("Tag must be 2–5 alphanumeric characters");
  }

  return withTransaction(async (client) => {
    // One-squad-per-user enforcement
    const existing = await getUserActiveMembership(client, userId);
    if (existing) {
      throw new Error(`You are already in squad "${existing.squad_name}". Leave first.`);
    }

    const { rows: [squad] } = await client.query(
      `INSERT INTO coaching_squads
         (name, tag, description, leader_user_id, privacy)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name.trim(), cleanTag, description.trim(), userId, privacy]
    );

    const { rows: [member] } = await client.query(
      `INSERT INTO coaching_squad_members (squad_id, user_id, role)
       VALUES ($1, $2, 'leader')
       RETURNING *`,
      [squad.id, userId]
    );

    await initFacilities(client, squad.id);

    return { squad: formatSquad(squad), member };
  });
}

// ── JOIN ───────────────────────────────────────────────────────────────

export async function joinOpenSquad(userId, squadId) {
  return withTransaction(async (client) => {
    const existing = await getUserActiveMembership(client, userId);
    if (existing) throw new Error("You are already in a squad");

    const { rows: [squad] } = await client.query(
      "SELECT * FROM coaching_squads WHERE id = $1 FOR UPDATE",
      [squadId]
    );
    if (!squad) throw new Error("Squad not found");
    if (squad.privacy !== "open") {
      throw new Error("This squad is not open to direct joins — use request-join instead");
    }

    const { rows: [member] } = await client.query(
      `INSERT INTO coaching_squad_members (squad_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (squad_id, user_id) DO UPDATE SET status = 'active'
       RETURNING *`,
      [squadId, userId]
    );

    await client.query(
      "UPDATE coaching_squads SET updated_at = NOW() WHERE id = $1",
      [squadId]
    );

    return { squad: formatSquad(squad), member };
  });
}

export async function requestJoinSquad(userId, squadId) {
  return withTransaction(async (client) => {
    const existing = await getUserActiveMembership(client, userId);
    if (existing) throw new Error("You are already in a squad");

    const { rows: [squad] } = await client.query(
      "SELECT * FROM coaching_squads WHERE id = $1",
      [squadId]
    );
    if (!squad) throw new Error("Squad not found");

    if (squad.privacy === "closed") {
      throw new Error("This squad is not accepting new members");
    }
    if (squad.privacy === "open") {
      // Delegate — but we already have a client, so inline the logic
      const { rows: [member] } = await client.query(
        `INSERT INTO coaching_squad_members (squad_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (squad_id, user_id) DO UPDATE SET status = 'active'
         RETURNING *`,
        [squadId, userId]
      );
      await client.query(
        "UPDATE coaching_squads SET updated_at = NOW() WHERE id = $1",
        [squadId]
      );
      return { squad: formatSquad(squad), member, joined: true };
    }

    // privacy === "request" — create/return request
    const { rows } = await client.query(
      `INSERT INTO coaching_squad_join_requests (squad_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [squadId, userId]
    );

    if (!rows.length) {
      const { rows: [existingReq] } = await client.query(
        `SELECT * FROM coaching_squad_join_requests
         WHERE squad_id = $1 AND user_id = $2 AND status = 'pending'`,
        [squadId, userId]
      );
      return { request: existingReq, already_requested: true };
    }

    return { request: rows[0], already_requested: false };
  });
}

// ── MY SQUAD ───────────────────────────────────────────────────────────

export async function getMySquad(userId) {
  const { rows: [membership] } = await query(
    `SELECT * FROM coaching_squad_members
     WHERE user_id = $1 AND status = 'active'
     LIMIT 1`,
    [userId]
  );
  if (!membership) return null;

  const { rows: [squad] } = await query(
    "SELECT * FROM coaching_squads WHERE id = $1",
    [membership.squad_id]
  );
  if (!squad) return null;

  const [members, facilities] = await Promise.all([
    fetchMembers(squad.id),
    fetchFacilitiesWithCosts(squad.id),
  ]);

  return {
    squad:         formatSquad(squad),
    my_membership: membership,
    members,
    facilities,
  };
}

export async function getSquadProfile(squadId) {
  const { rows: [squad] } = await query(
    "SELECT * FROM coaching_squads WHERE id = $1",
    [squadId]
  );
  if (!squad) throw new Error("Squad not found");

  const [members, facilities] = await Promise.all([
    fetchMembers(squad.id),
    fetchFacilitiesWithCosts(squad.id),
  ]);

  return { squad: formatSquad(squad), members, facilities };
}

// ── JOIN REQUESTS ──────────────────────────────────────────────────────

export async function getSquadJoinRequests(squadId, requestingUserId) {
  // Auth check — throws if not leader/co-leader
  await withTransaction((c) => assertLeaderOrCoLeader(c, requestingUserId, squadId));

  const { rows } = await query(
    `SELECT
       r.*,
       COALESCE(cs.display_name, 'Coach_' || LEFT(r.user_id, 8)) AS display_name,
       COALESCE(cs.completions_count, 0) AS completions_count
     FROM coaching_squad_join_requests r
     LEFT JOIN coach_stats cs ON cs.user_id = r.user_id
     WHERE r.squad_id = $1 AND r.status = 'pending'
     ORDER BY r.created_at`,
    [squadId]
  );
  return rows;
}

export async function resolveSquadJoinRequest(requestId, resolvingUserId, action) {
  if (!["approve", "reject"].includes(action)) {
    throw new Error("action must be 'approve' or 'reject'");
  }

  return withTransaction(async (client) => {
    const { rows: [request] } = await client.query(
      "SELECT * FROM coaching_squad_join_requests WHERE id = $1 FOR UPDATE",
      [requestId]
    );
    if (!request) throw new Error("Join request not found");
    if (request.status !== "pending") throw new Error("Request has already been resolved");

    await assertLeaderOrCoLeader(client, resolvingUserId, request.squad_id);

    let member = null;
    if (action === "approve") {
      // Verify applicant hasn't joined another squad in the meantime
      const alreadyIn = await getUserActiveMembership(client, request.user_id);
      if (alreadyIn) {
        // Auto-reject and surface a clear error
        await client.query(
          `UPDATE coaching_squad_join_requests
           SET status = 'rejected', resolved_at = NOW(), resolved_by = $1
           WHERE id = $2`,
          [resolvingUserId, requestId]
        );
        throw new Error("Applicant is already in a squad — request rejected automatically");
      }

      const { rows: [m] } = await client.query(
        `INSERT INTO coaching_squad_members (squad_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (squad_id, user_id) DO UPDATE SET status = 'active'
         RETURNING *`,
        [request.squad_id, request.user_id]
      );
      member = m;

      await client.query(
        "UPDATE coaching_squads SET updated_at = NOW() WHERE id = $1",
        [request.squad_id]
      );
    }

    const { rows: [updated] } = await client.query(
      `UPDATE coaching_squad_join_requests
       SET status = $1, resolved_at = NOW(), resolved_by = $2
       WHERE id = $3
       RETURNING *`,
      [action === "approve" ? "approved" : "rejected", resolvingUserId, requestId]
    );

    return { request: updated, member };
  });
}

// ── LEAVE ──────────────────────────────────────────────────────────────

export async function leaveSquad(userId) {
  return withTransaction(async (client) => {
    const { rows: [membership] } = await client.query(
      `SELECT * FROM coaching_squad_members
       WHERE user_id = $1 AND status = 'active'
       FOR UPDATE`,
      [userId]
    );
    if (!membership) throw new Error("You are not in a squad");

    if (membership.role === "leader") {
      const { rows: others } = await client.query(
        `SELECT user_id, role FROM coaching_squad_members
         WHERE squad_id = $1 AND user_id != $2 AND status = 'active'`,
        [membership.squad_id, userId]
      );
      const hasOtherLeadership = others.some(
        (m) => m.role === "leader" || m.role === "co_leader"
      );
      if (others.length > 0 && !hasOtherLeadership) {
        throw new Error(
          "Promote another member to co_leader before leaving, or be the last member"
        );
      }
    }

    await client.query(
      "UPDATE coaching_squad_members SET status = 'inactive' WHERE id = $1",
      [membership.id]
    );
    await client.query(
      "UPDATE coaching_squads SET updated_at = NOW() WHERE id = $1",
      [membership.squad_id]
    );

    return { success: true };
  });
}

// ── FACILITY UPGRADE ───────────────────────────────────────────────────

export async function upgradeSquadFacility(userId, squadId, facilityType) {
  if (!FACILITY_TYPES.includes(facilityType)) {
    throw new Error(`Unknown facility type. Valid: ${FACILITY_TYPES.join(", ")}`);
  }

  return withTransaction(async (client) => {
    await assertLeaderOrCoLeader(client, userId, squadId);

    // Lock squad row to prevent concurrent upgrades
    const { rows: [squad] } = await client.query(
      "SELECT * FROM coaching_squads WHERE id = $1 FOR UPDATE",
      [squadId]
    );
    if (!squad) throw new Error("Squad not found");

    // Lock facility row and read current level
    const { rows: [facility] } = await client.query(
      `SELECT * FROM squad_facilities
       WHERE squad_id = $1 AND facility_type = $2
       FOR UPDATE`,
      [squadId, facilityType]
    );
    if (!facility) throw new Error("Facility slot not initialised for this squad");

    const currentLevel = Number(facility.level);
    const cost         = upgradeCost(facilityType, currentLevel);

    if (Number(squad.unspent_points) < cost) {
      throw new Error(
        `Insufficient points. Upgrade costs ${cost} pts, squad has ${squad.unspent_points} pts.`
      );
    }

    // Upgrade facility
    const { rows: [updatedFacility] } = await client.query(
      `UPDATE squad_facilities
       SET level = level + 1, updated_at = NOW()
       WHERE squad_id = $1 AND facility_type = $2
       RETURNING *`,
      [squadId, facilityType]
    );

    // Recompute squad level (uses the just-updated facility levels)
    const newLevel = await computeSquadLevel(client, squadId);

    // Deduct points + update squad level
    const { rows: [updatedSquad] } = await client.query(
      `UPDATE coaching_squads
       SET unspent_points = unspent_points - $1,
           level          = $2,
           updated_at     = NOW()
       WHERE id = $3
       RETURNING total_points, unspent_points, level`,
      [cost, newLevel, squadId]
    );

    // Audit transaction
    const { rows: [tx] } = await client.query(
      `INSERT INTO squad_spend_transactions
         (squad_id, user_id, points_spent, facility_type, from_level, to_level)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [squadId, userId, cost, facilityType, currentLevel, currentLevel + 1]
    );

    return {
      facility:    { ...updatedFacility, level: Number(updatedFacility.level), upgrade_cost: upgradeCost(facilityType, Number(updatedFacility.level)) },
      transaction: tx,
      squad: {
        total_points:   Number(updatedSquad.total_points),
        unspent_points: Number(updatedSquad.unspent_points),
        level:          Number(updatedSquad.level),
      },
    };
  });
}

// ── SET MEMBER ROLE ────────────────────────────────────────────────────

export async function setMemberRole(leaderId, targetUserId, squadId, newRole) {
  if (!["co_leader", "member"].includes(newRole)) {
    throw new Error("newRole must be 'co_leader' or 'member'");
  }

  return withTransaction(async (client) => {
    const { rows: [leaderMem] } = await client.query(
      `SELECT role FROM coaching_squad_members
       WHERE squad_id = $1 AND user_id = $2 AND status = 'active'`,
      [squadId, leaderId]
    );
    if (!leaderMem || leaderMem.role !== "leader") {
      throw new Error("Only the squad leader can change member roles");
    }

    const { rows: [target] } = await client.query(
      `UPDATE coaching_squad_members
       SET role = $1
       WHERE squad_id = $2 AND user_id = $3 AND status = 'active'
       RETURNING *`,
      [newRole, squadId, targetUserId]
    );
    if (!target) throw new Error("Target member not found in this squad");

    return { member: target };
  });
}
