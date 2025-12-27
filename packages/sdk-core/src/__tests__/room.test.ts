/**
 * Tests for Room class
 * @module @chalk/core/__tests__/room
 */

import { describe, it, expect, beforeEach, mock, afterEach } from 'bun:test';
import { Room } from '../room.ts';
import { WSClient } from '../ws-client.ts';
import type { Participant, RoomInfo } from '../types.ts';

// Mock WSClient
const createMockWSClient = (): Partial<WSClient> => {
  const handlers = new Map<string, Function[]>();

  return {
    on: (event: string, handler: Function) => {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }
      handlers.get(event)!.push(handler);
      return () => {
        const list = handlers.get(event);
        if (list) {
          const index = list.indexOf(handler);
          if (index > -1) {
            list.splice(index, 1);
          }
        }
      };
    },
    emit: (event: string, data: any) => {
      const list = handlers.get(event);
      if (list) {
        list.forEach((handler) => handler(data));
      }
    },
    connect: mock(() => {}),
    disconnect: mock(() => {}),
    sendChatMessage: mock(() => {}),
    sendReaction: mock(() => {}),
    raiseHand: mock(() => {}),
    lowerHand: mock(() => {}),
    getHandlers: () => handlers,
  };
};

describe('Room', () => {
  let room: Room;
  let mockWSClient: any;

  beforeEach(() => {
    mockWSClient = createMockWSClient();
    room = new Room('room_123', mockWSClient as WSClient, false);
  });

  describe('initialization', () => {
    it('should initialize with correct id', () => {
      expect(room.id).toBe('room_123');
    });

    it('should start with disconnected status', () => {
      expect(room.status).toBe('disconnected');
    });

    it('should have empty participants initially', () => {
      expect(room.participants.size).toBe(0);
    });

    it('should have null info initially', () => {
      expect(room.info).toBeNull();
    });

    it('should have no local participant initially', () => {
      expect(room.localParticipant).toBeNull();
    });

    it('should have no active speaker initially', () => {
      expect(room.activeSpeaker).toBeNull();
    });

    it('should have empty messages initially', () => {
      expect(room.messages).toEqual([]);
    });

    it('should not be recording initially', () => {
      expect(room.isRecording).toBe(false);
    });
  });

  describe('_setStatus()', () => {
    it('should update status', () => {
      room._setStatus('connecting');
      expect(room.status).toBe('connecting');

      room._setStatus('connected');
      expect(room.status).toBe('connected');
    });

    it('should emit status-changed event', () => {
      let emittedStatus: any = null;

      room.on('status-changed', (status) => {
        emittedStatus = status;
      });

      room._setStatus('connected');
      expect(emittedStatus).toBe('connected');
    });

    it('should not emit if status unchanged', () => {
      let emitCount = 0;

      room.on('status-changed', () => {
        emitCount += 1;
      });

      room._setStatus('disconnected');
      room._setStatus('disconnected');

      expect(emitCount).toBe(0);
    });
  });

  describe('_setInfo()', () => {
    it('should set room info', () => {
      const info: RoomInfo = {
        id: 'room_123',
        name: 'Test Room',
        status: 'connected',
        participantCount: 2,
        config: {},
        createdAt: new Date(),
      };

      room._setInfo(info);
      expect(room.info).toEqual(info);
    });
  });

  describe('_setLocalParticipant()', () => {
    it('should set local participant', () => {
      const participant: Participant = {
        id: 'participant_1',
        displayName: 'Alice',
        role: 'participant',
        isLocal: true,
        videoEnabled: false,
        audioEnabled: false,
        isSpeaking: false,
        isScreenSharing: false,
        handRaised: false,
        connectionQuality: 100,
      };

      room._setLocalParticipant(participant);
      expect(room.localParticipant).toEqual(participant);
      expect(room.participants.get('participant_1')).toEqual(participant);
    });
  });

  describe('event handling - participant events', () => {
    it('should handle participant-joined event', () => {
      const participant: Participant = {
        id: 'participant_2',
        displayName: 'Bob',
        role: 'participant',
        isLocal: false,
        videoEnabled: true,
        audioEnabled: true,
        isSpeaking: false,
        isScreenSharing: false,
        handRaised: false,
        connectionQuality: 100,
      };

      let emittedParticipant: Participant | null = null;
      room.on('participant-joined', (p) => {
        emittedParticipant = p;
      });

      mockWSClient.emit('participant.joined', participant);

      expect(emittedParticipant).toEqual(participant);
      expect(room.participants.get('participant_2')).toEqual(participant);
    });

    it('should handle participant-left event', () => {
      const participant: Participant = {
        id: 'participant_2',
        displayName: 'Bob',
        role: 'participant',
        isLocal: false,
        videoEnabled: true,
        audioEnabled: true,
        isSpeaking: false,
        isScreenSharing: false,
        handRaised: false,
        connectionQuality: 100,
      };

      room._participants.set('participant_2', participant);

      let emittedId: string | null = null;
      room.on('participant-left', (id) => {
        emittedId = id;
      });

      mockWSClient.emit('participant.left', { participantId: 'participant_2' });

      expect(emittedId).toBe('participant_2');
      expect(room.participants.has('participant_2')).toBe(false);
    });

    it('should handle participant-updated event', () => {
      const participant: Participant = {
        id: 'participant_2',
        displayName: 'Bob',
        role: 'participant',
        isLocal: false,
        videoEnabled: true,
        audioEnabled: true,
        isSpeaking: false,
        isScreenSharing: false,
        handRaised: false,
        connectionQuality: 100,
      };

      room._participants.set('participant_2', participant);

      let emittedParticipant: Participant | null = null;
      room.on('participant-updated', (event) => {
        emittedParticipant = event.participant;
      });

      mockWSClient.emit('participant.updated', {
        participantId: 'participant_2',
        changes: { audioEnabled: false },
      });

      expect(emittedParticipant?.audioEnabled).toBe(false);
    });
  });

  describe('event handling - chat and reactions', () => {
    it('should handle chat-message event', () => {
      const message = {
        id: 'msg_1',
        senderId: 'participant_1',
        senderName: 'Alice',
        content: 'Hello!',
        timestamp: new Date(),
      };

      let emittedMessage: any = null;
      room.on('chat-message', (msg) => {
        emittedMessage = msg;
      });

      mockWSClient.emit('chat.message', message);

      expect(emittedMessage).toEqual(message);
      expect(room.messages).toContain(message);
    });

    it('should handle reaction event', () => {
      const reaction = {
        participantId: 'participant_1',
        participantName: 'Alice',
        emoji: '👍' as const,
        timestamp: new Date(),
      };

      let emittedReaction: any = null;
      room.on('reaction', (r) => {
        emittedReaction = r;
      });

      mockWSClient.emit('reaction', reaction);

      expect(emittedReaction).toEqual(reaction);
    });
  });

  describe('event handling - hand raise', () => {
    it('should handle hand-raised event', () => {
      const participant: Participant = {
        id: 'participant_2',
        displayName: 'Bob',
        role: 'participant',
        isLocal: false,
        videoEnabled: true,
        audioEnabled: true,
        isSpeaking: false,
        isScreenSharing: false,
        handRaised: false,
        connectionQuality: 100,
      };

      room._participants.set('participant_2', participant);

      let emittedId: string | null = null;
      room.on('hand-raised', (event) => {
        emittedId = event.participantId;
      });

      mockWSClient.emit('hand.raised', { participantId: 'participant_2' });

      expect(emittedId).toBe('participant_2');
      expect(room.participants.get('participant_2')?.handRaised).toBe(true);
    });

    it('should handle hand-lowered event', () => {
      const participant: Participant = {
        id: 'participant_2',
        displayName: 'Bob',
        role: 'participant',
        isLocal: false,
        videoEnabled: true,
        audioEnabled: true,
        isSpeaking: false,
        isScreenSharing: false,
        handRaised: true,
        connectionQuality: 100,
      };

      room._participants.set('participant_2', participant);

      let emittedId: string | null = null;
      room.on('hand-lowered', (event) => {
        emittedId = event.participantId;
      });

      mockWSClient.emit('hand.lowered', { participantId: 'participant_2' });

      expect(emittedId).toBe('participant_2');
      expect(room.participants.get('participant_2')?.handRaised).toBe(false);
    });
  });

  describe('event handling - recording', () => {
    it('should handle recording-started event', () => {
      let emittedEvent: any = null;
      room.on('recording-started', (event) => {
        emittedEvent = event;
      });

      mockWSClient.emit('recording.started', { recordingId: 'rec_123' });

      expect(emittedEvent.recordingId).toBe('rec_123');
      expect(room.isRecording).toBe(true);
    });

    it('should handle recording-stopped event', () => {
      room._currentRecording = { id: 'rec_123' };

      let emittedRecording: any = null;
      room.on('recording-stopped', (recording) => {
        emittedRecording = recording;
      });

      mockWSClient.emit('recording.stopped', { recordingId: 'rec_123', duration: 60 });

      expect(emittedRecording.id).toBe('rec_123');
      expect(emittedRecording.status).toBe('processing');
      expect(emittedRecording.durationSeconds).toBe(60);
      expect(room.isRecording).toBe(false);
    });
  });

  describe('event handling - connection', () => {
    it('should handle connected event', () => {
      room._setStatus('disconnected');

      mockWSClient.emit('connected');

      expect(room.status).toBe('connected');
    });

    it('should handle disconnected event', () => {
      room._setStatus('connected');

      mockWSClient.emit('disconnected');

      expect(room.status).toBe('disconnected');
    });

    it('should handle reconnecting event', () => {
      room._setStatus('connected');

      mockWSClient.emit('reconnecting');

      expect(room.status).toBe('reconnecting');
    });

    it('should handle error event', () => {
      const error = { code: 'NETWORK_ERROR', message: 'Connection failed' };

      let emittedError: any = null;
      room.on('error', (err) => {
        emittedError = err;
      });

      mockWSClient.emit('error', error);

      expect(emittedError).toEqual(error);
    });
  });

  describe('chat operations', () => {
    it('should send message via sendMessage', () => {
      room.sendMessage('Hello room!');

      expect(mockWSClient.sendChatMessage).toHaveBeenCalledWith('Hello room!');
    });

    it('should trim message content', () => {
      room.sendMessage('  Hello  ');

      expect(mockWSClient.sendChatMessage).toHaveBeenCalledWith('Hello');
    });

    it('should not send empty messages', () => {
      room.sendMessage('   ');

      expect(mockWSClient.sendChatMessage).not.toHaveBeenCalled();
    });
  });

  describe('reactions', () => {
    it('should send reaction', () => {
      room.sendReaction('👍');

      expect(mockWSClient.sendReaction).toHaveBeenCalledWith('👍');
    });
  });

  describe('hand raise operations', () => {
    it('should raise hand', () => {
      const participant: Participant = {
        id: 'participant_1',
        displayName: 'Alice',
        role: 'participant',
        isLocal: true,
        videoEnabled: false,
        audioEnabled: false,
        isSpeaking: false,
        isScreenSharing: false,
        handRaised: false,
        connectionQuality: 100,
      };

      room._setLocalParticipant(participant);
      room.raiseHand();

      expect(room.localParticipant?.handRaised).toBe(true);
      expect(mockWSClient.raiseHand).toHaveBeenCalled();
    });

    it('should lower hand', () => {
      const participant: Participant = {
        id: 'participant_1',
        displayName: 'Alice',
        role: 'participant',
        isLocal: true,
        videoEnabled: false,
        audioEnabled: false,
        isSpeaking: false,
        isScreenSharing: false,
        handRaised: true,
        connectionQuality: 100,
      };

      room._setLocalParticipant(participant);
      room.lowerHand();

      expect(room.localParticipant?.handRaised).toBe(false);
      expect(mockWSClient.lowerHand).toHaveBeenCalled();
    });
  });

  describe('leave()', () => {
    it('should disconnect from room', () => {
      const participant: Participant = {
        id: 'participant_1',
        displayName: 'Alice',
        role: 'participant',
        isLocal: true,
        videoEnabled: false,
        audioEnabled: false,
        isSpeaking: false,
        isScreenSharing: false,
        handRaised: false,
        connectionQuality: 100,
      };

      room._setLocalParticipant(participant);
      room._setStatus('connected');

      room.leave();

      expect(mockWSClient.disconnect).toHaveBeenCalled();
      expect(room.status).toBe('disconnected');
      expect(room.localParticipant).toBeNull();
      expect(room.participants.size).toBe(0);
      expect(room.messages).toEqual([]);
    });
  });

  describe('participants getter', () => {
    it('should return copy of participants map', () => {
      const participant: Participant = {
        id: 'participant_2',
        displayName: 'Bob',
        role: 'participant',
        isLocal: false,
        videoEnabled: true,
        audioEnabled: true,
        isSpeaking: false,
        isScreenSharing: false,
        handRaised: false,
        connectionQuality: 100,
      };

      room._participants.set('participant_2', participant);

      const participants = room.participants;

      expect(participants.get('participant_2')).toEqual(participant);
      expect(participants).not.toBe(room._participants);
    });
  });
});
