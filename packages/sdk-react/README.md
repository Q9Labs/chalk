# @q9labs/chalk-react

React SDK for Chalk video conferencing.

## Installation

```bash
npm install @q9labs/chalk-react @q9labs/chalk-core
# For whiteboard support:
npm install @excalidraw/excalidraw
```

## Setup

### Next.js (App Router)

```tsx
// app/layout.tsx
import "@q9labs/chalk-react/styles.css";
import { ChalkProvider } from "@q9labs/chalk-react";

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <ChalkProvider apiUrl="https://your-api.example.com" tokenProvider={async () => "your-jwt-token"}>
          {children}
        </ChalkProvider>
      </body>
    </html>
  );
}
```

```js
// next.config.mjs
const nextConfig = {
  transpilePackages: ["@q9labs/chalk-ui", "@q9labs/chalk-react", "@q9labs/chalk-core", "@q9labs/chalk-whiteboard"],
};
export default nextConfig;
```

### Next.js (Pages Router)

```tsx
// pages/_app.tsx
import "@q9labs/chalk-react/styles.css";
import { ChalkProvider } from "@q9labs/chalk-react";

export default function App({ Component, pageProps }) {
  return (
    <ChalkProvider apiUrl="https://your-api.example.com" tokenProvider={async () => "your-jwt-token"}>
      <Component {...pageProps} />
    </ChalkProvider>
  );
}
```

### Vite / Create React App

```tsx
// main.tsx or App.tsx
import "@q9labs/chalk-react/styles.css";
import { ChalkProvider } from "@q9labs/chalk-react";
```

## Whiteboard Setup

The `WhiteboardPanel` component loads Excalidraw CSS from jsDelivr CDN by default - no additional setup required.

To self-host the CSS instead:

```tsx
<WhiteboardPanel excalidrawCssPath="/vendor/excalidraw.css" />
```

Then copy the files:

```bash
mkdir -p public/vendor
cp node_modules/@excalidraw/excalidraw/dist/prod/index.css public/vendor/excalidraw.css
cp -r node_modules/@excalidraw/excalidraw/dist/prod/fonts public/vendor/fonts
```

## Usage

```tsx
import { useConnection, useMedia, useParticipants, VideoConference } from "@q9labs/chalk-react";

function VideoCall() {
  const { joinWithInviteLink, leave, status } = useConnection();
  const { toggleAudio, toggleVideo, isAudioEnabled, isVideoEnabled } = useMedia();
  const { participants } = useParticipants();

  return (
    <div>
      <button onClick={() => joinWithInviteLink("https://chalk.q9labs.ai/j/join-token-123", { userName: "John Doe" })}>
        Join invite
      </button>
      <button onClick={toggleAudio}>{isAudioEnabled ? "Mute" : "Unmute"}</button>
      <button onClick={toggleVideo}>{isVideoEnabled ? "Hide" : "Show"}</button>
      <button onClick={leave}>Leave</button>
    </div>
  );
}

// Or use the turnkey MeetingRoom component
function App() {
  return <VideoConference roomId="5cf88a28-a9a2-4937-b9ea-46caa2515948" userName="John Doe" />;
}
```
