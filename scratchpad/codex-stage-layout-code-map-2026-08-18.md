# Chalk Space-stage layout and rendering map

This is a read-only map of the current code. The web stage is owned by `SpaceView`/`ClassicSpaceView`; `ParticipantGrid` owns participant layout; `ParticipantTile` owns one camera/avatar tile. The two skins duplicate most layout and media logic. A live client roster currently supplies local-first order, media tracks, mute state, and hand raise, but it does not supply speaking, connection quality, or avatar data to the selector, so those optional tile fields are not populated by the normal Space path.

## 1. Component tree

### Web routes and app entry

- `/space/` is the public route component in `apps/web/src/routes/space.index.tsx:1-5`. It renders `SpacePage`.
- `/space/$slug` is the named/dashboard route in `apps/web/src/routes/space.$slug.tsx:1-13`. It consumes the dashboard entry and renders `DashboardSpacePage({ slug })`.
- The dashboard Space detail route `/\_app/spaces_/$spaceId` renders `SpaceDetailPage` (`apps/web/src/routes/_app.spaces_.$spaceId.tsx:5-10`); its “Join Space” link uses `/space/${slug}?entry=dashboard` (`apps/web/src/components/dashboard/SpaceDetailPage.tsx:95-99`; `apps/web/src/components/dashboard/space-links.ts:3-10`), so the participant stage still enters through the named Space route above.
- `SpacePage` and `DashboardSpacePage` both delegate to `JoinSpacePage` in `apps/web/src/components/space/SpacePage.tsx:21-30`.
- After the access/join flow, `JoinSpacePage` renders `LocalSpace` at `apps/web/src/components/space/SpacePage.tsx:90-94`.
- `LocalSpace` creates the local `SpaceClient`, then renders the public SDK wrapper `<Chalk>` with the client, defaults, name, invite link, and lifecycle callbacks at `apps/web/src/components/space/SpacePage.tsx:97-165`.
- The web page gives the SDK a full viewport: `main.h-dvh.min-h-0.w-full.overflow-hidden` at `apps/web/src/components/space/SpacePage.tsx:149-163`.

### Chalk SDK wrapper and Space surface

- `Chalk` is public from `sdks/typescript/react/src/index.ts:4-9` and `sdks/typescript/react/src/components/index.ts:1-7`.
- `Chalk` resolves the skin, palette, texture, controlled/uncontrolled layout, and settings state, then renders `SpaceView` at `sdks/typescript/react/src/components/chalk/Chalk.tsx:249-334`.
- `SpaceView` is the skin dispatcher. It defaults `skin` to `classic`, forces settings open into the settings panel, and chooses `ClassicSpaceView` or `ChalkSpaceView` at `sdks/typescript/react/src/components/space-view/SpaceView.tsx:92-98`.
- `SpaceView` itself is not exported by the product package entrypoints. It is imported internally and by the dev-only `PreviewSpaceView` adapter at `sdks/typescript/react/src/test-support/preview-fixtures.tsx:66-75`.
- The `SpaceView` props contract is declared in `sdks/typescript/react/src/components/space-view/SpaceView.tsx:34-88`. It includes `spaceName`, `skin`, `palette`, `texture`, `layout`, `onLayoutChange`, `initialPanel`, feature flags, dialogs, whiteboard, reconnecting, overlay, leave/end callbacks, and `className`.

### Chalk-skin branch

- `ChalkSpaceView` reads provider state (`useSelf`, `useParticipants`, `useMedia`, capabilities) and derives tiles plus active screen share at `sdks/typescript/react/src/components/space-view/SpaceView.tsx:100-145`.
- It owns the page shell, header, stage shell, side panel, control bar, and overlays at `sdks/typescript/react/src/components/space-view/SpaceView.tsx:193-247`.
- The stage is the accessible `<section aria-label="Space stage">` at `SpaceView.tsx:225-232`. Its `ChalkPanel` contains one of:
  - `WhiteboardView` when `whiteboard?.isOpen`.
  - `ScreenShareView` when a participant has `isScreenSharing && screenShareTrack`.
  - `ParticipantGrid` otherwise (`SpaceView.tsx:226-230`).
- `ParticipantGrid` dispatches to `ChalkParticipantGrid` when the skin is not classic at `sdks/typescript/react/src/components/participant-grid/ParticipantGrid.tsx:46-61`.
- `ChalkParticipantGrid` converts the provider roster and media slices with `toVideoParticipants`, then passes the private participant list to `ParticipantGridSurface` (`ParticipantGrid.tsx:51-61`).
- `ParticipantGridSurface` computes ordering, visibility, overflow, mobile pages, focus/presentation selection, and CSS classes (`ParticipantGrid.tsx:64-415`).
- Every grid branch renders the public wrapper `ParticipantTile`, imported from `../atomic` (`ParticipantGrid.tsx:5`), with a stable `key={p.id}` in list branches (`ParticipantGrid.tsx:219-227`, `395-407`).
- `ParticipantTile` dispatches to `ChalkParticipantTile` or `ClassicParticipantTile` by `useSkin` at `sdks/typescript/react/src/components/participant-tile/ParticipantTile.tsx:256-261`.
- `ChalkParticipantTile` owns the `<video>`, track attachment effect, avatar fallback, status badges, name chip, speaking/pinned treatment, and accessibility semantics (`ParticipantTile.tsx:51-250`).

