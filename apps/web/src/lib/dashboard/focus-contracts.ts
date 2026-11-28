export type FocusDTO = {
  participants: {
    participantId: string;
    displayName: string;
    awayTimeSeconds: number;
    timesAway: number;
    longestAwaySeconds: number;
    reportingCoverageSeconds: number;
    intervals: { state: string; windowed: boolean; startedAt: string; endedAt: string }[];
    stepAways: { reason: string; startedAt: string; endedAt: string | null }[];
  }[];
  allowWindows: { actorParticipantId: string; startedAt: string; endsAt: string; endedAt: string | null }[];
};
