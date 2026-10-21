// Run inside the SDK guest's page, where window.proofClient is the joined SpaceClient.

export async function boardOpen() {
  const transport = window.proofClient.whiteboard.transport();
  const board = { sceneId: null, elements: new Map() };
  window.proofBoard = board;
  transport.subscribe((event) => {
    if (event.type !== "snapshot" && event.type !== "update") return;
    board.sceneId = event.sceneId;
    for (const element of event.elements) board.elements.set(element.id, element);
  });
  await transport.startSceneSubscription();
  await transport.setPresentation(true);
}

/** One freehand stroke, shaped as the web board submits it. */
export async function boardDraw() {
  const board = window.proofBoard;
  const points = Array.from({ length: 20 }, (_, step) => [step * 10, Math.sin(step / 3) * 12]);
  const payload = {
    x: 120,
    y: 360,
    width: 190,
    height: 24,
    angle: 0,
    strokeColor: "#1f7ad6",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 7,
    link: null,
    locked: false,
    boundElements: null,
    updated: Date.now(),
    points,
    pressures: [],
    simulatePressure: true,
    lastCommittedPoint: null,
  };
  await window.proofClient.whiteboard.transport().submitUpdate({ sceneId: board.sceneId, syncAll: false, elements: [{ id: "proof-guest-stroke", type: "freedraw", version: 1, versionNonce: 7, index: "a0", isDeleted: false, payload }] });
}

export function boardElements() {
  return [...window.proofBoard.elements.values()].filter((element) => !element.isDeleted).map((element) => ({ id: element.id, type: element.type, note: element.payload.customData?.chalkNote === true, text: typeof element.payload.text === "string" ? element.payload.text : null }));
}

/** Shares the guest's view; answers false when the server does not share views. */
export function boardView(view) {
  return window.proofClient.whiteboard.transport().sendView(view);
}
