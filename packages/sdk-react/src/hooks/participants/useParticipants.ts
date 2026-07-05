export function useParticipants(): any {
  return { participants: [], localParticipant: null, remoteParticipants: [], activeSpeaker: null, participantCount: 0, getParticipant: (_id: string) => undefined, updateDisplayName: async (_name: string) => {} };
}
