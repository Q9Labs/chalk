function browserAccess(guest) {
  return async ({ reason, replaceMediaConnection, expectedMediaConnectionId, currentMediaToken }) => {
    const receipt = { at: new Date().toISOString(), reason, replaceMediaConnection };
    window.proofAccessCalls.push(receipt);
    const response = await fetch(`/access/${guest}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, replaceMediaConnection, expectedMediaConnectionId, currentMediaToken }),
    });
    receipt.status = response.status;
    if (!response.ok) throw new Error(`Proof access failed: ${response.status}`);
    const grant = await response.json();
    receipt.media_expires_at = grant.media.expires_at;
    receipt.sync_expires_at = grant.sync.expires_at;
    return grant;
  };
}

function renderRemoteTrack(track) {
  if (document.getElementById(`track-${track.id}`)) return;
  const element = document.createElement(track.kind === "audio" ? "audio" : "video");
  element.id = `track-${track.id}`;
  element.autoplay = true;
  element.playsInline = true;
  element.width = 240;
  element.volume = 0.001;
  element.srcObject = new MediaStream([track]);
  document.body.append(element);
  void element.play().catch(() => {});
}

function renderSnapshot(client) {
  const snapshot = client.getSnapshot();
  const row = { at: new Date().toISOString(), status: snapshot.connection.status, error: snapshot.connection.lastError?.code ?? null, participants: snapshot.participants.roster.length };
  window.proofHistory.push(row);
  document.querySelector("pre").textContent = JSON.stringify(row);
  snapshot.media.remote.forEach(({ track }) => renderRemoteTrack(track));
}

async function waitForBothClients(guest) {
  const response = await fetch(`/ready/${guest}`, { method: "POST" });
  if (!response.ok) throw new Error("Could not mark proof client ready");
  let ready = false;
  do {
    await new Promise((done) => setTimeout(done, 500));
    const statusResponse = await fetch("/status");
    if (!statusResponse.ok) throw new Error("Could not read proof readiness");
    ready = (await statusResponse.json()).ready;
  } while (!ready);
  document.querySelector("button").disabled = false;
  document.querySelector("pre").textContent = "Both clients ready. Join both promptly.";
}

export async function prepareBrowser(createSpaceClient, installFixture, config) {
  const guest = Number(location.pathname.slice(-1));
  const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  for (const track of media.getTracks()) track.stop();
  installFixture({ guest: guest - 1, tones: true });
  window.proofHistory = [];
  window.proofAccessCalls = [];
  const client = createSpaceClient({ space: config.slug, baseUrl: config.api, getAccess: browserAccess(guest) });
  window.proofClient = client;
  client.subscribe(() => renderSnapshot(client));
  window.proofStart = async () => {
    await client.join({ displayName: `Integrator guest ${guest}`, microphone: true, camera: true });
    window.proofJoinedAt = new Date().toISOString();
  };
  document.querySelector("button").onclick = () => {
    document.querySelector("button").disabled = true;
    void window.proofStart().catch(() => {
      document.querySelector("pre").textContent = "Join failed; inspect client history and network requests";
    });
  };
  window.proofReady = waitForBothClients(guest);
  void window.proofReady.catch(() => {
    document.querySelector("pre").textContent = "Client setup failed";
  });
}
