import React, {useEffect, useState, useMemo} from 'react';
import {View, Text, TouchableOpacity, StyleSheet, Animated, ScrollView} from 'react-native';
import {
  useChalk,
  useRoom,
  useMedia,
  useParticipants,
  useInteractions,
  useLocalStream,
  VideoView,
  ParticipantTile,
  type ReactionEmoji,
} from '@q9labs/chalk-react-native';
import type {Participant} from '@q9labs/chalk-core';

interface CallScreenProps {
  roomId: string;
  onLeave: () => void;
}

// Helper to chunk array into rows
function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

// Simple icon components using styled text
function MicIcon({muted}: {muted: boolean}) {
  return (
    <View style={iconStyles.container}>
      <View style={[iconStyles.micBody, muted && iconStyles.muted]} />
      <View style={[iconStyles.micStand, muted && iconStyles.muted]} />
      {muted && <View style={iconStyles.slash} />}
    </View>
  );
}

function CamIcon({off}: {off: boolean}) {
  return (
    <View style={iconStyles.container}>
      <View style={[iconStyles.camBody, off && iconStyles.muted]} />
      <View style={[iconStyles.camLens, off && iconStyles.muted]} />
      {off && <View style={iconStyles.slash} />}
    </View>
  );
}

function HandIcon({raised}: {raised: boolean}) {
  return (
    <Text style={[iconStyles.handText, raised && iconStyles.handRaised]}>
      ✋
    </Text>
  );
}

function EndCallIcon() {
  return (
    <View style={iconStyles.phoneContainer}>
      <View style={iconStyles.phoneBody} />
    </View>
  );
}

function SwitchCameraIcon() {
  return (
    <View style={iconStyles.switchContainer}>
      <Text style={iconStyles.switchText}>🔄</Text>
    </View>
  );
}

// Floating reaction component
function FloatingReaction({emoji, onComplete}: {emoji: string; onComplete: () => void}) {
  const [animation] = useState(new Animated.Value(0));

  useEffect(() => {
    Animated.timing(animation, {
      toValue: 1,
      duration: 2000,
      useNativeDriver: true,
    }).start(() => onComplete());
  }, [animation, onComplete]);

  const translateY = animation.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -200],
  });

  const opacity = animation.interpolate({
    inputRange: [0, 0.7, 1],
    outputRange: [1, 1, 0],
  });

  const scale = animation.interpolate({
    inputRange: [0, 0.2, 1],
    outputRange: [0.5, 1.2, 1],
  });

  return (
    <Animated.View
      style={[
        styles.floatingReaction,
        {transform: [{translateY}, {scale}], opacity},
      ]}>
      <Text style={styles.floatingEmoji}>{emoji}</Text>
    </Animated.View>
  );
}