### Classic-skin branch

- `SpaceView` chooses `ClassicSpaceView` at `SpaceView.tsx:92-98`; the classic renderer repeats the page/stage composition in `sdks/typescript/react/src/components/space-view/ClassicSpaceView.tsx:34-170`.
- The classic stage is a rounded section at `ClassicSpaceView.tsx:157-160`. It chooses whiteboard, screen-share, or `ParticipantGrid` in the same order as the chalk branch.
- `ClassicParticipantGrid` independently repeats provider-to-selector mapping and the entire surface algorithm at `sdks/typescript/react/src/components/participant-grid/ClassicParticipantGrid.tsx:14-364`.
- The classic grid calls the same `ParticipantTile` wrapper. Because the provider skin is `classic`, the wrapper selects `ClassicParticipantTile` (`ParticipantTile.tsx:256-261`).
- `ClassicParticipantTile` repeats track attachment and tile state logic, but uses clean classic surfaces and no `ChalkChrome`, at `sdks/typescript/react/src/components/participant-tile/ClassicParticipantTile.tsx:21-213`.
- `ClassicScreenShareView` is the parallel screen-share surface selected by `ScreenShareView` when the skin is classic (`ScreenShareView.tsx:356-359`; implementation `ClassicScreenShareView.tsx:357-385`).

## 2. Layout algorithms

### Shared participant preprocessing

The chalk and classic grids have the same algorithm and differ mainly in empty-state/panel/chrome classes.

- `variant` defaults from `useIsMobile()`. The breakpoint is `(max-width: 767px)` in `sdks/typescript/react/src/internal/useMediaQuery.ts:22-24`; there is no element measurement in the grid.
- A requested pin is moved to index zero, but the remaining order is unchanged. This is the complete ordering code (`ParticipantGrid.tsx:73-84`, duplicated at `ClassicParticipantGrid.tsx:36-47`):

```tsx
const sorted = [...participants];
if (pinnedParticipantId) {
  const pinnedIndex = sorted.findIndex((p) => p.id === pinnedParticipantId);
  if (pinnedIndex !== -1 && sorted[pinnedIndex]) {
    const pinned = sorted[pinnedIndex]!;
    sorted.splice(pinnedIndex, 1);
    sorted.unshift(pinned);
  }
}
return sorted;
```

- Desktop visibility is `maxVisibleParticipants`, default `25`. Mobile visibility is capped at six: `Math.min(maxVisibleParticipants, 6)` (`ParticipantGrid.tsx:86-89`).
- `overflowCount` is the original participant count minus the visible slice (`ParticipantGrid.tsx:87-89`). It becomes a `+N more` tile/label rather than a second page on desktop.
- Empty participants render the “The Space is quiet” state (`ParticipantGrid.tsx:187-197`; classic equivalent `ClassicParticipantGrid.tsx:150-162`).

### Desktop default grid

The default grid uses CSS Grid only. There is no `ResizeObserver`, measured tile width, or JS aspect-ratio calculation.

The column/row table is exactly the following (`ParticipantGrid.tsx:93-109`; identical classic code `ClassicParticipantGrid.tsx:56-72`):

```tsx
if (count <= 1) return { cols: "grid-cols-1", rows: "grid-rows-1" };
if (count === 2) return { cols: "grid-cols-2", rows: "grid-rows-1" };
if (count === 3) return { cols: "grid-cols-3", rows: "grid-rows-1" };
if (count === 4) return { cols: "grid-cols-2", rows: "grid-rows-2" };
if (count === 5) return { cols: "grid-cols-6", rows: "grid-rows-2" };
if (count === 6) return { cols: "grid-cols-3", rows: "grid-rows-2" };
if (count === 7) return { cols: "grid-cols-12", rows: "grid-rows-3" };
if (count === 8) return { cols: "grid-cols-12", rows: "grid-rows-3" };
if (count === 9) return { cols: "grid-cols-3", rows: "grid-rows-3" };
if (count === 10) return { cols: "grid-cols-12", rows: "grid-rows-3" };
if (count === 11) return { cols: "grid-cols-12", rows: "grid-rows-3" };
if (count === 12) return { cols: "grid-cols-4", rows: "grid-rows-3" };
if (count <= 16) return { cols: "grid-cols-4", rows: "grid-rows-4" };
if (count <= 20) return { cols: "grid-cols-5", rows: "grid-rows-4" };
return { cols: "grid-cols-5", rows: "grid-rows-5" };
```

- `totalGridItems` includes the overflow card when `overflowCount > 0` (`ParticipantGrid.tsx:379-382`).
- The grid container is `grid gap-2 w-full h-full place-items-center` (`ParticipantGrid.tsx:393-395`).
- Five, seven, eight, ten, and eleven item counts use explicit column spans to balance the last row (`ParticipantGrid.tsx:111-118`):

```tsx
if (count === 5) return index < 3 ? "col-span-2" : "col-span-3";
if (count === 7) return index < 3 ? "col-span-4" : "col-span-6";
if (count === 8) return index < 6 ? "col-span-4" : "col-span-6";
if (count === 10) return index < 4 ? "col-span-3" : "col-span-4";
if (count === 11) return index < 8 ? "col-span-3" : "col-span-4";
return "col-span-1";
```

