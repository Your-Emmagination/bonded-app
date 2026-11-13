// utils/pinnedPosts.ts
//
// Pinned posts and polls: BondED's "Important Announcements".
//
// Staff pin a post or poll, for a set time or with no end. Home shows a bar
// with how many are pinned (PinnedBar); the Pinned page lists them in full,
// "Ending soon" first, then "Always pinned". A pin ends on its own when its
// time is up; the post stays in the feed where it always was.
//
// Pins load with their own small query rather than from the feed, so they
// are all there however far the feed has been scrolled.
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { db } from "../Firebase_configure";
import { formatTargetDateLabel } from "./dateDetection";

export type PinnedKind = "post" | "poll";

export type PinnedItem = {
  kind: PinnedKind;
  id: string;
  /** The post or poll document, with its id. */
  data: Record<string, any> & { id: string };
  pinnedAtMs: number;
  /** When the pin ends, or null for "no end". */
  endsAtMs: number | null;
};

/** How many pinned documents are read per kind: the most recently pinned. */
const MAX_PINS_LOADED = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

export function timestampMs(value: unknown): number {
  const v = value as { toMillis?: () => number; seconds?: number } | null | undefined;
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.seconds === "number") return v.seconds * 1000;
  if (value instanceof Date) return value.getTime();
  return 0;
}

/**
 * When this pin ends: its own end time, and for a poll also when voting
 * closes — a pinned poll leaves Important Announcements with its vote.
 */
export function pinEndsAtMs(kind: PinnedKind, data: Record<string, any>): number | null {
  const ends = [
    timestampMs(data.pinExpiresAt),
    kind === "post" ? timestampMs(data.targetDate) : 0,
    kind === "poll" ? timestampMs(data.expiresAt) : 0,
  ].filter((ms) => ms > 0);
  return ends.length ? Math.min(...ends) : null;
}

/** Pinned, not ended, approved, and on the campus feed (not a server's). */
function isShowablePin(kind: PinnedKind, data: Record<string, any>, nowMs: number): boolean {
  if (!data.pinnedAt) return false;
  if (data.serverId) return false;
  if (String(data.moderationStatus ?? "approved").toLowerCase() !== "approved") return false;
  const endsAt = pinEndsAtMs(kind, data);
  return endsAt === null || endsAt > nowMs;
}

/**
 * The current pins, live: ending soonest first, then the ones with no end
 * (most recently pinned first). Re-checked every minute so an ended pin
 * drops off while the screen is open.
 */
export function usePinnedContent(enabled: boolean): { items: PinnedItem[]; loading: boolean } {
  const [posts, setPosts] = useState<PinnedItem["data"][]>([]);
  const [polls, setPolls] = useState<PinnedItem["data"][]>([]);
  const [loaded, setLoaded] = useState({ post: false, poll: false });
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const listen = (name: "posts" | "polls", kind: PinnedKind, set: (rows: PinnedItem["data"][]) => void) =>
      onSnapshot(
        query(
          collection(db, name),
          where("pinnedAt", "!=", null),
          orderBy("pinnedAt", "desc"),
          limit(MAX_PINS_LOADED),
        ),
        (snapshot) => {
          set(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })));
          setLoaded((previous) => ({ ...previous, [kind]: true }));
        },
        (error) => {
          console.warn(`[pinned] ${name} failed:`, error);
          setLoaded((previous) => ({ ...previous, [kind]: true }));
        },
      );
    const stopPosts = listen("posts", "post", setPosts);
    const stopPolls = listen("polls", "poll", setPolls);
    return () => {
      stopPosts();
      stopPolls();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [enabled]);

  const items = useMemo(() => buildPinnedItems(posts, polls, nowMs), [posts, polls, nowMs]);

  return { items, loading: enabled && !(loaded.post && loaded.poll) };
}

/**
 * The pins to show from the pinned posts and polls loaded: only live ones,
 * ending soonest first, then the ones with no end, most recently pinned first.
 */
