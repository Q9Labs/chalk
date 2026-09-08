# Chalk web SDK quickstart

Keep the tenant API key on your server. Your server authenticates the application user, obtains an opaque `AccessGrant` for the target Space, and returns that grant unchanged to the browser. The browser passes a `getAccess` callback to Chalk; `SpaceClient` handles access refresh and recovery.

## Install

```sh
pnpm add @q9labsai/chalk-client @q9labsai/chalk-react react react-dom
```

The server entry point requires Node.js 22 or later. Never import `@q9labsai/chalk-client/server` into browser code.

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

This guide covers managed web Spaces. It does not establish recording, transcription, or React Native readiness.