- Desktop single participant bypasses the grid and fills the stage with `aspectRatio="fill"` (`ParticipantGrid.tsx:383-391`). The same is true in classic (`ClassicParticipantGrid.tsx:329-337`).
- Otherwise each visible tile uses `aspectRatio="fill"`, `w-full h-full max-h-full`, the calculated span, and a staggered animation delay capped at 480 ms (`ParticipantGrid.tsx:393-407`).
- The overflow card is an extra grid item using the span for `visibleParticipants.length` (`ParticipantGrid.tsx:408-411`).

### Desktop focus layout

- `getPrimaryParticipant` prefers the first non-local speaking participant, then the first non-local participant, then the first candidate (`ParticipantGrid.tsx:91`; classic `ClassicParticipantGrid.tsx:54`).
- The main tile is in a `flex-1 min-h-0 relative` frame (`ParticipantGrid.tsx:307-317`).
- Other visible participants are a horizontal flex filmstrip with `h-[clamp(120px,20vh,168px)]`, `gap-3`, and `overflow-x-auto` (`ParticipantGrid.tsx:319-331`). Each filmstrip item is `h-full aspect-video flex-shrink-0`.
- An overflow card is appended to the filmstrip when needed (`ParticipantGrid.tsx:326-330`).
- Pinning only reorders the candidates before `getPrimaryParticipant`; it does not make the pinned participant unconditionally primary. A different speaking remote participant still wins.

### Desktop presentation layout

- The first participant with `isScreenSharing` is preferred; otherwise the same primary-participant helper is used (`ParticipantGrid.tsx:337-342`).
- The main content is a `min-w-0 flex-1` panel, and the participant filmstrip is a fixed `w-64` vertical column with `overflow-y-auto` (`ParticipantGrid.tsx:343-374`).
- The main tile receives `screenShareTrack || videoTrack` and `aspectRatio="16:9"` (`ParticipantGrid.tsx:347-356`). `screenShareContent` replaces this tile when supplied (`ParticipantGrid.tsx:347-357`).
- Other tiles are `w-full aspect-video flex-shrink-0` (`ParticipantGrid.tsx:361-366`), followed by an optional overflow card (`ParticipantGrid.tsx:368-372`).

### Mobile layout

Mobile is selected automatically below 768 CSS pixels unless `variant` is explicit. Mobile branches ignore the desktop `layout` mode and choose by visible count (`ParticipantGrid.tsx:199-301`; identical classic branch `ClassicParticipantGrid.tsx:164-287`).

- One participant: full-bleed `h-full w-full`, tile `aspectRatio="fill"` (`ParticipantGrid.tsx:205-212`).
- Two participants: a vertical flex stack, `flex-col h-full w-full gap-1`; each wrapper is `flex-1 min-h-0` (`ParticipantGrid.tsx:215-225`).
- Three or four participants: a `grid-cols-2 grid-rows-2` grid with one-pixel-ish Tailwind `gap-1`; three participants leave one empty grid cell (`ParticipantGrid.tsx:228-236`).
- Five or more visible participants: pages of four, each page a 2x2 grid (`ParticipantGrid.tsx:239-265`). The carousel is horizontal scroll/snap with `overflow-x-auto`, `snap-x snap-mandatory`, and a flex track whose width is `pages.length * 100%` (`ParticipantGrid.tsx:245-267`).
- The last page is filled with `ChalkPanel` empty slots in chalk (`ParticipantGrid.tsx:263-265`) or plain tile-base divs in classic (`ClassicParticipantGrid.tsx:228-230`).
- Page dots use `carouselRef.current.offsetWidth` and `scrollTo` for navigation (`ParticipantGrid.tsx:161-185`, `270-290`). Touch movement directly changes `scrollLeft`; release rounds `scrollLeft / offsetWidth` to a page (`ParticipantGrid.tsx:147-175`).
- With the six-participant mobile cap, there are at most two pages. `+N more` is rendered below the carousel if the original count exceeded the cap (`ParticipantGrid.tsx:293-298`).

### Aspect ratio and tile sizing

- `ParticipantTile` supports `16:9`, `4:3`, `1:1`, and `fill`; only `fill` removes the aspect class (`ParticipantTile.tsx:44-49`).
- Grid and focus tiles use `fill`; focus filmstrip wrappers supply `aspect-video`; presentation’s primary tile asks for `16:9` (`ParticipantGrid.tsx:271`, `322-324`, `349-356`).
- The video element always fills its tile and uses `object-cover` (`ParticipantTile.tsx:182-183`).

### Screen-share stage mode

