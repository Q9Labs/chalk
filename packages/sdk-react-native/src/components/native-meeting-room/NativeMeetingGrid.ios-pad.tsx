import React, { useEffect, useMemo } from "react";
import { FlatList, StyleSheet, Text, View, useWindowDimensions, LayoutAnimation, type DimensionValue } from "react-native";
import { Theme } from "../../ui/theme";
import { NativeMediaView } from "../NativeMediaView";
import type { RoomParticipant } from "./types";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";

export interface NativeMeetingGridProps {
  participants: readonly RoomParticipant[];
  gridPages?: readonly (readonly RoomParticipant[])[]; 
}

export function NativeMeetingGridIosPad({ participants }: NativeMeetingGridProps): React.JSX.Element {
  const { width, height } = useWindowDimensions();
  
  // Adaptive Mesh Constants
  const GAP = 16;
  const TOP_BAR_H = 40; 
  const BOTTOM_DOCK_H = 150; // Increased to create a visual channel above the bezel-locked dock
  const containerWidth = width - 40; 
  const containerHeight = height - TOP_BAR_H - BOTTOM_DOCK_H;

  const count = participants.length;

  const layout = useMemo(() => {
    if (count === 0) return { cols: 1, rows: 1 };
    if (count === 1) return { cols: 1, rows: 1 };
    if (count === 2) return { cols: 2, rows: 1 };
    if (count === 3 || count === 4) return { cols: 2, rows: 2 };
    
    // Geometric Optimization for 5+
    const cols = Math.ceil(Math.sqrt(count * (containerWidth / containerHeight)));
    const rows = Math.ceil(count / cols);
    return { cols, rows };
  }, [count, containerWidth, containerHeight]);

  const tileWidth = (containerWidth - (layout.cols - 1) * GAP) / layout.cols;
  let tileHeight = (containerHeight - (layout.rows - 1) * GAP) / layout.rows;
  
  // Continuous Scroll Threshold
  const isScrollEnabled = tileHeight < 160 && count > 4;
  if (isScrollEnabled) {
    tileHeight = 180; // Stable minimum height for scrolling state
  }

  useEffect(() => {
    LayoutAnimation.configureNext({
      duration: 250,
      update: { type: LayoutAnimation.Types.spring, springDamping: 0.8 },
    });
  }, [count]);

  if (count === 0) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyEyebrow}>Meeting ready</Text>
        <Text style={styles.emptyTitle}>You're the first one here</Text>
        <Text style={styles.emptyCopy}>Invite others to join the space.</Text>
      </View>
    );
  }

  if (count === 3) {
    return (
      <View style={styles.meshContainer}>
        <View style={styles.meshContentFlat}>
          <View style={styles.trioTop}>
            {participants.slice(0, 2).map((p, i) => (
              <ParticipantTile key={`${p.id}-${i}`} participant={p} width={(containerWidth - GAP) / 2} height="100%" />
            ))}
          </View>
          <View style={styles.trioBottom}>
            <ParticipantTile key={`${participants[2]!.id}-2`} participant={participants[2]!} width={containerWidth} height="100%" />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.meshContainer}>
      <FlatList
        data={participants}
        numColumns={layout.cols}
        key={`${layout.cols}-${isScrollEnabled}`}
        scrollEnabled={isScrollEnabled}
        contentContainerStyle={[
          styles.meshContent,
          !isScrollEnabled && { flex: 1, justifyContent: "center" }
        ]}
        columnWrapperStyle={layout.cols > 1 ? styles.meshRow : undefined}
        showsVerticalScrollIndicator={false}
        renderItem={({ item: participant, index }) => (
          <ParticipantTile 
            key={`${participant.id}-${index}`}
            participant={participant} 
            width={tileWidth} 
            height={tileHeight} 
          />
        )}
        keyExtractor={(item, index) => `${item.id}-${index}`}
      />
    </View>
  );
}

function ParticipantTile({ participant, width, height }: { participant: RoomParticipant; width: DimensionValue; height: DimensionValue }) {
  return (
    <View style={[styles.tile, { width, height }]}>
      <NativeMediaView 
        emphasizeMuted 
        participant={participant} 
        track={participant.videoTrack ?? null} 
      />
      {/* Pinned Identity Puck */}
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

const styles = StyleSheet.create({
  meshContainer: {
    flex: 1,
  },
  meshContent: {
    gap: 16,
    paddingHorizontal: 20,
    paddingTop: 40, 
    paddingBottom: 40, // Balanced vertical buffer
  },
  meshContentFlat: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 40,
    paddingBottom: 40, // Balanced vertical buffer
    gap: 16,
  },
  meshRow: {
    gap: 16,
  },
  trioTop: {
    flex: 1,
    flexDirection: "row",
    gap: 16,
    justifyContent: "center",
  },
  trioBottom: {
    flex: 1,
    alignItems: "center",
  },
  tile: {
    borderRadius: 32,
    overflow: "hidden",
    backgroundColor: "#0d0d0f",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
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
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  emptyEyebrow: {
    color: Theme.colors.primary,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 2,
  },
  emptyTitle: {
    color: "white",
    fontSize: 28,
    fontWeight: "800",
  },
  emptyCopy: {
    color: Theme.colors.mutedForeground,
    fontSize: 16,
    textAlign: "center",
  },
});
