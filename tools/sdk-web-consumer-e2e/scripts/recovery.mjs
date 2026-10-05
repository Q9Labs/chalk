export async function waitForRecovery(page, waitFor) {
  await waitFor(page, (snapshot) => snapshot.state === "reconnecting" || snapshot.state === "live");
  await waitFor(page, (snapshot) => snapshot.state === "live");
}

export async function forceAndWaitForRecovery(page, url, post, waitFor, timeoutMs = 10_000) {
  const target = new URL(url);
  const transportPath = target.pathname === "/test/force-sync" ? "/sync" : "/media";
  const sockets = new Set();
  let received;
  const replacement = new Promise((resolve) => {
    received = resolve;
  });
  const observe = (socket) => {
    const address = new URL(socket.url());
    if (address.host !== target.host || address.pathname !== transportPath) return;
    sockets.add(socket);
    socket.once("framereceived", received);
  };
  let timer;
  // Arm before the forced loss, and observe every matching replacement attempt.
  page.on("websocket", observe);
  try {
    await post(url);
    await Promise.race([
      replacement,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`No replacement ${transportPath} frame within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    await waitForRecovery(page, waitFor);
  } finally {
    clearTimeout(timer);
    page.off("websocket", observe);
    for (const socket of sockets) socket.off("framereceived", received);
  }
}
