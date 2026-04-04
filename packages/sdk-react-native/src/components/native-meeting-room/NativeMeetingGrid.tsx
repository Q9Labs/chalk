import type { ParticipantState } from "@q9labs/chalk-core";
import { useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Theme } from "../../ui/theme";
import { NativeMediaView } from "../NativeMediaView";

type RoomParticipant = ParticipantState["participants"][number];

interface NativeMeetingGridProps {
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

export function NativeMeetingGrid({ participants, gridPages }: NativeMeetingGridProps): React.JSX.Element {
  const { width, height } = useWindowDimensions();
  const isTablet = width > 600;
  const [activePage, setActivePage] = useState(0);

  // Determine pages based on platform
  const finalPages = useMemo(() => {
    // If phone, use the pre-calculated pages from the hook
    if (!isTablet) return gridPages;
    
    // For tablets, we force a 6-per-page logic to keep things spacious
    const perPage = 6;
    const pages: RoomParticipant[][] = [];
    for (let i = 0; i < participants.length; i += perPage) {
      pages.push(participants.slice(i, i + perPage));
    }
    return pages;
  }, [isTablet, gridPages, participants]);

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

  // Hero Layouts for small groups on Phone
  if (!isTablet && participants.length <= 4) {
    if (participants.length === 1) {
      return (
        <View style={styles.singleTile}>
          <NativeMediaView emphasizeMuted participant={participants[0] ?? null} track={getParticipantTileTrack(participants[0]!)} />
        </View>
      );
    }

    if (participants.length === 2) {
      return (
        <View style={styles.compactTwoUp}>
          {participants.map((participant, index) => (
            <View key={`${participant.id}-${index}`} style={styles.gridTile}>
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
            <View style={styles.gridTile}>
              <NativeMediaView emphasizeMuted participant={participants[1]!} track={getParticipantTileTrack(participants[1]!)} />
            </View>
            <View style={styles.gridTile}>
              <NativeMediaView emphasizeMuted participant={participants[2]!} track={getParticipantTileTrack(participants[2]!)} />
            </View>
          </View>
        </View>
      );
    }

    if (participants.length === 4) {
      return (
        <View style={styles.compactFour}>
          <View style={styles.gridRow}>
            <View style={styles.gridTile}>
              <NativeMediaView emphasizeMuted participant={participants[0]!} track={getParticipantTileTrack(participants[0]!)} />
            </View>
            <View style={styles.gridTile}>
              <NativeMediaView emphasizeMuted participant={participants[1]!} track={getParticipantTileTrack(participants[1]!)} />
            </View>
          </View>
          <View style={styles.gridRow}>
            <View style={styles.gridTile}>
              <NativeMediaView emphasizeMuted participant={participants[2]!} track={getParticipantTileTrack(participants[2]!)} />
            </View>
            <View style={styles.gridTile}>
              <NativeMediaView emphasizeMuted participant={participants[3]!} track={getParticipantTileTrack(participants[3]!)} />
            </View>
          </View>
        </View>
      );
    }
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
          const cols = isTablet ? (width > height ? 3 : 2) : 2;
          const rows = buildWideParticipantRows(page, cols);
          
          return (
            <View style={[styles.page, { width }]}>
              <View style={styles.gridContainer}>
                {rows.map((row, rowIndex) => (
                  <View key={`row-${rowIndex}`} style={styles.gridRow}>
                    {row.map((participant, colIndex) => (
                      <View key={`${participant.id}-${colIndex}`} style={styles.gridTile}>
                        <NativeMediaView emphasizeMuted participant={participant} track={getParticipantTileTrack(participant)} />
                      </View>
                    ))}
                    {/* Filler for incomplete rows to maintain column widths */}
                    {row.length < cols && Array.from({ length: cols - row.length }).map((_, i) => (
                      <View key={`filler-${i}`} style={[styles.gridTile, { backgroundColor: "transparent" }]} />
                    ))}
                  </View>
                ))}
                {/* Filler for incomplete page height on tablet */}
                {isTablet && rows.length < (width > height ? 2 : 3) && (
                  <View style={{ flex: (width > height ? 2 : 3) - rows.length }} />
                )}
              </View>
            </View>
          );
        }}
      />

      {finalPages.length > 1 && (
        <View style={styles.pageIndicators}>
          {finalPages.map((_, index) => (
            <View key={`indicator-${index + 1}`} style={[styles.pageIndicator, index === activePage && styles.pageIndicatorActive]} />
          ))}
        </View>
      )}
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
    overflow: "hidden",
  },
  pageIndicators: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    position: "absolute",
    bottom: -10,
    alignSelf: "center",
    zIndex: 30,
  },
  pageIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "rgba(255,255,255,0.4)",
  },
  pageIndicatorActive: {
    width: 22,
    borderRadius: 4,
    backgroundColor: Theme.colors.primary,
  },
});
