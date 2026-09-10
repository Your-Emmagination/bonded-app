// Templated anomaly detection for the Analytics screen (Task 3, Feature B).
//
// Design, consistent with this app's non-generative chatbot: the
// "intelligence" is the statistical test below, NOT a language model
// describing the numbers. detectAnomalies() decides what's unusual;
// anomalySentence() fills real numbers into a fixed sentence — no free text.
//
//   • Current week  = the last 7 completed days of dailyStats.
//   • Baseline      = the 4 weeks (28 days) immediately before that, averaged
//                     to a per-week figure. 4 weeks is long enough to smooth
//                     out a single loud day, short enough to still reflect
//                     "normal for this month".
//   • Threshold     = ±50% deviation from the baseline weekly average. A
//                     judgment call: big enough that ordinary week-to-week
//                     wobble doesn't trip it, small enough to catch a real
//                     spike early. Tune ANOMALY_THRESHOLD if it's noisy.
//
// If there isn't a full 4 weeks of *real* rollup history yet (gap-filled zero
// rows don't count), it returns "insufficient-history" rather than comparing
// against incomplete data.
import type { DailyStat, DailyStatField } from "./dailyStats";
import { sumDailyStat } from "./dailyStats";

const WEEK = 7;
const BASELINE_WEEKS = 4;
const BASELINE_DAYS = BASELINE_WEEKS * WEEK; // 28
const HISTORY_DAYS = WEEK + BASELINE_DAYS; // 35
export const ANOMALY_THRESHOLD = 0.5; // ±50%

export type AnomalyMetric = { field: DailyStatField; label: string };

export const ANOMALY_METRICS: AnomalyMetric[] = [
  { field: "criticalFlags", label: "Critical flags" },
  { field: "reportsSubmitted", label: "Reports submitted" },
  { field: "moderationPending", label: "Pending moderation actions" },
];

export type Anomaly = {
  field: DailyStatField;
  label: string;
  current: number;
  /** weekly average across the 4-week baseline */
  baselineAvg: number;
  /** fractional change vs baseline (0.5 = +50%); null when baseline is 0 */
  deltaPct: number | null;
  direction: "up" | "down";
};

export type AnomalyResult =
  | { status: "insufficient-history"; weeksAvailable: number; weeksNeeded: number }
  | { status: "ok"; anomalies: Anomaly[] };

/**
 * `rows` is dailyStats oldest→newest (from fetchRecentDailyStats). Must span
 * at least the last 35 days; only rows with a real `computedAtMs` count as
 * history.
 */
export function detectAnomalies(rows: DailyStat[]): AnomalyResult {
  const window = rows.slice(-HISTORY_DAYS);
  const baselineWindow = window.slice(0, BASELINE_DAYS);
  const currentWindow = window.slice(-WEEK);

  const baselineReal = baselineWindow.filter((row) => row.computedAtMs).length;
  const currentReal = currentWindow.filter((row) => row.computedAtMs).length;

  if (
    window.length < HISTORY_DAYS ||
    baselineReal < BASELINE_DAYS ||
    currentReal < WEEK
  ) {
    // Report progress toward the 4 full baseline weeks the comparison needs
    // (the current week must also be complete, but that fills in on its own).
    return {
      status: "insufficient-history",
      weeksAvailable: Math.min(BASELINE_WEEKS, Math.floor(baselineReal / WEEK)),
      weeksNeeded: BASELINE_WEEKS,
    };
  }

  const anomalies: Anomaly[] = [];
  for (const { field, label } of ANOMALY_METRICS) {
    const current = sumDailyStat(currentWindow, field);
    const baselineAvg =
      Math.round((sumDailyStat(baselineWindow, field) / BASELINE_WEEKS) * 10) / 10;

    if (baselineAvg === 0) {
      // Nothing to compare against. Only worth surfacing if something is
      // now happening where there was previously nothing at all.
      if (current > 0) {
        anomalies.push({
          field,
          label,
          current,
          baselineAvg: 0,
          deltaPct: null,
          direction: "up",
        });
      }
      continue;
    }

    const deltaPct = (current - baselineAvg) / baselineAvg;
    if (Math.abs(deltaPct) >= ANOMALY_THRESHOLD) {
      anomalies.push({
        field,
        label,
        current,
        baselineAvg,
        deltaPct,
        direction: deltaPct > 0 ? "up" : "down",
      });
    }
  }

  return { status: "ok", anomalies };
}

/** Fixed-structure line. Real numbers only — never generated prose. */
export function anomalySentence(anomaly: Anomaly): string {
  if (anomaly.deltaPct === null) {
    return `${anomaly.label}: ${anomaly.current} this week (no comparable activity in the past ${BASELINE_WEEKS} weeks)`;
  }
  const pct = `${anomaly.deltaPct > 0 ? "+" : ""}${Math.round(anomaly.deltaPct * 100)}%`;
  return `${anomaly.label}: ${anomaly.current} this week vs. average of ${anomaly.baselineAvg} (${pct})`;
}
