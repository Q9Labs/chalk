# Chalk web SDK quickstart

This flow keeps the tenant API key on your server and gives each browser a short-lived participant access bundle. It uses the framework-free `ChalkSession` runtime, while the React package subscribes to that same session instead of opening its own network connections.

## Install

```sh
pnpm add @q9labsai/chalk-client @q9labsai/chalk-react react react-dom
```

The server entry point requires Node.js 22 or later. Never import `@q9labsai/chalk-client/server` into browser code.

## Create the server client

```ts
// server/chalk.ts
import { createChalkServerClient } from "@q9labsai/chalk-client/server";

export const chalk = createChalkServerClient({
  apiKey: process.env.CHALK_API_KEY!,
  tenantId: process.env.CHALK_TENANT_ID!,
  apiBaseURL: "https://api.chalk.video",
});
```

`CHALK_API_KEY` is tenant authority, so it belongs in server-side secret storage and must never enter HTML, browser environment variables, JSON responses, logs, or client bundles.

## Admit the application user

Authenticate the user with your application before creating Chalk membership. Store the returned identifiers and initial access bundle in server-side session state; later access requests must resolve this record instead of trusting room or participant IDs sent by the browser.

```ts
// POST /api/meetings/join
const appUser = await requireApplicationUser(request);
const membership = await resolveMeetingMembership(appUser.id);

const admission = await chalk.participants.admit(
  membership.roomId,
  membership.sessionId,
  {
    participant_session_id: membership.participantSessionId,
    name: appUser.displayName,
    initial_role: "participant",
    eligible_roles: ["participant"],
  },
  { idempotencyKey: membership.admissionKey },
);

if (!admission.access) {
  return Response.json({ state: "awaiting_approval" }, { status: 202 });
}

await saveServerSideMembership(appUser.id, {
  roomId: admission.participant.room_id,
  sessionId: admission.participant.session_id,
  participantSessionId: admission.participant.id,
  participantGeneration: admission.participant.generation,
  initialAccess: admission.access,
});

return Response.json({ state: "admitted" });
```

The example returns only application state from the admission endpoint. The participant access bundle is delivered through the dedicated endpoint below, after the same application authentication check.

## Serve participant access

`ChalkSession` calls its access provider for the initial join, scheduled refresh, Sync recovery, and SFU recovery. The endpoint below consumes the initial bundle once, then refreshes the same live participant. Ordinary refresh forwards the current signed media credential so Chalk can retain the provider connection; media recovery requests a replacement connection and does not accept a caller-supplied connection ID.

```ts
// POST /api/chalk/access
type AccessRequest = {
  reason: "join" | "scheduled_refresh" | "sync_recovery" | "media_recovery";
  replaceMediaConnection: boolean;
  currentMediaToken?: string;
  expectedParticipantGeneration?: number;
};

const appUser = await requireApplicationUser(request);
const membership = await requireServerSideMembership(appUser.id);
const input = (await request.json()) as AccessRequest;

if (membership.initialAccess) {
  await clearInitialAccess(appUser.id);
  return Response.json(membership.initialAccess);
}

if (input.expectedParticipantGeneration !== membership.participantGeneration) {
  return Response.json({ error: "membership_changed" }, { status: 409 });
}

const access = input.replaceMediaConnection
  ? await chalk.participants.issueAccess(membership.roomId, membership.sessionId, membership.participantSessionId, {
      participantSessionGeneration: membership.participantGeneration,
      replaceMediaConnection: true,
    })
  : await chalk.participants.issueAccess(membership.roomId, membership.sessionId, membership.participantSessionId, {
      participantSessionGeneration: membership.participantGeneration,
      currentMediaToken: input.currentMediaToken!,
    });

return Response.json(access, {
  headers: { "cache-control": "no-store" },
});
```

Validate the request body with your server framework before calling the SDK. The browser may supply refresh context, but server-side membership remains the source of tenant, room, session, participant, and generation identity.

## Create one browser session

```ts
// browser/chalk-session.ts
import { ChalkSession, requireParticipantAccess, type ChalkSessionAccessRequest } from "@q9labsai/chalk-client";

export const chalkSession = new ChalkSession({
  access: async (input?: ChalkSessionAccessRequest) => {
    const response = await fetch("/api/chalk/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: input?.reason ?? "join",
        replaceMediaConnection: input?.replaceMediaConnection ?? false,
        currentMediaToken: input?.currentMediaToken,
        expectedParticipantGeneration: input?.expectedParticipantGeneration,
      }),
    });

    return requireParticipantAccess(response);
  },
  syncURL: "wss://sync.chalk.video/v3",
  apiBaseURL: "https://api.chalk.video",
});
```

Join and media operations resolve only after the owning Sync or media layer confirms them. Always call `leave()` when the meeting view closes so Chalk can acknowledge durable Leave before local sockets, peer connections, tracks, credentials, and timers are released.

```ts
await chalkSession.join();
await chalkSession.setMicrophoneEnabled(false);
await chalkSession.setCameraEnabled(false);
await chalkSession.startScreenShare();
await chalkSession.stopScreenShare();
await chalkSession.leave();
```

## Bind React to the session

```tsx
import { ChalkProvider, useChalkActions, useChalkSnapshot } from "@q9labsai/chalk-react";
import { chalkSession } from "./chalk-session";

function Meeting() {
  const snapshot = useChalkSnapshot();
  const actions = useChalkActions();

  return (
    <main>
      <p>{snapshot.state}</p>
      <button onClick={() => actions.setMicrophoneEnabled(false)}>Mute</button>
      <button onClick={() => actions.leave()}>Leave</button>
    </main>
  );
}

export function MeetingRoute() {
  return (
    <ChalkProvider session={chalkSession}>
      <Meeting />
    </ChalkProvider>
  );
}
```

The provider and hooks project `ChalkSession`; they do not fetch credentials or create independent Sync, WebRTC, or lifecycle owners.

## Verified scope

The repository's packed consumer fixture installs generated client and React tarballs into a clean directory, bundles only public package imports, and runs the lifecycle in real browser engines. Its localhost signaling service is a protocol-faithful mock used for deterministic recovery and leak checks, so it is not evidence of live Cloudflare network traffic.

This launch contract covers managed web sessions, camera, microphone, screen video, refresh, recovery, remote media removal, and durable Leave. Recording, transcription, and React Native launch readiness are explicitly outside its scope.
