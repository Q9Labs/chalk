import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { FlatList, StyleSheet, Text, View, useWindowDimensions, type DimensionValue } from "react-native";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Theme } from "../../ui/theme";
import { NativeMediaView } from "../NativeMediaView";
import type { RoomParticipant } from "./types";
import { createNativeMeetingPageStore, type NativeMeetingPageStore } from "./native-meeting-page-store";
import { nativeMeetingGridKey } from "./native-meeting-grid-keys";

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

export function NativeMeetingGridMacos({ participants, gridPages }: NativeMeetingGridProps): React.JSX.Element {
  const { width, height } = useWindowDimensions();
  const isTablet = width >= 768;
  const pageStoreRef = useRef<NativeMeetingPageStore | null>(null);
  const pageStore = pageStoreRef.current ?? (pageStoreRef.current = createNativeMeetingPageStore());

  const finalPages = useMemo(() => {
    if (!isTablet) {
      return gridPages;
    }

    const perPage = 6;
    const pages: RoomParticipant[][] = [];
    for (let index = 0; index < participants.length; index += perPage) {
      pages.push(participants.slice(index, index + perPage));
    }
    return pages;
  }, [gridPages, isTablet, participants]);

  const requestedPage = useSyncExternalStore(pageStore.subscribe, pageStore.getSnapshot, pageStore.getSnapshot);
  const activePage = Math.min(requestedPage, Math.max(0, finalPages.length - 1));
  const activePageKey = nativeMeetingGridKey("indicator", finalPages[activePage] ?? []);
  const clampPageRef = useCallback(
    (node: View | null) => {
      if (node !== null) {
        pageStore.clampToPageCount(finalPages.length);
      }
    },
    [finalPages.length, pageStore],
  );

  if (participants.length === 0) {
    return (
      <View ref={clampPageRef} style={styles.emptyState}>
        <Text style={styles.emptyEyebrow}>Meeting ready</Text>
        <Text style={styles.emptyTitle}>You're the first one here</Text>
        <Text style={styles.emptyCopy}>Others will appear when they join. Invite someone to get started.</Text>
      </View>
    );
  }

  if (participants.length === 1) {
    return (
      <View ref={clampPageRef} style={styles.singleTile}>
        <ParticipantTile participant={participants[0]!} />
      </View>
    );
  }

  if (!isTablet && participants.length <= 4) {
    if (participants.length === 2) {
      return (
        <View ref={clampPageRef} style={styles.compactTwoUp}>
          {participants.map((participant) => (
            <ParticipantTile key={participant.id} participant={participant} />
          ))}
        </View>
      );
    }

    if (participants.length === 3) {
      return (
        <View ref={clampPageRef} style={styles.compactThree}>
          <View style={styles.compactThreeTop}>
            <ParticipantTile participant={participants[0]!} />
          </View>
          <View style={styles.compactThreeBottom}>
            <ParticipantTile participant={participants[1]!} />
            <ParticipantTile participant={participants[2]!} />
          </View>
        </View>
      );
    }

    if (participants.length === 4) {
      return (
        <View ref={clampPageRef} style={styles.compactFour}>
          <View style={styles.gridRow}>
            <ParticipantTile participant={participants[0]!} />
            <ParticipantTile participant={participants[1]!} />
          </View>
          <View style={styles.gridRow}>
            <ParticipantTile participant={participants[2]!} />
            <ParticipantTile participant={participants[3]!} />
          </View>
        </View>
      );
    }
  }

  return (
    <View ref={clampPageRef} style={styles.pagedContainer}>
      <FlatList
        data={finalPages}
        horizontal
        keyExtractor={(page) => nativeMeetingGridKey("page", page)}
        onMomentumScrollEnd={(event) => {
          const measuredPageWidth = Math.max(1, event.nativeEvent.layoutMeasurement.width);
          pageStore.setPage(Math.round(event.nativeEvent.contentOffset.x / measuredPageWidth));
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
          const columns = isTablet ? (width > height ? 3 : 2) : 2;
          const rows = buildWideParticipantRows(page, columns);

          return (
            <View style={[styles.page, { width }]}>
              <View style={styles.gridContainer}>
                {rows.map((row) => (
                  <View key={nativeMeetingGridKey("row", row)} style={styles.gridRow}>
                    {row.map((participant) => (
                      <ParticipantTile key={participant.id} participant={participant} />
                    ))}
                    {row.length < columns && Array.from({ length: columns - row.length }, (_, fillerSlot) => fillerSlot + row.length).map((slot) => <View key={nativeMeetingGridKey(`filler-${slot}`, row)} style={[styles.gridTile, { backgroundColor: "transparent" }]} />)}
                  </View>
                ))}
                {isTablet && rows.length < (width > height ? 2 : 3) ? <View style={{ flex: (width > height ? 2 : 3) - rows.length }} /> : null}
              </View>
            </View>
          );
        }}
      />

      {finalPages.length > 1 ? (
        <View style={styles.pageIndicators}>
          {finalPages.map((page) => (
            <View key={nativeMeetingGridKey("indicator", page)} style={[styles.pageIndicator, nativeMeetingGridKey("indicator", page) === activePageKey && styles.pageIndicatorActive]} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ParticipantTile({ participant, width, height }: { participant: RoomParticipant; width?: DimensionValue; height?: DimensionValue }) {
  return (
    <View style={[styles.tile, width !== undefined && { width }, height !== undefined && { height }]}>
      <NativeMediaView participant={participant} track={participant.videoTrack ?? null} />
      <View style={styles.identityPuck}>
        <Text style={styles.participantName} numberOfLines={1}>
          {participant.displayName || "Participant"}
        </Text>
        {!participant.audioEnabled && (
          <View style={styles.muteDot}>
            <HugeiconsIcon icon={MicOff01Icon} size={10} color="white" />
          </View>
        )}
      </View>
    </View>
  );
}

export { NativeMeetingGridMacos as NativeMeetingGrid };

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
  tile: {
    borderRadius: 32,
    overflow: "hidden",
    backgroundColor: "#0d0d0f",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    flex: 1,
  },
  identityPuck: {
    position: "absolute",
    left: 16,
    bottom: 16,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(10, 10, 12, 0.82)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  participantName: {
    color: "white",
    fontSize: 13,
    fontWeight: "800",
    maxWidth: 140,
  },
  muteDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Theme.colors.error,
    alignItems: "center",
    justifyContent: "center",
  },
});