- `SpaceView` computes `tiles` and then `hasActiveScreenShare` as any tile with both `isScreenSharing` and `screenShareTrack` (`SpaceView.tsx:142-145`). When true, it changes the effective layout to presentation and renders `ScreenShareView` instead of `ParticipantGrid` (`SpaceView.tsx:226-230`).
- `ScreenShareView` selects the first matching active participant from its own selector-derived list (`ScreenShareView.tsx:361-381`). Classic does the same (`ClassicScreenShareView.tsx:357-381`).
- The main share surface attaches the share track to one video. It uses `ResizeObserver` to measure the container (`ScreenShareView.tsx:101-118`), computes a contained size from container/video ratios (`ScreenShareView.tsx:31-53`), and applies that size plus rotation, zoom, and pan through `stageStyle` (`ScreenShareView.tsx:158-168`).
- The share video uses the measured contained size, not `object-cover`; the actual element has `h-full w-full` within the sized stage wrapper (`ScreenShareView.tsx:250-260`).
- Zoom is clamped from 1x to 4x in 0.5x steps (`ScreenShareView.tsx:27-29`, `138-156`). Panning is only enabled above 1x and is clamped to half the zoomed excess size (`ScreenShareView.tsx:181-215`).
- Thumbnails default on. The bottom strip is `h-36 w-full`; the right strip is `w-56 h-full`; each thumbnail keeps `aspect-video` and scrolls in its orientation (`ScreenShareView.tsx:320-350`).
- A local screen-share track still enters the same web share surface. There is no web-side “hide my own preview” branch in `ScreenShareView`; the native implementation has one (see section 8).

## 3. Data flow into the stage

### Provider slices and selector

- `ParticipantGrid` reads `useSelf`, `useParticipants`, and `useMedia` (`ParticipantGrid.tsx:1-10`, `51-59`). `SpaceView` and both screen-share wrappers read the same slices (`SpaceView.tsx:125-145`; `ScreenShareView.tsx:361-368`).
- The client’s actual participant type contains only `participantId`, `displayName`, role/capabilities, `handRaised`, and media state (`sdks/typescript/client/src/space-client/types.ts:106-114`). The media slice exposes local records and remote publications (`types.ts:130-149`).
- `toVideoParticipants` groups remote camera/screen publications by participant and always creates a local entry first (`sdks/typescript/react/src/selectors/space-selectors.ts:12-33`). It then appends non-local roster entries in roster order (`space-selectors.ts:34-48`).
- Local mapping:
  - `id` is `localId`.
  - Display name uses the synced local roster name, then the supplied fallback (`space-selectors.ts:23-25`).
  - `isLocal: true` (`space-selectors.ts:25`).
  - `isMuted` is true unless the local microphone state is `enabled` (`space-selectors.ts:26`).
  - `isVideoEnabled` is true when local camera or screen state is enabled (`space-selectors.ts:27`).
  - `isScreenSharing` is true for local screen `enabled` or `requesting` (`space-selectors.ts:28`).
  - `videoTrack` is the local camera track and `screenShareTrack` is the local screen track (`space-selectors.ts:30-31`).
  - Local hand raise comes from the synced roster (`space-selectors.ts:29`).
- Remote mapping:
  - `id`/`displayName` come from the roster (`space-selectors.ts:37-40`).
  - `isMuted` is true when no remote microphone publication exists (`space-selectors.ts:40`).
  - `isVideoEnabled` is true if camera or screen media exists; `isScreenSharing` is true if screen media exists (`space-selectors.ts:41-42`).
  - `videoTrack` is camera and `screenShareTrack` is screen (`space-selectors.ts:44-45`).
  - `isHandRaised` comes from the roster (`space-selectors.ts:43`).
- The selector does not set `isSpeaking`, `connectionQuality`, or `avatarUrl`. It also does not set `screenShareAudioTrack` on tile participants. Those fields exist on the UI `Participant`/tile types (`ParticipantGrid.tsx:12-26`, `ParticipantTile.tsx:12-38`) but are absent from the normal provider mapping.
- `ChalkParticipantGrid` has an extra local-presence gate: it returns no participants unless there is a self id/name or at least one enabled local track (`ParticipantGrid.tsx:56-59`). Classic repeats it (`ClassicParticipantGrid.tsx:19-22`).

### Ordering and primary selection

- Baseline ordering is local first, then the provider roster order. There is no join-time sort, alphabetical sort, or speaking sort in `toVideoParticipants` (`space-selectors.ts:20-48`).
- `pinnedParticipantId` only moves the matching item to index zero in the grid surface (`ParticipantGrid.tsx:73-84`).
- Focus chooses a non-local `isSpeaking` participant first, then a non-local participant, then the first item (`ParticipantGrid.tsx:91`). Because the normal selector never populates `isSpeaking`, the live web path falls back to the first remote participant.
- Presentation chooses the first visible `isScreenSharing` participant before the focus helper (`ParticipantGrid.tsx:338-342`). Screen-share wrappers independently use the first participant with a real share track (`ScreenShareView.tsx:368`).

### Props passed to a tile

`mapToVideoTileParticipant` forwards `id`, `displayName`, `isLocal`, `isSpeaking`, `isMuted`, `isVideoEnabled`, `isScreenSharing`, `isHandRaised`, `connectionQuality`, and `avatarUrl` (`ParticipantGrid.tsx:123-142`; classic `ClassicParticipantGrid.tsx:86-105`). The grid then passes:

