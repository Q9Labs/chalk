# Chalk SDK Test Guide

## Quick Start

### Run All Tests
```bash
cd packages/sdk-core && bun test
cd packages/sdk-react && bun test
```

### Type Check
```bash
cd packages/sdk-core && bun run check-types
cd packages/sdk-react && bun run check-types
```

## @chalk/core Test Files

### 1. `src/__tests__/types.test.ts`

Tests the type system and error handling patterns.

**What it tests:**
- `ok()` and `err()` helper functions
- Result type discriminated unions
- ChalkErrorCode enum values
- ChalkError interface structure
- Type-safe error handling patterns

**Key test cases:**
```typescript
// ok() creates successful results
const result = ok('success');
expect(result.ok).toBe(true);
expect(result.value).toBe('success');

// err() creates error results
const result = err({
  code: ChalkErrorCode.CAMERA_ACCESS_DENIED,
  message: 'Camera access was denied'
});
expect(result.ok).toBe(false);

// Pattern matching works correctly
if (result.ok) {
  const value = result.value; // Types as string
} else {
  const error = result.error; // Types as ChalkError
}
```

**Coverage:**
- Result type creation and discrimination
- All ChalkErrorCode enum values
- Error details field
- Type safety with discriminated unions

---

### 2. `src/__tests__/events.test.ts`

Tests the EventEmitter class for pub/sub functionality.

**What it tests:**
- Event handler registration and unsubscription
- Multiple handlers per event
- Event emission with data propagation
- Error handling in handlers
- Listener cleanup

**Key test cases:**
```typescript
// Register handlers
const unsubscribe = emitter.on('event-1', (data) => {
  console.log(data);
});

// Emit events
emitter.emit('event-1', 'value');

// Unsubscribe
unsubscribe();

// Remove all listeners for specific event
emitter.removeAllListeners('event-1');

// Or all listeners
emitter.removeAllListeners();
```

**Coverage:**
- Handler registration/removal
- Multiple handler support
- Unsubscribe function pattern
- Error resilience
- Event isolation
- Cleanup patterns

---

### 3. `src/__tests__/room.test.ts`

Tests the Room class for room state management and event handling.

**What it tests:**
- Room initialization and state
- Event propagation from WSClient
- Participant lifecycle (join/leave/update)
- Chat and reaction handling
- Hand raise functionality
- Recording state management
- Connection status changes

**Key test cases:**
```typescript
// Room starts in disconnected state
const room = new Room('room_123', mockWSClient);
expect(room.status).toBe('disconnected');

// Handle participant join
mockWSClient.emit('participant.joined', participant);
expect(room.participants.has(participant.id)).toBe(true);

// Handle chat messages
mockWSClient.emit('chat.message', message);
expect(room.messages).toContain(message);

// Status changes propagate
room.on('status-changed', (status) => {
  console.log('New status:', status);
});
```

**Coverage:**
- Room state initialization
- All event types (participant, chat, reaction, recording, connection)
- Internal state mutations
- Event emission to listeners
- Media track management
- Room cleanup on leave

---

### 4. `src/__tests__/client.test.ts`

Tests the ChalkClient for initialization and configuration.

**What it tests:**
- Client initialization with apiKey or token
- Configuration validation
- Custom API/WS URLs
- Debug flag handling
- Connection status properties
- Type safety

**Key test cases:**
```typescript
// Initialize with API key
const client = new ChalkClient({
  apiKey: 'ck_live_xxx'
});

// Or with token
const client = new ChalkClient({
  token: 'eyJhbGc...'
});

// Custom configuration
const client = new ChalkClient({
  apiKey: 'ck_live_xxx',
  apiUrl: 'https://custom.api.com',
  wsUrl: 'wss://custom.ws.com',
  debug: true
});

// Check connection status
expect(client.isConnected).toBe(false);
expect(client.connectionStatus).toBe('disconnected');
```

**Coverage:**
- Required configuration validation
- Optional URL overrides
- Debug flag handling
- Connection status properties
- Error messages for missing auth

---

## @chalk/react Test Files

### 1. `src/__tests__/context.test.tsx`

Tests the ChalkProvider context and useChalk hook setup.

**What it tests:**
- Provider props validation
- Context value structure
- Hook error messages
- Authentication method support
- Type safety

**Key test cases:**
```typescript
// Provider with API key
<ChalkProvider
  apiKey="ck_live_xxx"
  debug={true}
>
  {children}
</ChalkProvider>

// useChalk hook
const {
  client,
  room,
  isConnected,
  connectionStatus,
  joinRoom,
  leaveRoom,
  createRoom
} = useChalk();

// Must be used within provider
// throws: "useChalk must be used within a ChalkProvider"
```

**Coverage:**
- Provider prop validation
- Context initialization
- Authentication modes (apiKey/token)
- Custom endpoints
- Debug mode
- Hook error handling

---

### 2. `src/__tests__/hooks.test.ts`

Tests all 6 custom React hooks for return types and state management patterns.

**What it tests:**

#### useRoom
- Room reference and info
- Connection status
- Recording state

#### useParticipants
- Participant list management
- Local participant reference
- Active speaker tracking
- Participant count

#### useMedia
- Video/audio enabled state
- Screen share state
- Toggle callbacks

#### useChat
- Message list
- Send message callback

#### useRecording
- Recording state
- Recording ID
- Duration tracking
- Error handling

#### useDevices
- Device enumeration
- Device filtering by kind
- Device selection
- Loading state

