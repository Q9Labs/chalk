import type { ParticipantState } from "@q9labs/chalk-core";
import { useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { LayoutMode } from "@q9labs/chalk-core";
import { Theme } from "../../ui/theme";
import { NativeMediaView } from "../NativeMediaView";

type RoomParticipant = ParticipantState["participants"][number];

interface NativeMeetingGridProps {
  participants: readonly RoomParticipant[];
  gridPages: readonly (readonly RoomParticipant[])[];
  isCompactViewport: boolean;
  layoutMode: LayoutMode;
}

function buildWideParticipantRows(participants: readonly RoomParticipant[], columnCount: number): RoomParticipant[][] {
  if (participants.length === 0) {
    return [];
  }

  const rows: RoomParticipant[][] = [];
  for (let index = 0; index < participants.length; index += columnCount) {
    rows.push(participants.slice(index, index + columnCount));
  }

  return rows;
}

function getParticipantTileTrack(participant: RoomParticipant): MediaStreamTrack | null {
  return participant.videoTrack ?? null;
}

function getWideColumnCount(participantCount: number, layoutMode: LayoutMode): number {
  if (layoutMode === "speaker") {
    return participantCount > 6 ? 3 : 2;
  }

  if (participantCount <= 4) {
    return 2;
  }

  if (participantCount <= 9) {
    return 3;
  }

  return 4;
}

export function NativeMeetingGrid({ participants, gridPages, isCompactViewport, layoutMode }: NativeMeetingGridProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const wideColumns = useMemo(() => getWideColumnCount(participants.length, layoutMode), [participants.length, layoutMode]);
  const wideRows = useMemo(() => buildWideParticipantRows(participants, wideColumns), [participants, wideColumns]);
  const [activePage, setActivePage] = useState(0);
  const [pageWidth, setPageWidth] = useState(Math.max(0, width - 24));

  useEffect(() => {
    setActivePage((currentPage) => Math.min(currentPage, Math.max(0, gridPages.length - 1)));
  }, [gridPages.length]);

  if (participants.length === 0) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyEyebrow}>Meeting ready</Text>
        <Text style={styles.emptyTitle}>You're the first one here</Text>
        <Text style={styles.emptyCopy}>Others will appear when they join. Invite someone to get started.</Text>
      </View>
    );
  }

  if (isCompactViewport) {
    if (participants.length === 1) {
      return (
        <View style={styles.singleTile}>
          <NativeMediaView emphasizeMuted participant={participants[0] ?? null} track={participants[0] ? getParticipantTileTrack(participants[0]) : null} />
        </View>
      );
    }

    if (participants.length === 2) {
      return (
        <View style={styles.compactTwoUp}>
          {participants.map((participant, index) => (
            <View key={`${participant.id}-${index}`} style={styles.compactTwoUpTile}>
              <NativeMediaView emphasizeMuted participant={participant} track={getParticipantTileTrack(participant)} />
            </View>
          ))}
        </View>
      );
    }

    if (participants.length === 3) {
      return (
        <View style={styles.compactThree}>
          <View style={styles.compactThreeTop}>
            <NativeMediaView emphasizeMuted participant={participants[0]!} track={getParticipantTileTrack(participants[0]!)} />
          </View>
          <View style={styles.compactThreeBottom}>
            <View style={styles.compactThreeBottomTile}>
              <NativeMediaView emphasizeMuted participant={participants[1]!} track={getParticipantTileTrack(participants[1]!)} />
            </View>
            <View style={styles.compactThreeBottomTile}>
              <NativeMediaView emphasizeMuted participant={participants[2]!} track={getParticipantTileTrack(participants[2]!)} />
            </View>
          </View>
        </View>
      );
    }

    if (participants.length === 4) {
      return (
        <View style={styles.compactFour}>
          <View style={styles.compactFourRow}>
            <View style={styles.compactFourTile}>
              <NativeMediaView emphasizeMuted participant={participants[0]!} track={getParticipantTileTrack(participants[0]!)} />
            </View>
            <View style={styles.compactFourTile}>
              <NativeMediaView emphasizeMuted participant={participants[1]!} track={getParticipantTileTrack(participants[1]!)} />
            </View>
          </View>
          <View style={styles.compactFourRow}>
            <View style={styles.compactFourTile}>
              <NativeMediaView emphasizeMuted participant={participants[2]!} track={getParticipantTileTrack(participants[2]!)} />
            </View>
            <View style={styles.compactFourTile}>
              <NativeMediaView emphasizeMuted participant={participants[3]!} track={getParticipantTileTrack(participants[3]!)} />
            </View>
          </View>
        </View>
      );
    }

    return (
      <View style={styles.compactPaged}>
        <FlatList
          data={gridPages}
          horizontal
          keyExtractor={(_, index) => `page-${index + 1}`}
          onMomentumScrollEnd={(event) => {
            const measuredPageWidth = Math.max(1, event.nativeEvent.layoutMeasurement.width);
            setActivePage(Math.round(event.nativeEvent.contentOffset.x / measuredPageWidth));
          }}
          onLayout={(event) => {
            setPageWidth(event.nativeEvent.layout.width);
          }}
          pagingEnabled
          removeClippedSubviews
          renderItem={({ item: page }) => (
            <View style={[styles.page, { width: pageWidth }]}>
              <View style={styles.compactQuad}>
                {page.map((participant, index) => (
                  <View key={`${participant.id}-${index}`} style={styles.compactQuadTile}>
                    <NativeMediaView emphasizeMuted participant={participant} track={getParticipantTileTrack(participant)} />
                  </View>
                ))}
              </View>
            </View>
          )}
          showsHorizontalScrollIndicator={false}
          windowSize={3}
        />

        <View style={styles.pageIndicators}>
          {gridPages.map((_, index) => (
            <View key={`indicator-${index + 1}`} style={[styles.pageIndicator, index === activePage && styles.pageIndicatorActive]} />
          ))}
        </View>
      </View>
    );
  }

  return (
    <FlatList
      contentContainerStyle={styles.wideScrollContent}
      data={wideRows}
      key={`wide-grid-${wideColumns}`}
      keyExtractor={(_, index) => `row-${index + 1}`}
      removeClippedSubviews
      renderItem={({ item: row }) => (
        <View style={styles.wideRow}>
          {Array.from({ length: wideColumns }, (_, columnIndex) => {
            const participant = row[columnIndex] ?? null;

            return (
              <View key={`${participant?.id ?? "empty"}-${columnIndex + 1}`} style={styles.wideGridTile}>
                {participant ? (
                  <View style={styles.wideGridTileInner}>
                    <NativeMediaView emphasizeMuted participant={participant} track={getParticipantTileTrack(participant)} />
                  </View>
                ) : (
                  <View style={styles.wideGridSpacer} />
                )}
              </View>
            );
          })}
        </View>
      )}
      showsVerticalScrollIndicator={false}
      windowSize={6}
      initialNumToRender={4}
      maxToRenderPerBatch={6}
    />
  );
}

