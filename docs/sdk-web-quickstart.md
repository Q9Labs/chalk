# Chalk web SDK quickstart

Keep the tenant API key on your server. Your server authenticates the application user, obtains an opaque `AccessGrant` for the target Space, and returns that grant unchanged to the browser. The browser passes a `getAccess` callback to Chalk; `SpaceClient` handles access refresh and recovery.

## Install

```sh
pnpm add @q9labsai/chalk-client @q9labsai/chalk-react react react-dom
```

The server entry point requires Node.js 22 or later. Never import `@q9labsai/chalk-client/server` into browser code.

## Prepare your Tenant and API key

Sign in to the hosted dashboard and create a Tenant or select one where you have Owner access. Copy its ID from Tenant settings. Create a key on the Developer page, complete the recent-authentication prompt, and save the one-time secret on your backend. Grant `spaces:read`, `spaces:write`, `episodes:read`, and `episodes:write` for the setup below; add artifact and webhook scopes only when needed.

The raw provisioning routes are system-only; use the dashboard for Tenant setup.

For a local frontend, add its exact origin (for example `http://localhost:5173`) in Tenant settings before joining. Keep the key, Tenant ID, and Space/Participant mappings on your backend.

## Create the Space and initial Participant access on your server

The published server entry uses Promises. Run this setup on your backend, not inside the browser access callback:

```ts
import { createChalkServerClient } from "@q9labsai/chalk-client/server";

const chalk = createChalkServerClient({
  apiKey: process.env.CHALK_API_KEY!,
  tenantId: process.env.CHALK_TENANT_ID!,
  apiBaseURL: "https://api.chalkmeet.com",
});

const space = await chalk.spaces.create({
  name: "Design review",
  slug: "design-review",
  mediaPlane: "cf_rtk",
  defaultEpisodeDurationSeconds: 3600,
  maximumEpisodeDurationSeconds: 3600,
  lingerWindowSeconds: 60,
  recordingPolicy: "disabled",
  transcriptionPolicy: "disabled",
});
const episode = await chalk.episodes.create(space.id, {});
const admission = await chalk.participants.admit(space.id, episode.id, {
  name: "Taylor",
  role: "collaborator",
});
if (!admission.access) throw new Error("Participant admission did not return access");
// Return admission.access unchanged to this authenticated application user.
// Retain admission.participant.id and generation on your backend.
```

The media plane must be configured for your Tenant. `cf_rtk` selects Chalk's RealtimeKit adapter; use your deployment's configured media plane when self-hosting. Create a second Participant for a second application user. Reuse the existing Space and live Episode rather than creating them on every HTTP request.

Retain the Space, Episode, and Participant IDs on your backend. After admission and every refresh, store the typed refresh state under that authenticated application user's Participant:

```ts
import { getAccessRefreshState } from "@q9labsai/chalk-client/server";

let refreshState = getAccessRefreshState(admission.access);
const renewed = await chalk.participants.issueAccess(space.id, episode.id, admission.participant.id, refreshState);
refreshState = getAccessRefreshState(renewed);
// Persist refreshState server-side, then return renewed unchanged to the browser.
```

The state contains the current media credential and Participant generation. Keep it in server-side storage, never logs or browser responses. A normal refresh keeps the same Participant and media connection; it does not admit another Participant. `replaceMediaConnection: true` explicitly replaces the media connection and is not routine refresh.

## Expose an access endpoint

Create an application-owned endpoint that authenticates the current user, checks their access to the Space, and asks your server-side Chalk integration for an `AccessGrant`. Return the grant as JSON without inspecting or reshaping it. Keep the tenant API key and any server-side identity records out of browser responses.

Return the grant with `cache-control: no-store`. Your endpoint owns admission and identity policy; `SpaceClient` only consumes the opaque grant it receives.

## Create the access callback

`GetAccess` receives `{ space, reason }`, where reason is `join`, `refresh`, or `retry`. Return the endpoint's `Response` or decoded grant unchanged; Chalk rejects non-OK or malformed responses.

```ts
// browser/access.ts
import type { GetAccess } from "@q9labsai/chalk-client";

export const getAccess: GetAccess = ({ space, reason }) =>
  fetch("/api/chalk/access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ space, reason }),
  });
```

If your endpoint wraps the grant in a larger payload, return the grant field instead of the `Response`.