export function buildPinnedItems(
  posts: PinnedItem["data"][],
  polls: PinnedItem["data"][],
  nowMs: number,
): PinnedItem[] {
  const toItem = (kind: PinnedKind) => (data: PinnedItem["data"]): PinnedItem => ({
    kind,
    id: data.id,
    data,
    pinnedAtMs: timestampMs(data.pinnedAt),
    endsAtMs: pinEndsAtMs(kind, data),
  });
  const all: PinnedItem[] = [
    ...posts.filter((data) => isShowablePin("post", data, nowMs)).map(toItem("post")),
    ...polls.filter((data) => isShowablePin("poll", data, nowMs)).map(toItem("poll")),
  ];
  return all.sort((a, b) => {
    if (a.endsAtMs !== null && b.endsAtMs !== null) return a.endsAtMs - b.endsAtMs;
    if (a.endsAtMs !== null) return -1;
    if (b.endsAtMs !== null) return 1;
    return b.pinnedAtMs - a.pinnedAtMs;
  });
}

export type PinUrgency = {
  label: string;
  tone: "red" | "amber" | "date" | "none";
};

/** The countdown shown on a pin: the same wording the announcement cards used. */
export function pinUrgency(endsAtMs: number | null, nowMs: number = Date.now()): PinUrgency {
  if (endsAtMs === null) return { label: "No end", tone: "none" };
  const leftMs = endsAtMs - nowMs;
  const hours = Math.floor(leftMs / (60 * 60 * 1000));
  if (hours < 24) return { label: hours < 1 ? "Ends in < 1h" : `Ends in ${hours}h`, tone: "red" };
  const days = Math.floor(hours / 24);
  if (days <= 3) return { label: days === 1 ? "Ends tomorrow" : `${days} days left`, tone: "amber" };
  const date = new Date(endsAtMs);
  return {
    label: `Until ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
    tone: "date",
  };
}

/** Pins ending within a day, for the red chip on Home's bar. */
export function urgentPins(items: PinnedItem[], nowMs: number = Date.now()): PinnedItem[] {
  return items.filter((item) => item.endsAtMs !== null && item.endsAtMs - nowMs < DAY_MS);
}

const collectionFor = (kind: PinnedKind) => (kind === "post" ? "posts" : "polls");

/**
 * Pins a post or poll to Important Announcements until `endsAt`, or with no
 * end (null). Staff only; firestore.rules checks it.
 */
export async function pinContent(kind: PinnedKind, id: string, uid: string, endsAt: Date | null) {
  const end = endsAt ? Timestamp.fromDate(endsAt) : null;
  await updateDoc(doc(db, collectionFor(kind), id), {
    pinnedAt: serverTimestamp(),
    pinnedBy: uid,
    pinExpiresAt: end,
    // Posts also keep the end in targetDate, where Create/Edit Post reads it.
    ...(kind === "post"
      ? { targetDate: end, targetDateLabel: endsAt ? formatTargetDateLabel(endsAt) : null }
      : {}),
  });
}

/** Unpins it. It stays in the feed where it was. */
export async function unpinContent(kind: PinnedKind, id: string) {
  await updateDoc(doc(db, collectionFor(kind), id), {
    pinnedAt: null,
    pinnedBy: null,
    pinExpiresAt: null,
    ...(kind === "post" ? { targetDate: null, targetDateLabel: null } : {}),
  });
}

// ── The red dot: pins this person hasn't opened the Pinned page since ──

const seenKey = (uid: string) => `bonded:pinnedSeen:${uid}`;
const seenListeners = new Set<() => void>();

/** Remembers the pins shown now, so the dot clears until something new is pinned. */
export async function markPinsSeen(uid: string, ids: string[]) {
  try {
    await AsyncStorage.setItem(seenKey(uid), JSON.stringify(ids));
  } catch {
    // Only the dot depends on it.
  }
  seenListeners.forEach((listener) => listener());
}

/** How many of `ids` weren't there the last time this person opened the Pinned page. */
export function useUnseenPinCount(uid: string | undefined, ids: string[]): number {
  const [seen, setSeen] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!uid) return;
    let active = true;
    const load = () => {
      AsyncStorage.getItem(seenKey(uid))
        .then((raw) => {
          if (!active) return;
          const parsed = raw ? (JSON.parse(raw) as unknown) : [];
          setSeen(new Set(Array.isArray(parsed) ? parsed.map(String) : []));
        })
        .catch(() => {
          if (active) setSeen(new Set());
        });
    };
    load();
    seenListeners.add(load);
    return () => {
      active = false;
      seenListeners.delete(load);
    };
  }, [uid]);
  if (!uid || !seen) return 0;
  return ids.filter((id) => !seen.has(id)).length;
}
