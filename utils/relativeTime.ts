import { useEffect, useState } from "react";
import { AppState } from "react-native";

const DEFAULT_RELATIVE_TIME_TICK_MS = 30 * 1000;

export const useRelativeTimeNow = (
  intervalMs = DEFAULT_RELATIVE_TIME_TICK_MS,
) => {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const refreshNow = () => setNowMs(Date.now());

    refreshNow();
    const intervalId = setInterval(refreshNow, intervalMs);
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        refreshNow();
      }
    });

    return () => {
      clearInterval(intervalId);
      subscription.remove();
    };
  }, [intervalMs]);

  return nowMs;
};

export function getTimeAgo(timestamp: any, nowMs?: number): string {
  if (!timestamp) return "";
  let date: Date;
  if (typeof timestamp?.toDate === "function") {
    date = timestamp.toDate();
  } else if (typeof timestamp === "number") {
    date = new Date(timestamp);
  } else if (timestamp instanceof Date) {
    date = timestamp;
  } else if (timestamp?.seconds) {
    date = new Date(timestamp.seconds * 1000);
  } else {
    date = new Date(timestamp);
  }

  if (isNaN(date.getTime())) return "";

  const now = nowMs ? new Date(nowMs) : new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}