## Create a SpaceClient

Use `createSpaceClient` for an application-owned client.

```ts
// browser/space-client.ts
import { createSpaceClient } from "@q9labsai/chalk-client";

import { getAccess } from "./access";

export const spaceClient = createSpaceClient({
  space: "design-review",
  getAccess,
});
```

Join defaults are optional; media commands live on `client.media`:

```ts
await spaceClient.join({ displayName: "Taylor", microphone: true, camera: false });
await spaceClient.media.setMicrophoneEnabled(false);
await spaceClient.media.setCameraEnabled(true);
await spaceClient.media.setScreenShareEnabled(true);
await spaceClient.media.setScreenShareEnabled(false);
try {
  await spaceClient.leave();
} finally {
  spaceClient.dispose();
}
```

Run `leave()` before disposing an application-owned client so Chalk can finish the durable Leave operation. `dispose()` releases the client after the application is done with it.

## Render the turnkey Chalk experience

`<Chalk />` owns its client when given `space` and `getAccess`, and shows an entrance before joining:

```tsx
// browser/SpaceRoute.tsx
import { Chalk } from "@q9labsai/chalk-react";

import { getAccess } from "./access";

export function SpaceRoute() {
  return (
    <Chalk
      space="design-review"
      getAccess={getAccess}
      displayName="Taylor"
      defaults={{ microphone: true, camera: false }}
      features={{ chat: true, participants: true, screenShare: true, reactions: true, handRaise: true }}
      spaceName="Design review"
      onJoined={() => console.info("Joined the Space")}
      onLeft={() => console.info("Left the Space")}
      onEpisodeEnded={({ episode }) => console.info("Episode ended", episode?.id)}
    />
  );
}
```

Set `entrance={false}` to enter directly with `displayName` and `defaults`. If the application already owns a client, pass `client={spaceClient}` instead of `space` and `getAccess`; `<Chalk />` uses that client and does not dispose it.

```tsx
<Chalk client={spaceClient} entrance={false} />
```

`<Entrance />` is the public component for a custom entry surface. It covers display-name and device setup as well as admission waiting. `theme` is the only styling door; size and position `<Chalk />` through its parent element.

## Build custom UI with ChalkProvider

`ChalkProvider` shares an existing `SpaceClient` with React. It does not join, leave, refresh access, or own the client.

```tsx
import type { SpaceClient } from "@q9labsai/chalk-client";
import { ChalkProvider, useCan, useConnection, useParticipants, useSpaceClient } from "@q9labsai/chalk-react";

function SpacePanel() {
  const client = useSpaceClient();
  const connection = useConnection();
  const { roster } = useParticipants();
  const canRaiseHand = useCan("raiseHand");

  return (
    <main>
      <p>{connection.status}</p>
      <p>{roster.length} participants</p>
      {canRaiseHand ? <button onClick={() => void client.participants.raiseHand()}>Raise hand</button> : null}
      <button onClick={() => void client.leave()}>Leave</button>
    </main>
  );
}

export function CustomSpace({ client }: { readonly client: SpaceClient }) {
  return (
    <ChalkProvider client={client}>
      <SpacePanel />
    </ChalkProvider>
  );
}
```

Use `useCan(capability)` for capability checks. Feature availability belongs in the single `features` object on `<Chalk />`; roles and capability decisions come from the `SpaceSnapshot`, not component props.

## Artifact and webhook boundaries

Recording is controlled inside the Episode with `client.recording.start()` / `client.recording.stop()`, or by the Space's `recordingPolicy: "automatic"`. There is no REST Recording start/stop operation.

The HTTP API supports requesting an Export or Transcript from an existing Recording and creating a Recording download URL. Capture completion makes the source available; request an Export to produce its downloadable MP4.

Subscribe to `recording.started`, `recording.completed`, `recording.failed`, `transcript.started`, `transcript.completed`, and `transcript.failed`, as well as Space, Episode, and Participant Events. `recording.completed` means the Export MP4 is ready: use the Event's Tenant and Recording IDs with `chalk.recordings.createDownloadURL`. `transcript.completed` means the Transcript document is ready. Events are delivered at least once; verify signatures and deduplicate by Event ID. See the [receiver guide](../sdks/typescript/client/docs/webhooks.md) for endpoint management and retries.
