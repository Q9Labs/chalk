import React, { useEffect } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { usePermissions, useDevices, useLocalStream, VideoView } from "@q9labs/chalk-react-native";

interface PreCallScreenProps {
  roomId: string;
  onJoin: () => void;
  onBack: () => void;
}

export function PreCallScreen({ roomId, onJoin, onBack }: PreCallScreenProps) {
  const { permissions, hasRequiredPermissions, requestPermissions } = usePermissions();
  const { cameras, microphones, selectedCamera, selectedMicrophone } = useDevices();
  const { stream, isLoading, error, startStream, stopStream, isActive } = useLocalStream();

  const currentCamera = cameras.find((c) => c.deviceId === selectedCamera);
  const currentMicrophone = microphones.find((m) => m.deviceId === selectedMicrophone);

  // Start camera preview when rtcManager becomes available
  // Using startStream in deps ensures we retry when ChalkProvider finishes initializing
  useEffect(() => {
    if (!isActive && !isLoading && !error) {
      console.log("[PreCallScreen] Starting camera stream...");
      startStream({ video: true, audio: false });
    }
  }, [startStream]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopStream();
    };
  }, [stopStream]);

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.backButton} onPress={onBack}>
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>

      <Text style={styles.title}>Join Room</Text>
      <Text style={styles.roomId}>{roomId}</Text>

      <View style={styles.previewContainer}>
        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#fff" />
            <Text style={styles.loadingText}>Starting camera...</Text>
          </View>
        ) : error ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={() => startStream()}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : stream ? (
          <VideoView stream={stream as unknown as MediaStream} mirror={true} objectFit="cover" style={styles.videoPreview} />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>{hasRequiredPermissions ? "Initializing camera..." : "Grant permissions to preview"}</Text>
          </View>
        )}

        {/* Device info overlay */}
        <View style={styles.deviceOverlay}>
          <Text style={styles.deviceText}>📷 {currentCamera?.label || "Front Camera"}</Text>
          <Text style={styles.deviceText}>🎤 {currentMicrophone?.label || "Microphone"}</Text>
        </View>
      </View>

      <View style={styles.permissions}>
        <View style={styles.permissionRow}>
          <Text style={styles.permissionLabel}>Camera:</Text>
          <Text style={[styles.permissionValue, permissions.camera === "granted" && styles.permissionGranted, permissions.camera === "denied" && styles.permissionDenied]}>{permissions.camera || "unknown"}</Text>
        </View>
        <View style={styles.permissionRow}>
          <Text style={styles.permissionLabel}>Microphone:</Text>
          <Text style={[styles.permissionValue, permissions.microphone === "granted" && styles.permissionGranted, permissions.microphone === "denied" && styles.permissionDenied]}>{permissions.microphone || "unknown"}</Text>
        </View>
      </View>

      {!hasRequiredPermissions && (
        <TouchableOpacity style={styles.permissionButton} onPress={requestPermissions}>
          <Text style={styles.buttonText}>Grant Permissions</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={[styles.joinButton, !hasRequiredPermissions && styles.disabled]} onPress={onJoin} disabled={!hasRequiredPermissions}>
        <Text style={styles.buttonText}>Join Call</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    backgroundColor: "#0f0f0f",
  },
  backButton: {
    marginBottom: 16,
  },
  backText: {
    color: "#007AFF",
    fontSize: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#fff",
    marginBottom: 8,
  },
  roomId: {
    fontSize: 14,
    color: "rgba(255,255,255,0.5)",
    marginBottom: 24,
  },
  previewContainer: {
    flex: 1,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#1a1a1a",
    marginBottom: 24,
  },
  videoPreview: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    color: "rgba(255,255,255,0.6)",
    marginTop: 12,
  },
  errorContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  errorText: {
    color: "#FF3B30",
    textAlign: "center",
    marginBottom: 16,
  },
  retryButton: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 8,
  },
  retryText: {
    color: "#fff",
  },
  placeholder: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  placeholderText: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 14,
  },
  deviceOverlay: {
    position: "absolute",
    bottom: 12,
    left: 12,
    right: 12,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 8,
    padding: 8,
  },
  deviceText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 12,
  },
  permissions: {
    marginBottom: 16,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 8,
    padding: 12,
  },
  permissionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  permissionLabel: {
    fontSize: 14,
    color: "rgba(255,255,255,0.6)",
  },
  permissionValue: {
    fontSize: 14,
    color: "rgba(255,255,255,0.6)",
  },
  permissionGranted: {
    color: "#30D158",
  },
  permissionDenied: {
    color: "#FF3B30",
  },
  permissionButton: {
    height: 44,
    backgroundColor: "#FF9500",
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },
  joinButton: {
    height: 50,
    backgroundColor: "#34C759",
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  disabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});
