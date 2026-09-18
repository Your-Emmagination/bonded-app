// utils/useActiveLiveStreams.ts
//
// The lives worth showing in the Home feed: open, and with a host who is still
// there.
//
// A stream document can say "live" long after its host has gone — the app was
// swiped away mid-broadcast and never got to end it. Those are dropped here
// once the host's heartbeat goes quiet. A host who stops writing also stops
// changing the document, so no snapshot arrives to say so; a single timer set
// for the moment the next stream would go quiet takes care of that without
// re-rendering the feed on a fixed tick.
import { useEffect, useMemo, useState } from "react";

import {
  HOST_STALE_MS,
  isLiveStreamFresh,
  subscribeToActiveStreams,
  type LiveStream,
} from "./liveStreams";
import { timestampMs } from "./supportTickets";

export function useActiveLiveStreams(): LiveStream[] {
  const [streams, setStreams] = useState<LiveStream[]>([]);
  const [clock, setClock] = useState(() => Date.now());

  // The clock moves with every snapshot, so a stream that arrives already
  // stale is judged against the time it arrived, not the time the feed opened.
  useEffect(
    () =>
      subscribeToActiveStreams((next) => {
        setStreams(next);
        setClock(Date.now());
      }),
    [],
  );

  useEffect(() => {
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const stream of streams) {
      const seen = timestampMs(stream.hostSeenAt);
      if (seen > 0) nextExpiry = Math.min(nextExpiry, seen + HOST_STALE_MS);
    }
    if (!Number.isFinite(nextExpiry)) return;
    // A little past the boundary, so the check on waking is not a tie.
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.max(0, nextExpiry - Date.now()) + 500,
    );
    return () => clearTimeout(timer);
  }, [streams, clock]);

  return useMemo(
    () => streams.filter((stream) => isLiveStreamFresh(stream, clock)),
    [streams, clock],
  );
}
