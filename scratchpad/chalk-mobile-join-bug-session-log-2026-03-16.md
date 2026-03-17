2026-03-16 07:16 PKT
- scope: local Android mobile bug after `New meeting -> lobby -> Join Meeting`
- reproduced on emulator with `adb`; final UI still falls back to lobby with `Already connected to a room`
- proof: SDK wide-events show `api.request` success and `room.join` success before the fallback UI appears
- attempted:
  - `sdk-react-native` join-effect dedupe by `joinNonce`
  - `chalk-native-provider` rollback from `RealtimeKitProvider fallback={children}` wrapper to prior conditional wrapper
  - `sdk-core` same-room join idempotence + regression test
  - defensive promote-to-meeting when a late join error arrives after `session.room.getRoom()` exists
- current blocker: second local join/error path still not exposed cleanly by available RN logs; visible bug persists after successful backend/RTK join