- `videoTrack={p.videoTrack}` in normal, mobile, and focus tiles (`ParticipantGrid.tsx:210-226`, `271`, `321-324`).
- The presentation primary uses `p.screenShareTrack || p.videoTrack` (`ParticipantGrid.tsx:349-352`).
- `onClick` and `onDoubleClick` call the corresponding callbacks with the participant id (`ParticipantGrid.tsx:271`, `315`, `400-401`).
- `pinned` is only passed in the default desktop grid (`ParticipantGrid.tsx:402`).
- `aspectRatio`, `className`, and the default tile name/status settings vary by branch. No grid branch passes `mirror`.
- `screenShareAudioTrack` is part of the exported `Participant` shape but is not consumed by `ParticipantTile` or the grid (`ParticipantGrid.tsx:23-25`).

## 4. Rendering logic per tile

### Track attachment and lifecycle

- Both skin-specific tiles keep one `videoRef`, `trackError`, `isLoaded`, a current-track state setter, and a force-update state (`ParticipantTile.tsx:51-57`; classic `ClassicParticipantTile.tsx:21-27`).
- `attachTrack` creates a new `MediaStream([track])`, assigns it to `videoEl.srcObject`, and calls `videoEl.play()` (`ParticipantTile.tsx:59-74`; classic `ClassicParticipantTile.tsx:29-44`).
- On every `videoTrack` or `participant.isVideoEnabled` change, the effect clears error/loading state and checks `participant.isVideoEnabled && videoTrack` (`ParticipantTile.tsx:76-89`).
- A track is usable only when non-null, `readyState === "live"`, and `enabled` (`ParticipantTile.tsx:40-42`). Unusable tracks clear `srcObject` and the current-track state (`ParticipantTile.tsx:91-95`).
- A usable track is attached and gets `ended`, `mute`, and `unmute` listeners (`ParticipantTile.tsx:97-121`). Cleanup removes listeners (`ParticipantTile.tsx:123-128`). The classic implementation is identical (`ClassicParticipantTile.tsx:46-98`).
- `ended` sets `trackError="Track ended"` and hides the video; `mute` forces a render; `unmute` reattaches if the track is usable (`ParticipantTile.tsx:102-117`).
- `onLoadedData` sets `isLoaded` and reports the first rendered frame to `observeFirstRenderedFrame` (`ParticipantTile.tsx:130-133`).
- `showVideo` requires enabled video, a usable track, no track error, and a loaded frame (`ParticipantTile.tsx:135-136`). The `<video>` remains mounted even when hidden (`ParticipantTile.tsx:182-183`).

### Video, avatar, and fit

- The video is `autoPlay`, `playsInline`, and `muted`; it fills the tile with `object-cover` (`ParticipantTile.tsx:182-183`).
- `mirror` adds `scale-x-[-1]` in both skins (`ParticipantTile.tsx:183`; `ClassicParticipantTile.tsx:152-153`), but no current grid/Space caller passes `mirror` (the only `mirror` references are the tile prop and its implementation).
- When video is off, loading, ended, or errored, the video opacity is zero and the avatar wash is shown if `showAvatar` is true (`ParticipantTile.tsx:183-189`). The avatar uses `participant.displayName`, `avatarUrl`, and generated color behavior (`ParticipantTile.tsx:187-189`).
- The tile’s lower-left chip can show a small avatar, name, local “(You)” suffix, muted microphone icon, raised-hand icon, and screen-share icon (`ParticipantTile.tsx:201-240`). The same semantic content is rendered with classic elements (`ClassicParticipantTile.tsx:171-208`).
- Poor connection is shown when `connectionQuality <= 2` (`ParticipantTile.tsx:140`, `194-199`; classic `ClassicParticipantTile.tsx:108`, `164-169`). The normal selector does not populate this field.
- Speaking adds a chalk pulse animation or a reduced-motion border; pinning adds a ring (`ParticipantTile.tsx:156-171`). The classic tile keeps the speaking/pin classes but omits the chalk chrome overlay (`ClassicParticipantTile.tsx:125-150`).
- A tile with an `onClick` is a keyboard-accessible `button` role; otherwise it is a `region`. Both use `aria-label="Video tile for …"` (`ParticipantTile.tsx:174-180`).
- `key={p.id}` is stable across grid/filmstrip/carousel lists. Carousel pages themselves use `pageIndex` as the page key (`ParticipantGrid.tsx:258-261`).

### Screen-share video

- Screen-share attachment is separate from participant tiles. `ScreenShareViewSurface` creates one `MediaStream([screenShareTrack])`, assigns it to a dedicated video ref, and clears `srcObject` in effect cleanup (`ScreenShareView.tsx:76-99`).
- It calls `video.play().catch` but intentionally discards play failures and media-stream creation failures (`ScreenShareView.tsx:86-94`).
- The share video uses `onLoadedData` and `onLoadedMetadata` to clear loading and capture intrinsic dimensions (`ScreenShareView.tsx:120-129`, `250-259`).
- Share thumbnails are ordinary `ParticipantTile` instances with each participant’s camera track, not the screen track (`ScreenShareView.tsx:327-346`).

## 5. Responsiveness and surrounding panels

