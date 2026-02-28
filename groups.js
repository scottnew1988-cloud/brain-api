// ──────────────────────────────────────────────────────────────────────
// FRIEND GROUPS (PRIVATE LEADERBOARDS)
//
// Any coach can create a group and share the invite code/link.
// Group leaderboard uses the same ranking rules as the global board.
// ──────────────────────────────────────────────────────────────────────

import { store, genId, nowISO } from "./data-store.js";
import { compareCoaches } from "./leaderboard.js";

// ── HELPERS ────────────────────────────────────────────────────────────

function generateInviteCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function uniqueInviteCode() {
  let code;
  let attempts = 0;
  const existing = new Set([...store.groups.values()].map((g) => g.invite_code));
  do {
    code = generateInviteCode();
    attempts++;
  } while (existing.has(code) && attempts < 20);
  return code;
}

// ── CREATE GROUP ───────────────────────────────────────────────────────

/**
 * Create a new friend group.
 *
 * The creator automatically becomes the group admin.
 *
 * @param {string} userId
 * @param {Object} opts
 * @param {string} opts.name
 * @returns {{ group, member }}
 */
export function createGroup(userId, { name }) {
  if (!name || name.trim().length < 2) {
    throw new Error("Group name must be at least 2 characters");
  }

  const group = {
    id:          genId(),
    name:        name.trim(),
    invite_code: uniqueInviteCode(),
    created_by:  userId,
    created_at:  nowISO(),
  };
  store.groups.set(group.id, group);

  const member = {
    id:        genId(),
    group_id:  group.id,
    user_id:   userId,
    role:      "admin",
    joined_at: nowISO(),
  };
  store.groupMembers.push(member);

  return { group, member };
}

// ── JOIN GROUP ─────────────────────────────────────────────────────────

/**
 * Join a group by invite code.
 *
 * Idempotent — if already a member, returns existing membership.
 *
 * @param {string} userId
 * @param {string} inviteCode
 * @returns {{ group, member, already_member: boolean }}
 */
export function joinGroup(userId, inviteCode) {
  if (!inviteCode) throw new Error("invite_code is required");

  const group = [...store.groups.values()].find(
    (g) => g.invite_code === inviteCode.trim().toUpperCase()
  );
  if (!group) throw new Error("Invalid invite code — no group found");

  const existing = store.groupMembers.find(
    (m) => m.group_id === group.id && m.user_id === userId
  );
  if (existing) return { group, member: existing, already_member: true };

  const member = {
    id:        genId(),
    group_id:  group.id,
    user_id:   userId,
    role:      "member",
    joined_at: nowISO(),
  };
  store.groupMembers.push(member);

  return { group, member, already_member: false };
}

// ── MY GROUPS ──────────────────────────────────────────────────────────

/**
 * Return all groups the user belongs to with membership metadata.
 *
 * @param {string} userId
 * @returns {Object[]}
 */
export function getMyGroups(userId) {
  return store.groupMembers
    .filter((m) => m.user_id === userId)
    .map((m) => {
      const group = store.groups.get(m.group_id);
      if (!group) return null;
      const memberCount = store.groupMembers.filter(
        (gm) => gm.group_id === group.id
      ).length;
      return {
        ...group,
        role:         m.role,
        joined_at:    m.joined_at,
        member_count: memberCount,
      };
    })
    .filter(Boolean);
}

// ── GROUP LEADERBOARD ──────────────────────────────────────────────────

/**
 * Get the ranked leaderboard for a specific group.
 *
 * Only members of the group can view it.
 *
 * @param {string} groupId
 * @param {string} requestingUserId
 * @returns {{ group, leaderboard: Object[] }}
 */
export function getGroupLeaderboard(groupId, requestingUserId) {
  const group = store.groups.get(groupId);
  if (!group) throw new Error("Group not found");

  const isMember = store.groupMembers.some(
    (m) => m.group_id === groupId && m.user_id === requestingUserId
  );
  if (!isMember) throw new Error("You are not a member of this group");

  const members = store.groupMembers.filter((m) => m.group_id === groupId);

  const ranked = members
    .map((m) => {
      const stats = store.coachStats.get(m.user_id);
      return {
        user_id:              m.user_id,
        role:                 m.role,
        joined_at:            m.joined_at,
        display_name:         stats?.display_name ?? `Coach_${m.user_id.slice(0, 8)}`,
        completions_count:    stats?.completions_count    ?? 0,
        best_days_to_premier: stats?.best_days_to_premier ?? null,
        avg_days_to_premier:  stats?.avg_days_to_premier  ?? null,
        updated_at:           stats?.updated_at           ?? null,
      };
    })
    .sort(compareCoaches)
    .map((s, i) => ({ ...s, rank: i + 1 }));

  return { group, leaderboard: ranked };
}

// ── LEAVE GROUP ────────────────────────────────────────────────────────

/**
 * Remove the user from a group.
 *
 * @param {string} userId
 * @param {string} groupId
 * @returns {{ success: true }}
 */
export function leaveGroup(userId, groupId) {
  const idx = store.groupMembers.findIndex(
    (m) => m.group_id === groupId && m.user_id === userId
  );
  if (idx === -1) throw new Error("You are not a member of this group");

  store.groupMembers.splice(idx, 1);
  return { success: true };
}
