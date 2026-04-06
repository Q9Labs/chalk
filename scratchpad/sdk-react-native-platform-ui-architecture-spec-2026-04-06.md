# SDK React Native Platform UI Architecture Spec

Status: final  
Date: 2026-04-06

## Purpose

Define what UI and architecture should be shared versus platform-owned across:

- Android
- iOS
- iPadOS
- macOS
- future: tvOS

The goal is platform isolation, separability, and maintainability over DRY UI.

## Current State

Today, screen-level JSX is still mostly shared:

- `PreJoinLobby`:
  - `/Users/macmini/Desktop/Code/chalk/packages/sdk-react-native/src/components/NativePreJoinLobby.tsx`
- `MeetingRoom`:
  - `/Users/macmini/Desktop/Code/chalk/packages/sdk-react-native/src/components/NativeMeetingRoom.tsx`
- `HomeScreen`:
  - `/Users/macmini/Desktop/Code/chalk/apps/mobile/src/screens/HomeScreen.tsx`

Current platform handling is mostly done with:

- `Platform.OS`
- width/compact viewport checks
- shared modal/sheet assumptions

This is the pattern the architecture should move away from.

## Agreed Principles

- Share foundation and logic.
- Keep screen chrome and layout platform-owned.
- Duplicate JSX and styles freely when that lowers regression risk.
- Do not force mobile sheet UI to also serve iPadOS or macOS.
- Treat iPadOS as a first-class platform variant, not just a wider iPhone.
- Keep HomeScreen more shared than meeting surfaces for now.

## Implementation Mode

This spec is intentionally about separation first, redesign later.

The implementation rule is:

- split the platforms
- preserve the current UI as closely as possible
- do not spend time inventing new platform-specific visual design during the split
- do not "improve" layouts just because files are being separated
- do not introduce a new visual direction during the architecture pass

In practical terms:

- the first pass should isolate JSX by platform without materially changing the current look and behavior
- platform files should begin as near-faithful copies/adaptations of the existing shared JSX
- any platform-specific visual improvements should be deferred to a later pass led by a frontend design specialist

This means:

- adjust the code structure
- do not intentionally adjust the product UI yet

The goal of the first implementation pass is:

- platform isolation
- safer future editing
- lower regression risk
- a clean foundation for later targeted UI work

The goal of the first implementation pass is not:

- polishing each platform
- redesigning desktop/tablet experiences
- rethinking spacing, hierarchy, or visual language
- introducing new platform-specific affordances unless strictly necessary for functional correctness

## Shared By Default

These are expected to stay shared unless a specific platform has a strong reason not to use them.

### Foundation

- design tokens
- color system
- typography tokens
- spacing tokens
- radius tokens
- shadow recipes
- blur/material recipes
- animation timing/easing recipes
- iconography
- shared button/input/card primitives

### Logic

- session hooks
- meeting controllers
- join-flow controllers
- derived scene/layout logic
- diagnostics
- feature gating
- invite/join utilities
- formatting helpers

### Stable Cross-Platform Primitives

- `NativeFaceAvatar`
- `NativeMediaView`
- `NativeGradientSurface`
- `ChalkLogoElements`
- `NativeReactionPicker` for now

These are explicitly considered safe to share because consistency is desirable and the compatibility risk is relatively low.

## Do Not Share At Screen-Chrome Level

These should become platform-owned renderers rather than universal JSX with conditionals:

- full screen layout shells
- top bars
- bottom docks
- stage composition containers
- action sheets / popovers / sidebars
- panel shells
- chat shell
- participants shell
- settings shell
- transcript shell
- whiteboard control shell

## Per-Screen Inventory

## 1. HomeScreen

Screen owner today:

- `/Users/macmini/Desktop/Code/chalk/apps/mobile/src/screens/HomeScreen.tsx`

Platform strategy:

- keep mostly shared for now
- split layout only for iPadOS and macOS first
- Android and iPhone can continue sharing the same layout initially

### Share

- route/navigation logic
- create/join handlers
- clipboard invite detection logic
- error/loading state
- design tokens and shared mobile/app design system
- `ChalkLogoElements`
- `ClipboardInviteSuggestion` content model and behavior
- input/button primitives if extracted into shared DS components
- footer link behavior