- `SpaceView`’s stage row is `flex-1 min-h-0`, with horizontal padding `px-3`, `sm:px-5`, and `lg:px-8` (`SpaceView.tsx:225`). The stage section is `min-h-0 min-w-0 overflow-hidden` (`SpaceView.tsx:226`).
- With no panel, the stage occupies the available row width. At desktop panel widths, an active panel changes the row to `lg:grid lg:grid-cols-[minmax(0,1fr)_340px]` (`SpaceView.tsx:225`). The panel is a fixed-width `340px` column (`SpaceView.tsx:234-245`).
- Below the desktop breakpoint, an active panel is an absolute overlay: `inset-x-3 top-20 bottom-24 z-40` (`SpaceView.tsx:234-236`). It covers the stage while preserving space above the bottom dock.
- Classic uses the same breakpoint/grid/overlay dimensions (`ClassicSpaceView.tsx:157-170`).
- The control bar has separate desktop and mobile renderings: desktop is `hidden md:block`, mobile is `md:hidden`; mobile uses compact density (`SpaceView.tsx:249-280`; classic `ClassicSpaceView.tsx:173-214`).
- Because the grid chooses mobile at `max-width:767px` but the shell uses Tailwind `md`/`lg` breakpoints, the mobile participant algorithm and panel/control breakpoints are related but implemented independently.
- No `ResizeObserver` is used by `ParticipantGrid`. Container measurement is only in `ScreenShareView`, where it drives contained screen-share sizing (`ScreenShareView.tsx:101-118`).
- Fullscreen is not a SpaceView/ParticipantGrid prop or mode. The web app supplies viewport height with `h-dvh` (`SpacePage.tsx:149-163`); the SDK surfaces fill their parent with `h-full`. There is no fullscreen API call or fullscreen-specific tile algorithm in these files.
- Whiteboard replaces the stage before screen share and grid in both web renderers (`SpaceView.tsx:226-230`; `ClassicSpaceView.tsx:157-160`).

## 6. Tests and what they assert

### Participant grid tests

`sdks/typescript/react/src/components/participant-grid/participant-grid.test.tsx` asserts:

- Chalk empty state for explicit `desktop` and `mobile` variants, including the “The Space is quiet” text and chalk SVG chrome (`participant-grid.test.tsx:14-24`).
- Classic empty state keeps the structural classes but has no chalk SVG chrome (`participant-grid.test.tsx:26-38`).
- A provider roster/self snapshot becomes a rendered tile named “Hasan”, and the chalk tile includes chalk chrome (`participant-grid.test.tsx:40-54`).
- A single desktop participant is full-bleed rather than `aspect-video` (`participant-grid.test.tsx:56-70`).
- Five mobile participants produce two page buttons, a carousel with `min-w-0 overscroll-x-contain`, two page elements, and shrinkable pages (`participant-grid.test.tsx:72-99`).

`sdks/typescript/react/src/components/participant-grid/ClassicParticipantGrid.test.tsx:1-8` only asserts that `ClassicParticipantGrid` is exported. It does not test its layout branches.

There are no grid tests for the desktop row/column table, 3/4/5/7/8/10/11-item spans, focus selection, presentation filmstrip, pinning, max-visible overflow, screenShareContent, panel resizing, or carousel state after direct scrolling.

### Participant tile tests

- `participant-tile.test.tsx:11-22` renders `ParticipantTile` under the classic skin and asserts the region has classic rounded/border classes and no chalk chrome.
- `ClassicParticipantTile.test.tsx:1-8` only asserts that the classic renderer is exported.
- There are no tile tests for track attachment/detachment, `MediaStream`, `play()` failures, ended/mute/unmute events, loaded-frame gating, mirroring, avatar fallback, object-fit, poor connection, hand raise, screen-share badge, or stable keys.

### Space and screen-share tests

- `SpaceView.test.tsx:56-63` checks that `SpaceView` passes layout to `ParticipantGrid` without a participants state envelope; it also checks the component does not pass unrelated state/control envelopes.
- `SpaceView.test.tsx:122-141` checks classic stage/panel shell classes and chalk chrome differences.
- `SpaceView.test.tsx:143-161` checks that the provider-backed participants panel opens and admission requests surface.
- `SpaceView.test.tsx:164-175` checks that a live local screen track causes `ScreenShareView` to render with `className="h-full"`.
- `ClassicSpaceView.test.tsx:1-8` only asserts the renderer export.
- `ScreenShareView.test.tsx:13-39` checks chalk and classic empty states when no share is active, including the presence/absence of chalk chrome. The classic screen-share test only checks export (`ClassicScreenShareView.test.tsx:1-8`).

## 7. Known bugs, TODOs, and implementation hacks visible in code

