import type { ChatUploadFile, ClientEventMap } from "@q9labsai/chalk-client";

import type { ChalkProps, SpaceLayout } from "./components/chalk/Chalk";
import type { ThemeAppearance, ThemeSkin } from "./components/theme";
import type { ChalkThemeTokens } from "./theme";
import * as bindings from "./index";

type Assert<TCondition extends true> = TCondition;
type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

type PublicHooks = Extract<keyof typeof bindings, `use${string}`>;
type ExpectedHooks = "useSpaceClient" | "useConnection" | "useSelf" | "useParticipants" | "useMedia" | "useChat" | "useReactions" | "useWhiteboard" | "useCan";
type ExpectedLayout = "focus" | "grid" | "presentation";
type ExpectedSkin = "classic" | "chalk";
type ExpectedAppearanceKeys = "skin" | "palette" | "texture";
type ExpectedTokenKeys = "canvas" | "chrome" | "surface" | "stage" | "text" | "mutedText" | "line" | "accent" | "accentText" | "positive" | "danger" | "dangerSurface" | "focus" | "shadow";
type ExpectedChalkProps =
  | "client"
  | "space"
  | "getAccess"
  | "entrance"
  | "defaults"
  | "displayName"
  | "features"
  | "theme"
  | "pickChatFiles"
  | "logoUrl"
  | "spaceName"
  | "spaceDescription"
  | "inviteLink"
  | "layout"
  | "onLayoutChange"
  | "onOpenDiagnostics"
  | "feedbackSource"
  | "diagnosticReference"
  | "onSendFeedback"
  | "onJoined"
  | "onLeft"
  | "onEpisodeEnded"
  | "onParticipantJoined"
  | "onParticipantLeft"
  | "onScreenShareStarted"
  | "onScreenShareStopped"
  | "onError";

type HooksAreClosed = Assert<Equal<PublicHooks, ExpectedHooks>>;
type LayoutIsCanonical = Assert<Equal<SpaceLayout, ExpectedLayout>>;
type SkinIsCanonical = Assert<Equal<ThemeSkin, ExpectedSkin>>;
type AppearanceIsClosed = Assert<Equal<keyof ThemeAppearance, ExpectedAppearanceKeys>>;
type TokensAreClosed = Assert<Equal<keyof ChalkThemeTokens, ExpectedTokenKeys>>;
type ErrorMirrorsClientEvent = Assert<Equal<NonNullable<ChalkProps["onError"]>, (event: ClientEventMap["error"]) => void>>;
type ChatFilePickerMirrorsClientType = Assert<Equal<NonNullable<ChalkProps["pickChatFiles"]>, () => Promise<readonly ChatUploadFile[]>>>;
type NoLegacyStylingProp = Assert<Equal<Extract<keyof ChalkProps, "className" | "containerClassName">, never>>;
type ChalkPropsAreClosed = Assert<Equal<keyof ChalkProps, ExpectedChalkProps>>;

export type PublicSurfaceContract = [HooksAreClosed, LayoutIsCanonical, SkinIsCanonical, AppearanceIsClosed, TokensAreClosed, ErrorMirrorsClientEvent, ChatFilePickerMirrorsClientType, NoLegacyStylingProp, ChalkPropsAreClosed];

export {};
