// ──────────────────────────────────────────────────────────────────────
// FRIEND GROUPS (PRIVATE LEADERBOARDS)
//
// All user_id values are derived from verified JWTs — never from the
// request body or query string.
// ──────────────────────────────────────────────────────────────────────

import { query, withTransaction } from "./db.js";
import crypto from "crypto";

// ── INVITE CODE ────────────────────────────────────────────────────────

function generateInviteCode() {
  // 6 uppercase alphanumeric chars — 36^6 ≈ 2.2 billion combinations
  return crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}

// ── CREATE GROUP ───────────────────────────────────────────────────────

/**
 * Create a new friend group. Creator becomes admin.
 *
 * @param {string} userId   — from req.userId (JWT-derived)
 * @param {string} name
 * @returns {Promise<{ group, member }>}
 */
export async function createGroup(userId, name) {
  if (!name || name.trim().length < 2) {
    throw new Error("Group name must be at least 2 characters");
  }

  return withTransaction(async (client) => {
    // Generate a unique invite code (retry on collision)
    let invite_code;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateInviteCode();
      const { rows } = await client.query(
        "SELECT id FROM leaderboard_groups WHERE invite_code = $1",
        [code]
      );
      if (!rows.length) { invite_code = code; break; }
    }
    if (!invite_code) throw new Error("Could not generate unique invite code — please retry");

    const { rows: [group] } = await client.query(
      `INSERT INTO leaderboard_groups (name, invite_code, created_by)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name.trim(), invite_code, userId]
    );

    const { rows: [member] } = await client.query(
      `INSERT INTO leaderboard_group_members (group_id, user_id, role)
       VALUES ($1, $2, 'admin')
       RETURNING *`,
      [group.id, userId]
    );

    return { group, member };
  });
}

// ── JOIN GROUP ─────────────────────────────────────────────────────────

/**
 * Join a group by invite code.
 * Idempotent — returns existing membership if already a member.
 *
 * @param {string} userId
 * @param {string} inviteCode
 * @returns {Promise<{ group, member, already_member: boolean }>}
 */
export async function joinGroup(userId, inviteCode) {
  if (!inviteCode) throw new Error("invite_code is required");

  const { rows: [group] } = await query(
    "SELECT * FROM leaderboard_groups WHERE invite_code = $1",
    [inviteCode.trim().toUpperCase()]
  );
  if (!group) throw new Error("Invalid invite code — no group found");

  const { rows } = await query(
    `INSERT INTO leaderboard_group_members (group_id, user_id, role)
     VALUES ($1, $2, 'member')
     ON CONFLICT (group_id, user_id) DO NOTHING
     RETURNING *`,
    [group.id, userId]
  );

  if (!rows.length) {
    // Already a member — fetch existing row
    const { rows: [existing] } = await query(
      "SELECT * FROM leaderboard_group_members WHERE group_id = $1 AND user_id = $2",
      [group.id, userId]
    );
    return { group, member: existing, already_member: true };
  }

  return { group, member: rows[0], already_member: false };
}

// ── MY GROUPS ──────────────────────────────────────────────────────────

/**
 * @param {string} userId
 * @returns {Promise<Object[]>}
 */
export async function getMyGroups(userId) {
  const { rows } = await query(
    `SELECT
       g.*,
       m.role,
       m.joined_at,
       (SELECT COUNT(*) FROM leaderboard_group_members WHERE group_id = g.id) AS member_count
     FROM leaderboard_group_members m
     JOIN leaderboard_groups g ON g.id = m.group_id
     WHERE m.user_id = $1
     ORDER BY m.joined_at DESC`,
    [userId]
  );
  return rows;
}

// ── GROUP LEADERBOARD ──────────────────────────────────────────────────

/**
 * Ranked leaderboard for a specific group.
 * Only members of the group can view it.
 *
 * @param {string} groupId
 * @param {string} requestingUserId
 * @returns {Promise<{ group, leaderboard: Object[] }>}
 */
export async function getGroupLeaderboard(groupId, requestingUserId) {
  const { rows: [group] } = await query(
    "SELECT * FROM leaderboard_groups WHERE id = $1",
    [groupId]
  );
  if (!group) throw new Error("Group not found");

  // Auth: must be a member
  const { rows: [membership] } = await query(
    "SELECT id FROM leaderboard_group_members WHERE group_id = $1 AND user_id = $2",
    [groupId, requestingUserId]
  );
  if (!membership) throw new Error("You are not a member of this group");

  const { rows: leaderboard } = await query(
    `SELECT
       m.user_id,
       m.role,
       m.joined_at,
       COALESCE(cs.display_name, 'Coach_' || LEFT(m.user_id, 8))  AS display_name,
       COALESCE(cs.completions_count,    0)                        AS completions_count,
       cs.best_days_to_premier,
       cs.avg_days_to_premier,
       ROW_NUMBER() OVER (
         ORDER BY COALESCE(cs.completions_count, 0) DESC,
                  cs.best_days_to_premier ASC NULLS LAST,
                  cs.avg_days_to_premier  ASC NULLS LAST
       ) AS rank
     FROM leaderboard_group_members m
     LEFT JOIN coach_stats cs ON cs.user_id = m.user_id
     WHERE m.group_id = $1
     ORDER BY rank`,
    [groupId]
  );

  return { group, leaderboard };
}

// ── LEAVE GROUP ────────────────────────────────────────────────────────

/**
 * @param {string} userId
 * @param {string} groupId
 * @returns {Promise<{ success: true }>}
 */
export async function leaveGroup(userId, groupId) {
  const { rowCount } = await query(
    "DELETE FROM leaderboard_group_members WHERE group_id = $1 AND user_id = $2",
    [groupId, userId]
  );
  if (!rowCount) throw new Error("You are not a member of this group");
  return { success: true };
}
