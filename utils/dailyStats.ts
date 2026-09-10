// Client-side reader for the `dailyStats` rollup collection written by the
// Cloudflare Worker cron job (see cloudflare/ai-worker/src/index.js →
// runDailyRollup). Trend charts read from here; "right now" numbers use
// getCountFromServer directly on the source collections.
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
} from "firebase/firestore";
import { db } from "../Firebase_configure";

export type DailyStat = {
  /** YYYY-MM-DD (UTC), also the document id */
  id: string;
  date: string;
  postsCreated: number;
  pollsCreated: number;
  commentsCreated: number;
  /** distinct authors who created a post/poll/comment that UTC day */
  activeUsers: number;
  moderationPending: number;
  moderationApproved: number;
  moderationRejected: number;
  criticalFlags: number;
  reportsSubmitted: number;
  /**
   * moderationCategories tallied across posts moderated that day, e.g.
   * [{ category: "keyword:weapons", count: 2 }, { category: "harassment", count: 1 }].
   * Added in Task 2 for the "moderation reasons" chart.
   */
  moderationCategoryCounts: { category: string; count: number }[];
  computedAtMs?: number;
  /** true while a same-day manual run only covered midnight..now */
  partial?: boolean;
};

export type DailyStatField =
  | "postsCreated"
  | "pollsCreated"
  | "commentsCreated"
  | "activeUsers"
  | "moderationPending"
  | "moderationApproved"
  | "moderationRejected"
  | "criticalFlags"
  | "reportsSubmitted";

const NUMERIC_FIELDS: DailyStatField[] = [
  "postsCreated",
  "pollsCreated",
  "commentsCreated",
  "activeUsers",
  "moderationPending",
  "moderationApproved",
  "moderationRejected",
  "criticalFlags",
  "reportsSubmitted",
];

const dayIdFromOffset = (offsetDays: number): string => {
  const now = new Date();
  const dt = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - offsetDays,
    ),
  );
  return dt.toISOString().slice(0, 10);
};

/** Today's UTC date id. */
export const todayDateId = (): string => dayIdFromOffset(0);

const zeroStat = (id: string): DailyStat => ({
  id,
  date: id,
  postsCreated: 0,
  pollsCreated: 0,
  commentsCreated: 0,
  activeUsers: 0,
  moderationPending: 0,
  moderationApproved: 0,
  moderationRejected: 0,
  criticalFlags: 0,
  reportsSubmitted: 0,
  moderationCategoryCounts: [],
});

const normalizeStat = (id: string, data: Record<string, any>): DailyStat => {
  const stat = zeroStat(id);
  for (const field of NUMERIC_FIELDS) {
    stat[field] = Number(data[field] ?? 0) || 0;
  }
  stat.moderationCategoryCounts = Array.isArray(data.moderationCategoryCounts)
    ? data.moderationCategoryCounts
        .map((entry: any) => ({
          category: String(entry?.category || "").trim(),
          count: Number(entry?.count ?? 0) || 0,
        }))
        .filter((entry: { category: string }) => entry.category.length > 0)
    : [];
  stat.computedAtMs = data.computedAtMs ? Number(data.computedAtMs) : undefined;
  stat.partial = data.partial === true;
  return stat;
};

/**
 * The last `days` *completed* days of rollups (ending yesterday, UTC),
 * oldest-first. Missing days are returned as zero rows so a chart/sparkline
 * always has a continuous axis — the rollup won't have run for every day
 * right after this feature ships.
 */
export async function fetchRecentDailyStats(days: number): Promise<DailyStat[]> {
  const snapshot = await getDocs(
    query(
      collection(db, "dailyStats"),
      orderBy("date", "desc"),
      // +2 headroom: skip a possibly-partial "today" doc and still fill `days`.
      limit(days + 2),
    ),
  );

  const byDate = new Map<string, DailyStat>();
  snapshot.docs.forEach((docSnap) => {
    byDate.set(
      docSnap.id,
      normalizeStat(docSnap.id, docSnap.data() as Record<string, any>),
    );
  });

  const out: DailyStat[] = [];
  // offset `days` .. 1  ->  oldest .. yesterday
  for (let offset = days; offset >= 1; offset -= 1) {
    const id = dayIdFromOffset(offset);
    out.push(byDate.get(id) ?? zeroStat(id));
  }
  return out;
}

/** Sum one numeric field across a set of rollup rows. */
export const sumDailyStat = (
  rows: DailyStat[],
  field: DailyStatField,
): number => rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);

/** Pull a single field out as a plain number[] (for sparklines/charts). */
export const seriesOf = (
  rows: DailyStat[],
  field: DailyStatField,
): number[] => rows.map((row) => Number(row[field]) || 0);

/**
 * Merge every day's moderationCategoryCounts into one { category, count }[]
 * for the whole window, largest first. This is the "last N days" moderation
 * reasons breakdown — N is however many rows are passed in.
 */
export const aggregateCategoryCounts = (
  rows: DailyStat[],
): { category: string; count: number }[] => {
  const totals = new Map<string, number>();
  for (const row of rows) {
    for (const { category, count } of row.moderationCategoryCounts || []) {
      totals.set(category, (totals.get(category) || 0) + count);
    }
  }
  return [...totals.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
};
