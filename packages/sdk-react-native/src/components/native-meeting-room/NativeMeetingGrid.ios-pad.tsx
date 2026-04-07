import { useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Theme } from "../../ui/theme";
import { NativeMediaView } from "../NativeMediaView";
import type { RoomParticipant } from "./types";

export interface NativeMeetingGridProps {
  participants: readonly RoomParticipant[];
  gridPages: readonly (readonly RoomParticipant[])[];
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

export function NativeMeetingGridIosPad({ participants, gridPages }: NativeMeetingGridProps): React.JSX.Element {
  const { width, height } = useWindowDimensions();
  const isTablet = width >= 768;
  const [activePage, setActivePage] = useState(0);

  const finalPages = useMemo(() => {
    if (!isTablet) {
      return gridPages;
    }

    const perPage = 12;
    const pages: RoomParticipant[][] = [];
    for (let index = 0; index < participants.length; index += perPage) {
      pages.push(participants.slice(index, index + perPage));
    }
    return pages;
  }, [gridPages, isTablet, participants]);

  useEffect(() => {
    setActivePage((currentPage) => Math.min(currentPage, Math.max(0, finalPages.length - 1)));
  }, [finalPages.length]);

  if (participants.length === 0) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyEyebrow}>Meeting ready</Text>
        <Text style={styles.emptyTitle}>You're the first one here</Text>
        <Text style={styles.emptyCopy}>Others will appear when they join. Invite someone to get started.</Text>
      </View>
    );
  }

  if (participants.length === 1) {
    return (
      <View style={styles.singleTile}>
        <NativeMediaView emphasizeMuted participant={participants[0] ?? null} track={getParticipantTileTrack(participants[0]!)} />
      </View>
    );
  }

  return (
    <View style={styles.pagedContainer}>
      <FlatList
        data={finalPages}
        horizontal
        keyExtractor={(_, index) => `page-${index + 1}`}
        onMomentumScrollEnd={(event) => {
          const measuredPageWidth = Math.max(1, event.nativeEvent.layoutMeasurement.width);
          setActivePage(Math.round(event.nativeEvent.contentOffset.x / measuredPageWidth));
        }}
        pagingEnabled
        snapToInterval={width}
        snapToAlignment="center"
        decelerationRate="fast"
        disableIntervalMomentum
        scrollEventThrottle={16}
        removeClippedSubviews={false}
        showsHorizontalScrollIndicator={false}
        windowSize={3}
        renderItem={({ item: page }) => {
          let columns = 2;
          if (isTablet) {
            columns = width > height ? 4 : 3;
          }
          const rows = buildWideParticipantRows(page, columns);

          return (
            <View style={[styles.page, { width }]}>
              <View style={styles.gridContainer}>
                {rows.map((row, rowIndex) => (
                  <View key={`row-${rowIndex}`} style={styles.gridRow}>
                    {row.map((participant, columnIndex) => (
                      <View key={`${participant.id}-${columnIndex}`} style={styles.gridTile}>
                        <NativeMediaView emphasizeMuted participant={participant} track={getParticipantTileTrack(participant)} />
                      </View>
                    ))}
                    {row.length < columns && Array.from({ length: columns - row.length }).map((_, index) => <View key={`filler-${index}`} style={[styles.gridTile, { backgroundColor: "transparent" }]} />)}
                  </View>
                ))}
              </View>
            </View>
          );
        }}
      />

      {finalPages.length > 1 ? (
        <View style={styles.pageIndicators}>
          {finalPages.map((_, index) => (
            <View key={`indicator-${index + 1}`} style={[styles.pageIndicator, index === activePage && styles.pageIndicatorActive]} />
          ))}
        </View>
      ) : null}
    </View>
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
    padding: 10,
  },
  compactTwoUp: {
    flex: 1,
    gap: 10,
    padding: 10,
  },
  compactThree: {
    flex: 1,
    gap: 10,
    padding: 10,
  },
  compactThreeTop: {
    flex: 3,
    minHeight: 0,
    overflow: "hidden",
  },
  compactThreeBottom: {
    flex: 2,
    flexDirection: "row",
    gap: 10,
    minHeight: 0,
  },
  compactFour: {
    flex: 1,
    gap: 10,
    padding: 10,
  },
  pagedContainer: {
    flex: 1,
    width: "100%",
    paddingBottom: 20,
  },
  page: {
    flex: 1,
  },
  gridContainer: {
    flex: 1,
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  gridRow: {
    flex: 1,
    flexDirection: "row",
    gap: 10,
  },
  gridTile: {
    flex: 1,
  },
  pageIndicators: {
    flexDirection: "row",
    alignSelf: "center",
    gap: 6,
    paddingTop: 4,
  },
  pageIndicator: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.2)",
  },
  pageIndicatorActive: {
    width: 18,
    backgroundColor: Theme.colors.primary,
  },
});
