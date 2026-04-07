import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const androidComponentFiles = [
  ["NativeMeetingRoom.android.tsx", "NativeMeetingRoomAndroid", "NativeMeetingRoom"],
  ["NativeMeetingActionsSheet.android.tsx", "NativeMeetingActionsSheetAndroid", "NativeMeetingActionsSheet"],
  ["NativeMeetingPanel.android.tsx", "NativeMeetingPanelAndroid", "NativeMeetingPanel"],
  ["NativeJoiningLoadingScreen.android.tsx", "NativeJoiningLoadingScreenAndroid", "NativeJoiningLoadingScreen"],
  ["NativePreJoinLobby.android.tsx", "NativePreJoinLobbyAndroid", "NativePreJoinLobby"],
  ["NativeEndScreen.android.tsx", "NativeEndScreenAndroid", "NativeEndScreen"],
] as const;

const macosComponentFiles = [
  ["NativeMeetingRoom.macos.tsx", "NativeMeetingRoomMacos", "NativeMeetingRoom"],
  ["NativeMeetingActionsSheet.macos.tsx", "NativeMeetingActionsSheetMacos", "NativeMeetingActionsSheet"],
  ["NativeMeetingPanel.macos.tsx", "NativeMeetingPanelMacos", "NativeMeetingPanel"],
  ["NativeJoiningLoadingScreen.macos.tsx", "NativeJoiningLoadingScreenMacos", "NativeJoiningLoadingScreen"],
  ["NativePreJoinLobby.macos.tsx", "NativePreJoinLobbyMacos", "NativePreJoinLobby"],
  ["NativeEndScreen.macos.tsx", "NativeEndScreenMacos", "NativeEndScreen"],
] as const;

const androidMeetingRoomFiles = [
  ["native-meeting-room/NativeMeetingGrid.android.tsx", "NativeMeetingGridAndroid", "NativeMeetingGrid"],
  ["native-meeting-room/NativeMeetingStage.android.tsx", "NativeMeetingStageAndroid", "NativeMeetingStage"],
  ["native-meeting-room/NativeMeetingTopBar.android.tsx", "NativeMeetingTopBarAndroid", "NativeMeetingTopBar"],
  ["native-meeting-room/NativeMeetingBottomDock.android.tsx", "NativeMeetingBottomDockAndroid", "NativeMeetingBottomDock"],
] as const;

const macosMeetingRoomFiles = [
  ["native-meeting-room/NativeMeetingGrid.macos.tsx", "NativeMeetingGridMacos", "NativeMeetingGrid"],
  ["native-meeting-room/NativeMeetingStage.macos.tsx", "NativeMeetingStageMacos", "NativeMeetingStage"],
  ["native-meeting-room/NativeMeetingTopBar.macos.tsx", "NativeMeetingTopBarMacos", "NativeMeetingTopBar"],
  ["native-meeting-room/NativeMeetingBottomDock.macos.tsx", "NativeMeetingBottomDockMacos", "NativeMeetingBottomDock"],
] as const;

describe("Platform split exports", () => {
  it.each([...androidComponentFiles, ...macosComponentFiles, ...androidMeetingRoomFiles, ...macosMeetingRoomFiles])("keeps %s exporting %s for Metro platform resolution", (relativePath, platformName, genericName) => {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");

    expect(source).toContain(`export { ${platformName} as ${genericName} };`);
  });
});