### Do Not Share

- overall page layout for iPadOS and macOS
- hero composition if desktop/tablet wants different balance
- action section layout when moving to wider layouts
- footer placement when moving to desktop/tablet layouts

### HomeScreen Component Inventory

- Safe-area page shell:
  - share on Android + iPhone initially
  - split for iPadOS + macOS layout
- Hero section:
  - shared copy/content
  - layout may split for iPadOS + macOS
- `ChalkLogoElements`:
  - share
- Primary CTA row:
  - behavior share
  - layout can split for iPadOS + macOS
- Invite input row:
  - behavior share
  - layout can split for iPadOS + macOS
- `ClipboardInviteSuggestion`:
  - share initially
  - only split if desktop/tablet interaction model diverges enough later
- Footer links:
  - content/behavior share
  - placement/layout can split

## 2. PreJoinLobby

Screen owner today:

- `/Users/macmini/Desktop/Code/chalk/packages/sdk-react-native/src/components/NativePreJoinLobby.tsx`

Platform strategy:

- split screen JSX by platform
- Android, iOS, iPadOS, and macOS each get platform-owned layout

### Share

- prejoin state/controller
- display-name state
- audio/video toggle state
- submit/join state
- preview stream acquisition logic
- simulator media guard logic
- error state
- design tokens and shared primitives
- `NativeFaceAvatar`
- `NativeMediaView`-adjacent preview primitives if kept generic

### Do Not Share

- overall screen layout
- preview/sheet composition
- back-button placement
- control arrangement
- CTA arrangement
- tablet/desktop multi-column layout
- modal vs panel vs embedded layout choices

### PreJoinLobby Component Inventory

- Root screen shell:
  - do not share
- Preview hero container:
  - do not share
- Back affordance:
  - do not share
- Name input card:
  - share primitive styling/tokens
  - do not share container JSX/layout
- Audio/video toggle row:
  - share primitive buttons/icons/tokens
  - do not share row/container layout
- Join CTA area:
  - share button primitive
  - do not share section layout
- Preview fallback avatar:
  - share `NativeFaceAvatar`
- Preview error/hint messaging:
  - share content rules and logic
  - layout placement can be platform-owned

## 3. MeetingRoom

Screen owner today:

- `/Users/macmini/Desktop/Code/chalk/packages/sdk-react-native/src/components/NativeMeetingRoom.tsx`

Platform strategy:

- split aggressively by platform
- do not optimize for shared JSX here
- use a shared controller layer beneath platform renderers

### Share

- meeting room controller logic
- session hooks
- feature flags
- diagnostics
- async action wrappers
- invite/share logic
- panel state model
- reaction state model
- derived meeting-scene/layout logic
- participant normalization
- screen-share source resolution
- `NativeFaceAvatar`
- `NativeMediaView`
- `NativeGradientSurface`
- `NativeReactionPicker` as a primitive for now
- icon set and theme tokens

### Do Not Share

- top bar JSX
- stage JSX
- bottom dock JSX
- action sheet / action menu container JSX
- panel container JSX
- chat container JSX
- participants container JSX
- settings container JSX
- transcript container JSX
- whiteboard panel container JSX
- desktop/tablet sidebar/split-pane compositions
- mobile sheet compositions

### MeetingRoom Component Inventory

- Root meeting shell:
  - do not share
- TopBar:
  - do not share
- Stage frame:
  - do not share
- `NativeMeetingStage`:
  - split by platform
- `NativeMeetingGrid`:
  - split by platform
- speaker stage:
  - do not share container/layout
- screen-share stage:
  - do not share container/layout
- split whiteboard + screen-share stage:
  - do not share
- participant strip:
  - do not share container/layout
- identity/status overlays:
  - likely platform-owned
  - can reuse shared badge primitives if extracted
- BottomDock:
  - do not share
- `NativeMeetingActionsSheet`:
  - split by platform
- `NativeReactionPicker`:
  - share for now as a primitive
  - split later only if a platform-specific presentation need becomes strong enough
