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