const styles = StyleSheet.create({
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Theme.spacing["3xl"],
    gap: Theme.spacing.sm,
  },
  emptyEyebrow: {
    ...Theme.typography.eyebrow,
    color: Theme.colors.primary,
  },
  emptyTitle: {
    ...Theme.typography.heading,
    color: Theme.colors.foreground,
  },
  emptyCopy: {
    ...Theme.typography.body,
    color: Theme.colors.mutedForeground,
    textAlign: "center",
  },
  singleTile: {
    flex: 1,
  },
  compactTwoUp: {
    flex: 1,
    gap: Theme.spacing.sm,
  },
  compactTwoUpTile: {
    flex: 1,
    minHeight: 0,
    borderRadius: Theme.radius.xl,
    overflow: "hidden",
  },
  compactThree: {
    flex: 1,
    gap: Theme.spacing.sm,
  },
  compactThreeTop: {
    flex: 3,
    minHeight: 0,
    borderRadius: Theme.radius.xl,
    overflow: "hidden",
  },
  compactThreeBottom: {
    flex: 2,
    flexDirection: "row",
    gap: Theme.spacing.sm,
    minHeight: 0,
  },
  compactThreeBottomTile: {
    flex: 1,
    minHeight: 0,
    borderRadius: Theme.radius.xl,
    overflow: "hidden",
  },
  compactFour: {
    flex: 1,
    gap: Theme.spacing.sm,
  },
  compactFourRow: {
    flex: 1,
    flexDirection: "row",
    gap: Theme.spacing.sm,
    minHeight: 0,
  },
  compactFourTile: {
    flex: 1,
    minHeight: 0,
    borderRadius: Theme.radius.xl,
    overflow: "hidden",
  },
  compactQuad: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Theme.spacing.sm,
  },
  compactQuadTile: {
    flexBasis: "48%",
    flexGrow: 1,
    aspectRatio: 4 / 3,
    borderRadius: Theme.radius.xl,
    overflow: "hidden",
  },
  compactPaged: {
    flex: 1,
  },
  page: {
    flex: 1,
    paddingRight: Theme.spacing.sm,
  },
  pageIndicators: {
    flexDirection: "row",
    justifyContent: "center",
    gap: Theme.spacing.sm,
    paddingTop: Theme.spacing.md,
  },
  pageIndicator: {
    width: 8,
    height: 8,
    borderRadius: Theme.radius.full,
    backgroundColor: "rgba(255,255,255,0.24)",
  },
  pageIndicatorActive: {
    width: 22,
    backgroundColor: Theme.colors.primary,
  },
  wideScrollContent: {
    paddingBottom: Theme.spacing.sm,
  },
  wideRow: {
    flexDirection: "row",
    gap: Theme.spacing.sm,
    paddingBottom: Theme.spacing.sm,
  },
  wideGridTile: {
    flex: 1,
  },
  wideGridTileInner: {
    aspectRatio: 1.18,
  },
  wideGridSpacer: {
    aspectRatio: 1.18,
    borderRadius: Theme.radius.xl,
    backgroundColor: "transparent",
  },
});