- `NativeMeetingPanel`:
  - split by platform
- chat panel:
  - share data model and actions
  - share chat bubble visuals for now
  - do not share shell/container
- participants panel:
  - share data model and moderation actions
  - do not share shell/container
- settings panel:
  - share device lists and actions
  - do not share shell/container
- transcripts panel:
  - share transcript data
  - do not share shell/container
- whiteboard panel:
  - share actions/data
  - do not share shell/container

## Lifecycle Screens

### JoiningLoadingScreen

- split by platform as part of the lifecycle surface
- preserve the current UI as closely as possible in the first pass
- defer intentional platform-specific design improvements to the later design pass

### EndScreen

- split by platform as part of the lifecycle surface
- preserve the current UI as closely as possible in the first pass
- defer intentional platform-specific design improvements to the later design pass

## Recommended Boundary Rule

Use three layers:

### 1. Shared Foundation

- tokens
- design primitives
- iconography
- animation recipes
- avatar/media primitives

### 2. Shared Logic

- hooks
- controllers
- diagnostics
- derived layout/scene state
- actions/intents

### 3. Platform-Owned Screen Chrome

- full screen JSX
- section layout
- dock/panel/sheet/sidebar choices
- stage composition
- platform-specific affordances

## Near-Term Platform Split Recommendation

### Implementation posture for this phase

- create platform-owned files
- preserve today’s UI as closely as possible
- do not treat the split itself as permission to redesign
- let the later frontend design pass make intentional platform-specific UI decisions

### HomeScreen

- shared:
  - Android
  - iPhone
- separate layout implementations:
  - iPadOS
  - macOS

### PreJoinLobby

- separate platform implementations:
  - Android
  - iOS
  - iPadOS
  - macOS

### MeetingRoom

- separate platform implementations:
  - Android
  - iOS
  - iPadOS
  - macOS

### JoiningLoadingScreen

- separate platform implementations:
  - Android
  - iOS
  - iPadOS
  - macOS

### EndScreen

- separate platform implementations:
  - Android
  - iOS
  - iPadOS
  - macOS

### Future tvOS

- reserve a platform folder and renderer boundary early
- do not back-fit tvOS needs into mobile or macOS JSX later

## Execution Strategy

Execution checklist is dependency-tracked. A phase should not begin until its dependencies are satisfied.

Parallel work is allowed only when:

- dependency requirements are already met
- write scopes are disjoint
- the work does not increase merge/conflict risk

## Parallelization Strategy

Parallelization is encouraged, but it should follow a strict ownership model.

### Blocking Delegation Allowed

Shared foundation extraction and contract establishment may be delegated to a blocking subagent if that subagent is explicitly responsible for:

- establishing the shared foundation inside `sdk-react-native`
- defining the shared contracts for the execution pass
- keeping the exported shared layer narrow and stable

This is the one shared-core area that may be delegated even though it is on the critical path.

### Main Agent Ownership

The main agent owns:

- overall orchestration
- execution ordering across waves
- shared controller/state extraction after contracts are established
- platform variant resolver and variant routing decisions
- exports and barrel integration
- integration wiring
- conflict resolution
- final parity audit
- final spec-compliance judgment
- coordination and review of all subagent output

### Subagent Ownership

Subagents should own:

- shared foundation/contracts if explicitly delegated as a blocking task
- platform-specific renderer files
- platform-specific layout files
- bounded platform-scoped parity checks
- other bounded work with disjoint write scopes

### Preferred Delegation Shape

After shared contracts are stable, parallelize by platform rather than by surface type.

Preferred:

- one subagent owns `android/`
- one subagent owns `ios/phone/`
- one subagent owns `ios/pad/`
- one subagent owns `macos/`

Avoid:

- one subagent owning all `TopBar` files
- one subagent owning all `Panel` files
- one subagent owning all `Stage` files

Platform ownership reduces merge conflicts and better matches the architecture goal.

### Waves

#### Wave 1: Shared Foundation And Contracts

- may be delegated to a blocking subagent
- main agent remains responsible for reviewing and accepting the contracts before further work proceeds