- `ParticipantGrid.tsx` and `ClassicParticipantGrid.tsx` duplicate the complete 366-line surface algorithm. `ParticipantTile.tsx` and `ClassicParticipantTile.tsx` duplicate track/media state logic. `ScreenShareView.tsx` and `ClassicScreenShareView.tsx` duplicate the screen-share surface. This is the main skin divergence/maintenance seam.
- `showScreenShareIndicator` is accepted in `ParticipantGridProps` but renamed `_showScreenShareIndicator` and never read (`ParticipantGrid.tsx:37`, `64-65`; classic `28`). The prop currently has no rendering effect.
- `screenShareContent` is only consumed by the standalone `ParticipantGrid` presentation branch (`ParticipantGrid.tsx:38-39`, `347-357`). `SpaceView` routes an active share to `ScreenShareView` before `ParticipantGrid`, so an app-owned `screenShareContent` cannot override the normal `SpaceView` share surface.
- The exported UI `Participant` type includes `isSpeaking`, `connectionQuality`, and `avatarUrl` (`ParticipantGrid.tsx:12-26`), but the actual provider `Participant` type has no such fields (`sdks/typescript/client/src/space-client/types.ts:106-114`) and `toVideoParticipants` never sets them (`space-selectors.ts:12-48`). As a result, normal web focus mode cannot select a real active speaker, and normal tiles cannot show live connection quality or server-provided avatars.
- The same selector omission means SDK preview fixture fields such as `isSpeaking` and `connectionQuality` are reduced to roster/media state when the gallery builds a `SpaceSnapshot` (`apps/web/src/components/sdk-preview/sdk-preview-fixtures.ts:16-55`, `SdkPreviewGallery.tsx:237-251`).
- `getGridLayout` falls back to a fixed `5x5` explicit grid for every count above 20 (`ParticipantGrid.tsx:106-109`). With the default cap, 25 visible participants plus an overflow card produce 26 items while the explicit grid has only 25 cells (`ParticipantGrid.tsx:379-411`), so the last item can create an implicit CSS row.
- Mobile caps visibility at six but pages in groups of four (`ParticipantGrid.tsx:86-89`, `239-243`). The overflow count is calculated against the original list, while only the first six can be reached in the carousel.
- Carousel `carouselIndex` updates on touch-end and dot clicks, not on a generic `scroll` event (`ParticipantGrid.tsx:147-185`). A user who scrolls/drag-scrolls without the touch handlers completing can see a dot state that does not match the scroll position. The index is not clamped when the participant count shrinks.
- Focus/presentation pinning is incomplete: pinning reorders input, but `getPrimaryParticipant` still prioritizes any non-local speaking participant, and presentation prioritizes any screen sharer (`ParticipantGrid.tsx:73-84`, `91`, `338-342`).
- `mapToVideoTileParticipant` casts `connectionQuality` from `0|1|2|3|4` to `1|2|3|4` (`ParticipantGrid.tsx:139`; classic `ClassicParticipantGrid.tsx:102`). The tile style also uses an `as React.CSSProperties` assertion (`ParticipantTile.tsx:164-173`; classic `ClassicParticipantTile.tsx:134-143`). Screen-share thumbnail mapping repeats the connection-quality cast (`ScreenShareView.tsx:339`; classic `ClassicScreenShareView.tsx:341`).
- `ParticipantTile` stores `currentTrackId` but never reads it (`ParticipantTile.tsx:56`, `98`; classic `ClassicParticipantTile.tsx:26`, `68`). It is currently only a state setter, apparently used to force state bookkeeping rather than to control rendering.
- Track effect cleanup removes event listeners but does not explicitly clear the old `srcObject` when a valid track is replaced or the component unmounts (`ParticipantTile.tsx:123-128`). The next effect may replace it, but there is no dedicated detach cleanup like the screen-share surface has (`ScreenShareView.tsx:96-99`).
- `attachTrack` handles `AbortError` and “interrupted” play errors specially, but other play errors only become a local `trackError` string (`ParticipantTile.tsx:63-70`). The error is not surfaced as a user-facing status; the avatar simply remains visible.
- Screen-share media creation/play failures are swallowed with empty `catch` blocks (`ScreenShareView.tsx:86-94`; classic same pattern at `ClassicScreenShareView.tsx:78-86`).
- The web tile has a `mirror` prop, but neither grid nor Space path supplies it (`ParticipantTile.tsx:26`, `182-183`). Local camera preview is therefore not mirrored by this stage code.
- The grid’s `Participant` shape contains `screenShareAudioTrack`, but the stage never routes audio tracks through the tile (`ParticipantGrid.tsx:23-25`). Screen-share audio is handled elsewhere by audio output code, not by the tile.
- `ClassicParticipantGrid` retains chalk-named animation classes such as `chalk-animate-tile-pop` in the classic branch (`ClassicParticipantGrid.tsx:340-351`), even though its structural surfaces remove chalk chrome.
- No `TODO` or `FIXME` comments appear in the inspected grid/tile/SpaceView files. The comments that describe “existing code”, “mobile 5+ participants”, and “overflow indicator” are implementation notes rather than tracked work items (`ParticipantGrid.tsx:68`, `120`, `199-204`, `253`, `303-304`).

## 8. Mobile React Native counterpart

### Layout resolver

- `NATIVE_COMPACT_VIEWPORT_MAX_WIDTH` is `768`; compact pages use four participants (`sdks/typescript/react-native/src/utils/native-space-layout.ts:5-8`).
- `normalizeStageParticipants` puts the local participant first, removes duplicate ids, then keeps the input order (`native-space-layout.ts:51-69`).
- `buildCompactParticipantPages` chunks all participants into pages of four (`native-space-layout.ts:72-82`).
- `resolveScreenShareSource` resolves a sharer by id, prefers the explicit live screen track, falls back to the participant track, and marks local sharing only when a local sharer has a live track (`native-space-layout.ts:84-105`).
- `resolveNativeSpaceLayout` derives `allParticipants`, `gridPages`, and screen-share state. Wide whiteboard plus live share becomes `split`; whiteboard alone wins on compact view; otherwise a live share becomes `screen-share` or the local `screen-share-placeholder` (`native-space-layout.ts:108-134`).
- `useSpaceViewDerived` gets `useWindowDimensions().width` and treats `<768` as compact (`sdks/typescript/react-native/src/components/native-space-view/useSpaceViewDerived.ts:15-28`).

