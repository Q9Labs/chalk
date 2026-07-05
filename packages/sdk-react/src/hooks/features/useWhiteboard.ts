export function useWhiteboard() {
  return {
    isOpen: false,
    canDraw: false,
    elements: [],
    cursors: [],
    lastSeq: 0,
    openParticipants: [],
    latestUpdate: null,
    latestSnapshot: null,
    open: () => {},
    close: () => {},
    toggle: () => {},
    sendUpdate: (_elements: unknown[]) => {},
    sendCursor: (_x: number, _y: number) => {},
    requestSync: () => {},
    clear: () => {},
    grantPermission: (_participantId: string) => {},
    revokePermission: (_participantId: string) => {},
    notifyOpen: () => {},
    notifyClose: () => {},
  };
}
