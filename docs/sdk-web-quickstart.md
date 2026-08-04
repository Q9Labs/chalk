# Chalk web SDK quickstart

> Descriptive snapshot, last verified against code on 2026-08-04. Not a source of truth.

Keep the tenant API key on your server. Your server authenticates the application user, obtains an opaque `AccessGrant` for the target Space, and returns that grant unchanged to the browser. The browser passes a `getAccess` callback to Chalk; `SpaceClient` handles access refresh and recovery.

## Install

```sh
pnpm add @q9labsai/chalk-client @q9labsai/chalk-react react react-dom
```

The server entry point requires Node.js 22 or later. Never import `@q9labsai/chalk-client/server` into browser code.

## Expose an access endpoint

Create an application-owned endpoint that authenticates the current user, checks their access to the Space, and asks your server-side Chalk integration for an `AccessGrant`. Return the grant as JSON without inspecting or reshaping it. Keep the tenant API key and any server-side identity records out of browser responses.

The browser sends this small request body whenever Chalk needs access:

```ts
type AccessRequest = {
  readonly space: string;
  readonly reason: "join" | "refresh" | "retry";
};
```

Return the grant with `cache-control: no-store`. Your endpoint owns admission and identity policy; `SpaceClient` only consumes the opaque grant it receives.

## Create the access callback

`GetAccess` is exported by `@q9labsai/chalk-client`. The callback receives the Space slug and the reason for the request. The cast below is safe only because the authenticated endpoint returns a server-minted `AccessGrant` unchanged; do not construct one in browser code.

```ts
// browser/access.ts
import type { AccessGrant, GetAccess } from "@q9labsai/chalk-client";

export const getAccess: GetAccess = async ({ space, reason }) => {
  const response = await fetch("/api/chalk/access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ space, reason }),
  });

  if (!response.ok) throw new Error(`Access request failed with HTTP ${response.status}`);
  return (await response.json()) as AccessGrant;
};
```

## Create a SpaceClient

Use `createSpaceClient` when the application owns the client lifecycle or when a custom UI needs direct access to the snapshot and controllers.

```ts
// browser/space-client.ts
import { createSpaceClient } from "@q9labsai/chalk-client";

import { getAccess } from "./access";

export const spaceClient = createSpaceClient({
  space: "design-review",
  getAccess,
});
```

`SpaceClient` exposes a flat lifecycle and namespaced controllers. `join` accepts the optional `displayName`, `microphone`, and `camera` defaults; media, chat, participant, reaction, and whiteboard commands stay on their matching controllers.

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

Call `leave()` before disposing an application-owned client so Chalk can finish the durable Leave operation. `dispose()` releases the client after the application is done with it.

## Render the turnkey Chalk experience

`<Chalk />` creates and owns a `SpaceClient` when given `space` and `getAccess`. It renders the `Entrance` by default, then the live Space surface and recovery or exit states. Lifecycle callbacks expose join, leave, and Episode events.

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

`ChalkProvider` shares an existing `SpaceClient` with React. It does not join, leave, refresh access, or own the client. The public hooks are a closed set: `useSpaceClient`, `useConnection`, `useSelf`, `useParticipants`, `useMedia`, `useChat`, `useReactions`, `useWhiteboard`, and `useCan`.

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

## Verified scope

This quickstart covers managed web Spaces, camera, microphone, screen sharing, access refresh, recovery, remote media removal, and durable Leave. Recording, transcription, and React Native launch readiness are outside this document's scope.