### Native rendering

- `SpaceViewShared` renders `SpaceStageAndroid` when the derived state is stage mode or the selected layout is not grid (`sdks/typescript/react-native/src/components/SpaceView.shared.tsx:37-57`). A pure grid uses `SpaceGridAndroid` in the remainder of that component.
- `SpaceGridAndroid` uses one full tile for one participant, compact two-up for two, a 3/2 stacked arrangement for three, and a 2x2 arrangement for four (`sdks/typescript/react-native/src/components/native-space-view/SpaceGrid.android.tsx:62-119`).
- Larger grids use a horizontal paged `FlatList`. Phones use the four-item pages from the resolver; tablets rebuild pages of six (`SpaceGrid.android.tsx:37-48`). Tablet columns are three in landscape and two in portrait; phones always use two columns (`SpaceGrid.android.tsx:121-159`).
- Native page snapping computes the active page from `contentOffset.x / layoutMeasurement.width`, with page dots below (`SpaceGrid.android.tsx:123-168`).
- `SpaceStageAndroid` puts the primary content in a flex stage and renders a participant strip below, or vertically at the side for a wide focus layout (`SpaceStage.android.tsx:108-180`).
- The native screen-share stage uses `MediaView objectFit="contain"`; local share renders an explicit no-preview placeholder to avoid an infinite mirror (`SpaceStage.android.tsx:70-83`, `112-135`).
- The native strip uses fixed tile sizes: horizontal `132x100`, vertical `100x132`, with `FlatList` clipping/windowing (`SpaceStage.android.tsx:86-105`, `341-372`).
- Compared with web, RN has an explicit resolver, local-share suppression, whiteboard/share split mode, and tablet page sizing. Web has CSS grid for normal tiles and a measured/zoomable share surface instead.

## 9. What a redesign must keep

These are the current public or consumer-visible contracts, not redesign recommendations.

### Public package exports

- `ParticipantGrid` is exported from `@q9labsai/chalk-react` and `@q9labsai/chalk-react/components` (`sdks/typescript/react/src/index.ts:1-9`; `components/index.ts:1-7`).
- Its public `ParticipantGridProps` are `layout?: "grid" | "focus" | "presentation"`, `variant?: "desktop" | "mobile"`, `pinnedParticipantId?`, `onParticipantClick?`, `onParticipantDoubleClick?`, `maxVisibleParticipants?`, `className?`, `showScreenShareIndicator?`, and `screenShareContent?` (`ParticipantGrid.tsx:28-40`).
- Its exported `Participant` type includes ids/name, local/speaking/mute/video/screen/hand/quality/avatar flags, camera/screen tracks, and screen-share audio track (`ParticipantGrid.tsx:12-26`).
- `ScreenShareView` and `ScreenShareViewProps` are public from both package entrypoints (`components/index.ts:18-19`; `index.ts:1-9`). Props are `onStopShare?`, `showThumbnails?`, `thumbnailPosition?: "bottom" | "right"`, `enableZoom?`, and `className?` (`ScreenShareView.tsx:13-19`).
- `Chalk` and `ChalkProps` are the documented public turnkey surface (`components/index.ts:1-2`; `sdks/typescript/react/README.md:19-41`). Its layout contract is `SpaceLayout = "focus" | "grid" | "presentation"` and `onLayoutChange` (`Chalk.tsx:21`, `48-62`).
- `SpaceView`, `ClassicSpaceView`, `ClassicParticipantGrid`, and `ParticipantTile` are implementation files, not named exports from the package’s root/components entrypoints. `ParticipantTile` is exported only through the internal `components/atomic/index.ts:1-4` barrel.

### Consumer-visible behavior

- `Chalk` defaults to the classic skin, supports the independent `skin`, `palette`, and `texture` controls, and sizes itself from its parent (`Chalk.tsx:64-66`; `sdks/typescript/react/README.md:43-63`).
- `SpaceView`/`Chalk` layout values, controlled `onLayoutChange`, feature flags, panel names, screen-share replacement, whiteboard replacement, and `className` are consumed by the SDK preview (`apps/web/src/components/sdk-preview/SdkPreviewGallery.tsx:146-160`).
- App-owned screen-share and whiteboard preview surfaces are passed as stage overlays in the SDK preview (`SdkPreviewGallery.tsx:135-142`), while normal live state is still derived from the provider snapshot.
- External callers rely on stable tile accessibility labels (`Video tile for ${displayName}`), local “(You)” naming, `onClick`/`onDoubleClick`, `maxVisibleParticipants`, mobile page buttons (`Go to page N`), and screen-share controls/thumbnail props (`ParticipantTile.tsx:174-180`; `ParticipantGrid.tsx:270-290`; `ScreenShareView.tsx:266-315`).