export function CallScreen({roomId, onLeave}: CallScreenProps) {
  const {leaveRoom, rtcManager, joinRoom} = useChalk();
  const {room, isConnected, status} = useRoom();
  const {isVideoEnabled, isAudioEnabled, toggleVideo, toggleAudio} = useMedia();
  const {participants, localParticipant, remoteParticipants} = useParticipants();
  const {isHandRaised, toggleHand, sendReaction, activeReactions} = useInteractions();
  const {stream, startStream, isActive} = useLocalStream();
  const [floatingReactions, setFloatingReactions] = useState<{id: string; emoji: string}[]>([]);

  // Build local participant with stream for video grid
  const localWithStream = useMemo<Participant | null>(() => {
    if (!localParticipant) return null;
    return {
      ...localParticipant,
      videoEnabled: isVideoEnabled,
      audioEnabled: isAudioEnabled,
      // Create a video track from local stream if available
      videoTrack: stream?.getVideoTracks()[0] ?? null,
      audioTrack: stream?.getAudioTracks()[0] ?? null,
    };
  }, [localParticipant, isVideoEnabled, isAudioEnabled, stream]);

  // Combined participants for grid (local first, then remotes)
  const allParticipants = useMemo<Participant[]>(() => {
    const list: Participant[] = [];
    if (localWithStream) list.push(localWithStream);
    list.push(...remoteParticipants);
    return list;
  }, [localWithStream, remoteParticipants]);

  // Join the room when component mounts
  useEffect(() => {
    if (!room) {
      joinRoom(roomId, {displayName: 'Mobile User'});
    }
  }, [roomId, room, joinRoom]);

  // Start local stream when entering call
  useEffect(() => {
    if (!isActive) {
      startStream({video: true, audio: true});
    }
  }, [isActive, startStream]);

  // Show floating reactions when new ones come in
  useEffect(() => {
    if (activeReactions.length > 0) {
      const latest = activeReactions[activeReactions.length - 1];
      setFloatingReactions(prev => [...prev, {id: latest.id, emoji: latest.emoji}]);
    }
  }, [activeReactions]);

  const removeFloatingReaction = (id: string) => {
    setFloatingReactions(prev => prev.filter(r => r.id !== id));
  };

  const handleLeave = async () => {
    await leaveRoom();
    onLeave();
  };

  const handleSwitchCamera = async () => {
    if (rtcManager) {
      try {
        await rtcManager.switchCamera();
      } catch (e) {
        // Ignore switch camera errors
      }
    }
  };

  const REACTIONS: {emoji: ReactionEmoji; label: string}[] = [
    {emoji: '👍', label: 'Like'},
    {emoji: '❤️', label: 'Love'},
    {emoji: '😂', label: 'Laugh'},
    {emoji: '🎉', label: 'Celebrate'},
    {emoji: '🤔', label: 'Think'},
  ];

  // Derive status text from connection state
  const getStatusText = () => {
    if (isConnected) return 'Live';
    if (status === 'connecting') return 'Connecting';
    if (status === 'disconnected') return 'Demo Mode';
    return status || 'Demo Mode';
  };

  return (
    <View style={styles.container}>
      {/* Floating Reactions */}
      <View style={styles.floatingContainer}>
        {floatingReactions.map(reaction => (
          <FloatingReaction
            key={reaction.id}
            emoji={reaction.emoji}
            onComplete={() => removeFloatingReaction(reaction.id)}
          />
        ))}
      </View>

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.roomLabel}>ROOM</Text>
          <Text style={styles.roomName} numberOfLines={1}>
            {roomId.replace('test-', '')}
          </Text>
        </View>
        <View style={styles.statusBadge}>
          <View style={[styles.statusDot, isConnected && styles.statusConnected]} />
          <Text style={styles.statusText}>{getStatusText()}</Text>
        </View>
      </View>

      {/* Video Grid Area */}
      <View style={styles.videoGrid}>
        {/* Participant count badge */}
        <View style={styles.participantBadge}>
          <Text style={styles.participantCount}>{allParticipants.length}</Text>
          <Text style={styles.participantLabel}>
            {allParticipants.length === 1 ? 'participant' : 'participants'}
          </Text>
        </View>

        {/* Video tiles for all participants */}
        {allParticipants.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>Waiting for participants...</Text>
          </View>
        ) : allParticipants.length === 1 ? (
          // Single participant - full screen
          <View style={styles.singleTile}>
            <ParticipantTile
              participant={allParticipants[0]!}
              mirror={allParticipants[0]?.isLocal}
              style={styles.fullTile}
            />
            {/* Switch camera button for local video */}
            {allParticipants[0]?.isLocal && (
              <TouchableOpacity
                style={styles.switchCameraButton}
                onPress={handleSwitchCamera}
                activeOpacity={0.7}>
                <SwitchCameraIcon />
              </TouchableOpacity>
            )}
          </View>
        ) : allParticipants.length <= 4 ? (
          // 2-4 participants - 2x2 grid
          <View style={styles.gridContainer}>
            <View style={styles.gridRow}>
              {allParticipants.slice(0, 2).map((p) => (
                <ParticipantTile
                  key={p.id}
                  participant={p}
                  mirror={p.isLocal}
                  style={styles.gridTile}
                />
              ))}
            </View>
            {allParticipants.length > 2 && (
              <View style={styles.gridRow}>
                {allParticipants.slice(2, 4).map((p) => (
                  <ParticipantTile
                    key={p.id}
                    participant={p}
                    mirror={p.isLocal}
                    style={styles.gridTile}
                  />
                ))}
              </View>
            )}
          </View>
        ) : (
          // 5+ participants - scrollable grid
          <ScrollView style={styles.scrollGrid} contentContainerStyle={styles.scrollContent}>
            {chunk(allParticipants, 2).map((row, i) => (
              <View key={i} style={styles.gridRow}>
                {row.map((p) => (
                  <ParticipantTile
                    key={p.id}
                    participant={p}
                    mirror={p.isLocal}
                    style={styles.scrollTile}
                  />
                ))}
              </View>
            ))}
          </ScrollView>
        )}
      </View>

      {/* Quick Reactions Bar */}
      <View style={styles.reactionsBar}>
        <Text style={styles.reactionsLabel}>React</Text>
        <View style={styles.reactionsRow}>
          {REACTIONS.map(({emoji}) => (
            <TouchableOpacity
              key={emoji}
              style={styles.reactionButton}
              onPress={() => sendReaction(emoji)}
              activeOpacity={0.7}>
              <Text style={styles.reactionEmoji}>{emoji}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Control Bar */}
      <View style={styles.controlBar}>
        <TouchableOpacity
          style={[styles.controlButton, !isAudioEnabled && styles.controlOff]}
          onPress={toggleAudio}
          activeOpacity={0.8}>
          <MicIcon muted={!isAudioEnabled} />
          <Text style={styles.controlLabel}>
            {isAudioEnabled ? 'Mute' : 'Unmute'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.controlButton, !isVideoEnabled && styles.controlOff]}
          onPress={toggleVideo}
          activeOpacity={0.8}>
          <CamIcon off={!isVideoEnabled} />
          <Text style={styles.controlLabel}>
            {isVideoEnabled ? 'Stop' : 'Start'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.controlButton, isHandRaised && styles.controlActive]}
          onPress={toggleHand}
          activeOpacity={0.8}>
          <HandIcon raised={isHandRaised} />
          <Text style={styles.controlLabel}>
            {isHandRaised ? 'Lower' : 'Raise'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.endCallButton}
          onPress={handleLeave}
          activeOpacity={0.8}>
          <EndCallIcon />
          <Text style={styles.endCallLabel}>Leave</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const iconStyles = StyleSheet.create({
  container: {
    width: 28,
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
  micBody: {
    width: 10,
    height: 16,
    backgroundColor: '#fff',
    borderRadius: 5,
  },
  micStand: {
    width: 14,
    height: 3,
    backgroundColor: '#fff',
    borderRadius: 1.5,
    marginTop: 2,
  },
  camBody: {
    width: 20,
    height: 14,
    backgroundColor: '#fff',
    borderRadius: 3,
  },
  camLens: {
    position: 'absolute',
    right: 0,
    width: 8,
    height: 8,
    backgroundColor: '#fff',
    borderRadius: 2,
    transform: [{translateX: 4}],
  },
  muted: {
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  slash: {
    position: 'absolute',
    width: 2,
    height: 32,
    backgroundColor: '#FF3B30',
    transform: [{rotate: '45deg'}],
  },
  handText: {
    fontSize: 24,
    opacity: 0.8,
  },
  handRaised: {
    opacity: 1,
  },
  phoneContainer: {
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  phoneBody: {
    width: 20,
    height: 8,
    backgroundColor: '#fff',
    borderRadius: 4,
    transform: [{rotate: '135deg'}],
  },
  switchContainer: {
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  switchText: {
    fontSize: 16,
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f0f',
  },
  floatingContainer: {
    position: 'absolute',
    bottom: 200,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 100,
  },
  floatingReaction: {
    position: 'absolute',
  },
  floatingEmoji: {
    fontSize: 48,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  headerLeft: {
    flex: 1,
  },
  roomLabel: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    marginBottom: 2,
  },
  roomName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FF9500',
    marginRight: 6,
  },
  statusConnected: {
    backgroundColor: '#30D158',
  },
  statusText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    fontWeight: '500',
  },
  videoGrid: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 16,
  },
  singleTile: {
    flex: 1,
    width: '100%',
    position: 'relative',
  },
  fullTile: {
    flex: 1,
    borderRadius: 16,
  },
  gridContainer: {
    flex: 1,
    width: '100%',
    gap: 8,
  },
  gridRow: {
    flex: 1,
    flexDirection: 'row',
    gap: 8,
  },
  gridTile: {
    flex: 1,
    borderRadius: 12,
  },
  scrollGrid: {
    flex: 1,
    width: '100%',
  },
  scrollContent: {
    gap: 8,
    paddingBottom: 16,
  },
  scrollTile: {
    flex: 1,
    height: 180,
    borderRadius: 12,
  },
  localVideoContainer: {
    flex: 1,
    width: '100%',
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#1a1a1a',
  },
  localVideo: {
    flex: 1,
  },
  localVideoLabel: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  localVideoText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
  },
  switchCameraButton: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoOff: {
    flex: 1,
    width: '100%',
    borderRadius: 16,
    backgroundColor: '#1a1a1a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  avatarText: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '600',
  },
  videoOffText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 14,
  },
  participantBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    zIndex: 10,
  },
  participantCount: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  participantLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
  },
  reactionsBar: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  reactionsLabel: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: 10,
    textAlign: 'center',
  },
  reactionsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  reactionButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  reactionEmoji: {
    fontSize: 22,
  },
  controlBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingVertical: 20,
    paddingBottom: 44,
    gap: 20,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  controlButton: {
    alignItems: 'center',
    width: 64,
  },
  controlOff: {},
  controlActive: {},
  controlLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 11,
    marginTop: 6,
    fontWeight: '500',
  },
  endCallButton: {
    alignItems: 'center',
    width: 64,
  },
  endCallLabel: {
    color: '#FF3B30',
    fontSize: 11,
    marginTop: 6,
    fontWeight: '600',
  },
});
