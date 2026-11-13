// utils/profileChanges.ts
//
// Telling a real profile change from the online-status heartbeat.
//
// Every open app rewrites its own profile every minute to say it's still
// there (usePresenceHeartbeat in utils/presence.ts). Screens listening to a
// profile for its name, photo or role used to redraw on each of those writes
// — twice, once for the local write and once when the server confirmed it —
// so Home, Profile and the app shell re-rendered on every beat for
// nothing, which showed up as a stutter while scrolling.
//
// useUserPresence, which shows "Active now", must not use this: it needs
// every heartbeat.

/**
 * The fields the heartbeat rewrites on every beat. isOnline is not one of
 * them: it changes only when someone really comes online or goes offline,
 * and profiles show it.
 */
const HEARTBEAT_FIELDS: ReadonlySet<string> = new Set(["lastSeen", "presenceSessions"]);

type Equatable = { isEqual: (other: unknown) => boolean };

const isEquatable = (value: unknown): value is Equatable =>
  typeof value === "object" && value !== null && typeof (value as Equatable).isEqual === "function";

/** Deep equality for Firestore data: Timestamps and references by isEqual. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (isEquatable(a)) return a.isEqual(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  if (aKeys.length !== Object.keys(bRecord).length) return false;
  return aKeys.every((key) => key in bRecord && sameValue(aRecord[key], bRecord[key]));
}

/**
 * True when `next` differs from `previous` only in the heartbeat's own
 * fields — nothing a screen showing the profile needs to redraw for. False
 * for the first snapshot (no `previous`), so it always gets through.
 */
export function isHeartbeatOnlyChange(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): boolean {
  if (!previous || !next) return false;
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (HEARTBEAT_FIELDS.has(key)) continue;
    if (!sameValue(previous[key], next[key])) return false;
  }
  return true;
}
