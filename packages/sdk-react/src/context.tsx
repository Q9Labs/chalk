/**
 * Chalk React Context
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import {
  ChalkClient,
  Room,
  type ChalkClientConfig,
  type RoomConfig,
  type RoomStatus,
} from '@chalk/core';

interface ChalkContextValue {
  client: ChalkClient | null;
  room: Room | null;
  isConnected: boolean;
  connectionStatus: RoomStatus;
  joinRoom: (roomId: string, config: RoomConfig) => Promise<Room>;
  leaveRoom: () => void;
  createRoom: (name?: string) => Promise<string>;
}

const ChalkContext = createContext<ChalkContextValue | null>(null);

export interface ChalkProviderProps {
  children: ReactNode;
  /** API key for Chalk (use for client-direct auth flow) */
  apiKey?: string;
  /** JWT token from your server (use for server-to-server auth flow) */
  token?: string;
  /** Custom API URL */
  apiUrl?: string;
  /** Custom WebSocket URL */
  wsUrl?: string;
  /** Enable debug logging */
  debug?: boolean;
}

export function ChalkProvider({
  children,
  apiKey,
  token,
  apiUrl,
  wsUrl,
  debug,
}: ChalkProviderProps) {
  const [client, setClient] = useState<ChalkClient | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<RoomStatus>('disconnected');

  // Initialize client
  useEffect(() => {
    if (!apiKey && !token) {
      console.warn('ChalkProvider: apiKey or token is required');
      return;
    }

    const config: ChalkClientConfig = {
      apiKey,
      token,
      apiUrl,
      wsUrl,
      debug,
    };

    const chalkClient = new ChalkClient(config);
    setClient(chalkClient);

    return () => {
      chalkClient.disconnect();
    };
  }, [apiKey, token, apiUrl, wsUrl, debug]);

  // Join room
  const joinRoom = useCallback(
    async (roomId: string, config: RoomConfig): Promise<Room> => {
      if (!client) {
        throw new Error('ChalkClient not initialized');
      }

      const newRoom = await client.joinRoom(roomId, config);
      setRoom(newRoom);

      // Listen for status changes
      newRoom.on('status-changed', (status) => {
        setConnectionStatus(status);
      });

      return newRoom;
    },
    [client]
  );

  // Leave room
  const leaveRoom = useCallback(() => {
    if (room) {
      room.leave();
      setRoom(null);
      setConnectionStatus('disconnected');
    }
  }, [room]);

  // Create room
  const createRoom = useCallback(
    async (name?: string): Promise<string> => {
      if (!client) {
        throw new Error('ChalkClient not initialized');
      }

      return client.createRoom(name);
    },
    [client]
  );

  const value = useMemo(
    () => ({
      client,
      room,
      isConnected: connectionStatus === 'connected',
      connectionStatus,
      joinRoom,
      leaveRoom,
      createRoom,
    }),
    [client, room, connectionStatus, joinRoom, leaveRoom, createRoom]
  );

  return <ChalkContext.Provider value={value}>{children}</ChalkContext.Provider>;
}

export function useChalk(): ChalkContextValue {
  const context = useContext(ChalkContext);
  if (!context) {
    throw new Error('useChalk must be used within a ChalkProvider');
  }
  return context;
}
