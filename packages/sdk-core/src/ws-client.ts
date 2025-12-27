/**
 * WebSocket client for real-time events
 */

import { EventEmitter } from './events.ts';
import type { ChatMessage, ChalkError, Participant, Reaction } from './types.ts';

const DEFAULT_WS_URL = 'ws://localhost:8080/ws';
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000]; // Exponential backoff
const HEARTBEAT_INTERVAL = 30000;

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

interface WSEvents {
  connected: void;
  disconnected: { reason?: string };
  reconnecting: { attempt: number };
  error: ChalkError;
  'participant.joined': Participant;
  'participant.left': { participantId: string };
  'participant.updated': { participantId: string; changes: Partial<Participant> };
  'chat.message': ChatMessage;
  reaction: Reaction;
  'hand.raised': { participantId: string };
  'hand.lowered': { participantId: string };
  'recording.started': { recordingId: string };
  'recording.stopped': { recordingId: string; duration: number };
  'room.updated': { roomId: string; changes: Record<string, unknown> };
}

export class WSClient extends EventEmitter<WSEvents> {
  private ws: WebSocket | null = null;
  private readonly wsUrl: string;
  private token: string | null = null;
  private roomId: string | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly debug: boolean;

  constructor(wsUrl?: string, debug = false) {
    super();
    this.wsUrl = wsUrl ?? DEFAULT_WS_URL;
    this.debug = debug;
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[Chalk WS]', ...args);
    }
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  connect(token: string, roomId: string): void {
    if (this.state === 'connected' || this.state === 'connecting') {
      this.log('Already connected or connecting');
      return;
    }

    this.token = token;
    this.roomId = roomId;
    this.state = 'connecting';
    this.doConnect();
  }

  private doConnect(): void {
    if (!this.token || !this.roomId) return;

    const url = `${this.wsUrl}?token=${encodeURIComponent(this.token)}&room=${encodeURIComponent(this.roomId)}`;
    this.log('Connecting to', this.wsUrl);

    try {
      this.ws = new WebSocket(url);
      this.setupEventHandlers();
    } catch (error) {
      this.log('Connection error:', error);
      this.handleConnectionFailure();
    }
  }

  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.onopen = () => {
      this.log('Connected');
      this.state = 'connected';
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      this.emit('connected', undefined);
    };

    this.ws.onclose = (event) => {
      this.log('Disconnected:', event.code, event.reason);
      this.stopHeartbeat();

      if (this.state === 'connected') {
        // Unexpected disconnection - try to reconnect
        this.handleConnectionFailure();
      } else {
        this.state = 'disconnected';
        this.emit('disconnected', { reason: event.reason });
      }
    };

    this.ws.onerror = (event) => {
      this.log('WebSocket error:', event);
      this.emit('error', {
        code: 'WS_ERROR',
        message: 'WebSocket connection error',
      });
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);
      this.log('Received:', message.type);

      switch (message.type) {
        case 'participant.joined':
          this.emit('participant.joined', message.data);
          break;
        case 'participant.left':
          this.emit('participant.left', message.data);
          break;
        case 'participant.updated':
          this.emit('participant.updated', message.data);
          break;
        case 'chat.message':
          this.emit('chat.message', {
            ...message.data,
            timestamp: new Date(message.data.timestamp),
          });
          break;
        case 'reaction':
          this.emit('reaction', {
            ...message.data,
            timestamp: new Date(message.data.timestamp),
          });
          break;
        case 'hand.raised':
          this.emit('hand.raised', message.data);
          break;
        case 'hand.lowered':
          this.emit('hand.lowered', message.data);
          break;
        case 'recording.started':
          this.emit('recording.started', message.data);
          break;
        case 'recording.stopped':
          this.emit('recording.stopped', message.data);
          break;
        case 'room.updated':
          this.emit('room.updated', message.data);
          break;
        case 'pong':
          // Heartbeat response - ignore
          break;
        case 'error':
          this.emit('error', message.data);
          break;
        default:
          this.log('Unknown message type:', message.type);
      }
    } catch (error) {
      this.log('Failed to parse message:', error);
    }
  }

  private handleConnectionFailure(): void {
    this.stopHeartbeat();

    if (this.reconnectAttempt >= RECONNECT_DELAYS.length) {
      this.log('Max reconnect attempts reached');
      this.state = 'failed';
      this.emit('error', {
        code: 'MAX_RECONNECT_ATTEMPTS',
        message: 'Failed to reconnect after multiple attempts',
      });
      return;
    }

    this.state = 'reconnecting';
    const delay = RECONNECT_DELAYS[this.reconnectAttempt] ?? RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1]!;
    this.reconnectAttempt++;

    this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.emit('reconnecting', { attempt: this.reconnectAttempt });

    setTimeout(() => {
      if (this.state === 'reconnecting') {
        this.doConnect();
      }
    }, delay);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  send(message: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.log('Cannot send message - not connected');
    }
  }

  // Client-to-server actions
  sendChatMessage(content: string): void {
    this.send({ type: 'chat.send', data: { content } });
  }

  sendReaction(emoji: string): void {
    this.send({ type: 'reaction.send', data: { emoji } });
  }

  raiseHand(): void {
    this.send({ type: 'hand.raise', data: {} });
  }

  lowerHand(): void {
    this.send({ type: 'hand.lower', data: {} });
  }

  disconnect(): void {
    this.log('Disconnecting');
    this.state = 'disconnected';
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.token = null;
    this.roomId = null;
  }
}