#### Wave 2: Shared Controllers

- main agent owned

#### Wave 3: Lifecycle Screens

- may be parallelized once contracts are stable

#### Wave 4: `PreJoinLobby`

- may be parallelized by platform

#### Wave 5: `MeetingRoom` Shell

- main agent establishes boundaries first
- then platform implementations may parallelize

#### Wave 6: `MeetingRoom` Surfaces

- may be parallelized by platform

#### Wave 7: `HomeScreen`

- optional parallelism for iPadOS and macOS layouts

#### Wave 8: Verification

- support verification can be parallelized
- final judgment remains with the main agent

#### Wave 9: Final Review

- a `gpt-5.4` high-reasoning subagent reviews the code and changes against the spec
- the main agent owns the final acceptance decision

### Phase 1: Establish Shared Foundation

Depends on:

- none within execution spec; preconditions are assumed already agreed

Checklist:

- consolidate the approved shared foundation inside `sdk-react-native`
- export tokens, theme, and approved shared primitives from `sdk-react-native`
- keep the shared layer narrow and stable
- do not move screen-shell JSX into the shared layer
- ensure app-owned `HomeScreen` can consume the shared foundation cleanly

### Phase 2: Extract Shared Controllers

Depends on:

- Phase 1

#### Phase 2.1: Extract `PreJoinLobby` Controller

Depends on:

- Phase 1

Checklist:

- extract `PreJoinLobby` state and actions into a shared controller/state layer
- preserve behavior exactly
- leave rendering responsibility to future platform renderers

#### Phase 2.2: Extract `MeetingRoom` Controller

Depends on:

- Phase 1

Checklist:

- extract `MeetingRoom` logic into a shared controller/state layer
- keep hooks, diagnostics, actions, and derived state centralized
- preserve behavior exactly
- leave rendering responsibility to future platform renderers

### Phase 3: Split Lifecycle Screens

Depends on:

- Phase 1

#### Phase 3.1: Split `JoiningLoadingScreen`

Depends on:

- Phase 1

Checklist:

- create platform-owned `JoiningLoadingScreen` implementations for Android, iOS, iPadOS, and macOS
- preserve the current UI as closely as possible
- avoid platform-specific redesign in this pass

#### Phase 3.2: Split `EndScreen`

Depends on:

- Phase 1

Checklist:

- create platform-owned `EndScreen` implementations for Android, iOS, iPadOS, and macOS
- preserve the current UI as closely as possible
- avoid platform-specific redesign in this pass

### Phase 4: Split `PreJoinLobby`

Depends on:

- Phase 2.1
- Phase 3.1

Checklist:

- create platform-owned `PreJoinLobby` implementations for Android, iOS, iPadOS, and macOS
- start from faithful copies/adaptations of the current JSX
- keep shared controller/state and approved shared primitives underneath
- do not intentionally redesign layout or visual treatment

### Phase 5: Split `MeetingRoom` Shell

Depends on:

- Phase 2.2
- Phase 3.1
- Phase 3.2

Checklist:

- create platform-owned `MeetingRoom` shells for Android, iOS, iPadOS, and macOS
- move top-level room ownership into platform files
- preserve the current composition as closely as possible
- keep shared controller/state underneath

### Phase 6: Split `MeetingRoom` Core Surfaces

Depends on:

- Phase 5

Checklist:

- split `TopBar`
- split `Stage`
- split `BottomDock`
- split `ActionSheet`
- split `Panel`
- preserve parity with the existing UI while isolating ownership
- keep approved shared primitives shared

### Phase 7: Split `MeetingRoom` Sub-Surfaces

Depends on:

- Phase 6

Checklist:

- split stage sub-surfaces:
  - grid
  - speaker/screen-share stage
  - participant strip
  - split whiteboard/screen-share stage
- split panel sub-surfaces:
  - chat
  - participants
  - settings
  - transcripts
  - whiteboard controls
- keep shared chat bubble visuals
- keep `NativeReactionPicker` shared for now

### Phase 8: Split `HomeScreen` Layout

Depends on:

- Phase 1

Checklist:

- keep Android and iPhone on the shared layout path for now
- add iPadOS layout ownership
- add macOS layout ownership
- preserve content, behavior, and visual parity as much as possible
- only separate layout ownership in this phase, not redesign

### Phase 9: Verification And Parity Audit

Depends on:

- Phase 4
- Phase 7
- Phase 8

Checklist:

- verify every screen flow end-to-end:
  - `HomeScreen`
  - `PreJoinLobby`
  - `JoiningLoadingScreen`
  - `MeetingRoom`
  - `EndScreen`
- verify parity in:
  - visible controls
  - copy/content
  - interaction order
  - behavior
  - basic visual structure
- confirm no accidental redesign slipped into the isolation pass

### Phase 10: Independent Spec Review

Depends on:

- Phase 9

Checklist:

- spawn a `gpt-5.4` high-reasoning subagent
- have the subagent review the code and changes against this spec
- require the subagent to identify mismatches, unintended redesign, ownership drift, and missing parity checks
- address any material discrepancies before final cleanup

### Phase 11: Cleanup And Finalization

Depends on:

- Phase 10

Checklist:

- remove transitional branching that is no longer needed
- confirm final ownership boundaries are clean
- confirm what remains shared versus platform-owned
- leave intentional platform-specific design improvements out of scope for this phase
- hand off future targeted UI improvements to a later frontend design pass

## Execution Clarifications

These rules are part of the final spec and are not optional.

### 1. Platform Variant Resolution

Platform ownership must be selected through a shared platform-variant resolver.

The resolver must produce one of:

- `android`
- `ios-phone`
- `ios-pad`
- `macos`
- future: `tvos`

Rules:

- iPadOS must not be inferred independently inside random renderers
- width checks may still influence layout within a platform renderer, but they must not redefine platform ownership
- `ios-phone` versus `ios-pad` selection must happen once at the routing/wrapper boundary

### 2. File Selection And Export Pattern

Use explicit wrapper components plus a shared variant router where needed.

Rules:

- use React Native platform filenames where they map cleanly to platform ownership
- use explicit wrapper/router components for `ios-phone` versus `ios-pad`
- do not rely on ad hoc conditionals spread across multiple renderers to choose platform ownership
- keep public exports stable while moving implementation ownership behind those exports

### 3. `HomeScreen` Shared Foundation Boundary

`HomeScreen` is app-owned, but it is allowed to consume exported foundation primitives and tokens from `sdk-react-native`.

Rules:

- `apps/mobile` may import the shared foundation from `sdk-react-native`
- `HomeScreen` should consume foundation, not shared screen-shell JSX
- the shared layer must remain generic enough to serve SDK and app-owned surfaces

### 4. Parity Definition

“Preserve the current UI” means preserving:

- copy/content
- visible controls
- flow order
- interaction semantics
- broad visual structure

It does not mean enforcing pixel-perfect parity where rendering engines or platform text/layout differences naturally vary.

### 5. Allowed Functional Deviations

Functional deviations are allowed only when required for:

- platform correctness
- framework limitations
- accessibility requirements
- input-model constraints

Outside of those cases, UI drift is out of scope for this phase.

### 6. State Ownership Boundary

Shared meeting/session/business state belongs in shared controllers.

Platform files may own only renderer-local UI state such as:

- open/closed local presentation state
- transient local visual state
- renderer-specific focus or presentation toggles

Platform files must not become alternate sources of truth for shared meeting logic.

### 7. Parallelization Rule

Parallel execution is allowed only when:

- dependencies are satisfied
- write scopes are disjoint
- merge/conflict risk remains low

If those conditions are not satisfied, work should be treated as sequential even if subagents are available.

## Locked Decisions

- `NativeReactionPicker` stays shared as a primitive for now.
- Chat bubbles can stay visually shared for now.
- The shared design system layer should live inside `sdk-react-native` for this effort.
- `HomeScreen` remains app-owned and consumes shared foundation from `sdk-react-native`.
- `PreJoinLobby`, `MeetingRoom`, `JoiningLoadingScreen`, and `EndScreen` split by platform in this phase.
- `HomeScreen` only splits layout for iPadOS and macOS in this phase.
