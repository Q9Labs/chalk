import { useEffect, useState } from "react";

import { useConnection } from "../bindings/hooks";

export function useEpisodeDuration(): number {
  const connection = useConnection();
  const episodeStart = connection.episode?.startedAt ? Date.parse(connection.episode.startedAt) : null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (episodeStart === null || Number.isNaN(episodeStart)) return;

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [episodeStart]);

  if (episodeStart === null || Number.isNaN(episodeStart)) return 0;
  return Math.max(0, Math.floor((now - episodeStart) / 1000));
}