**Key test cases:**
```typescript
// useRoom
const {
  room,
  roomInfo,
  isConnected,
  status,
  isRecording
} = useRoom();

// useParticipants
const {
  participants,
  localParticipant,
  activeSpeaker,
  participantCount
} = useParticipants();

// useMedia
const {
  isVideoEnabled,
  isAudioEnabled,
  isScreenSharing,
  toggleVideo,
  toggleAudio,
  startScreenShare,
  stopScreenShare
} = useMedia();

// useChat
const {
  messages,
  sendMessage
} = useChat();

// useRecording
const {
  isRecording,
  recordingId,
  durationSeconds,
  startRecording,
  stopRecording,
  error
} = useRecording();

// useDevices
const {
  devices,
  cameras,
  microphones,
  speakers,
  selectedCamera,
  selectedMicrophone,
  selectCamera,
  selectMicrophone,
  refreshDevices,
  isLoading
} = useDevices();
```

**Coverage:**
- All hook return types
- State type validation
- Callback function types
- Device filtering logic
- Status enum values
- Error object structure
- Optional/nullable fields

---

### 3. `src/__tests__/components.test.tsx`

Tests the VideoTile component props and composition patterns.

**What it tests:**
- Required participant prop
- Optional props (className, style, mirror)
- Display control props (showName, showStatus)
- Custom render functions
- Video ready callback
- Accessibility features

**Key test cases:**
```typescript
// Basic usage
<VideoTile participant={participant} />

// With display options
<VideoTile
  participant={participant}
  showName={true}
  showStatus={true}
  mirror={true}
/>

// Custom renders
<VideoTile
  participant={participant}
  renderName={(p) => `${p.displayName} (${p.role})`}
  renderStatus={(p) => p.videoEnabled ? '📹' : '📵'}
/>

// Video element callback
<VideoTile
  participant={participant}
  onVideoReady={(video) => {
    video.play();
  }}
/>
```

**Coverage:**
- All props and their types
- Prop combinations
- Participant states (video off, muted, speaking, etc.)
- Local vs remote participants
- Role types (host/participant)
- Custom render function patterns
- Composition in grid layouts
- Data attributes for testing
- ARIA label support

---

## Test Organization Patterns

### Mock Strategy

**EventEmitter Mocking:**
```typescript
const mockWSClient = {
  on: (event, handler) => { /* track handlers */ },
  emit: (event, data) => { /* call handlers */ },
  handlers: new Map()
};
```

**No Browser Mocking:**
- Tests don't mock navigator.mediaDevices
- No WebRTC mock implementation
- Integration tests handle browser APIs
- Unit tests focus on logic

### Test Isolation

- Each test has fresh EventEmitter/Room instance
- No shared state between tests
- Mocks are created fresh in beforeEach()
- Tests can run in any order

### Type Testing Patterns

```typescript
// Type narrowing tests
if (result.ok) {
  const value: string = result.value; // Must type correctly
} else {
  const error: ChalkError = result.error; // Must type correctly
}

// Array type tests
const participants: Participant[] = [];
expect(Array.isArray(participants)).toBe(true);

// Function type tests
const fn: (id: string) => Promise<boolean> = async (id) => true;
expect(typeof fn).toBe('function');
```

### Event Testing Patterns

```typescript
// Register and test emission
let received = null;
emitter.on('event', (data) => { received = data; });
emitter.emit('event', 'value');
expect(received).toBe('value');

// Test unsubscription
const unsub = emitter.on('event', handler);
unsub();
emitter.emit('event', 'value');
// Handler should not be called
```

## Common Test Commands

```bash
# Run specific test file
bun test src/__tests__/types.test.ts

# Run with verbose output
bun test --verbose

# Run with coverage (if configured)
bun test --coverage

# Watch mode
bun test --watch

# Type check
bun run check-types

# Format with ultracite
bunx ultracite fix
```

## Extending the Tests

When adding new features:

1. **Create test file** in `src/__tests__/` with `.test.ts` or `.test.tsx`
2. **Import testing utilities** from `bun:test`
3. **Follow existing patterns** for mocking and assertions
4. **Type all tests** - no implicit `any`
5. **Test both happy and error paths**
6. **Run `bun test` and `bun run check-types`** before committing

### Example Test Template

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { myFunction } from '../my-module.ts';

describe('MyModule', () => {
  let instance: any;

  beforeEach(() => {
    instance = new MyClass();
  });

  describe('feature', () => {
    it('should do something', () => {
      const result = instance.method();
      expect(result).toBe(expected);
    });

    it('should handle errors', () => {
      expect(() => {
        instance.method(invalid);
      }).toThrow();
    });
  });
});
```

## Debugging Tests

```bash
# Run single test
bun test --grep "pattern matching"

# Print test output
bun test 2>&1 | tee test.log

# Run with more context on failure
bun test --verbose

# Type check specific file
bun run check-types src/__tests__/types.test.ts
```

## CI/CD Integration

Add to your CI pipeline:

```yaml
- name: Run tests
  run: |
    cd packages/sdk-core && bun test
    cd packages/sdk-react && bun test

- name: Type checking
  run: |
    cd packages/sdk-core && bun run check-types
    cd packages/sdk-react && bun run check-types
```

## Notes

- Tests use native Bun test runner (no Jest config needed)
- All tests pass with 0 failures
- No external test libraries required
- TypeScript types ensure compile-time safety
- Mock strategy focuses on business logic, not browser APIs
