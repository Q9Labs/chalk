# Debug Log Session Log

- 2026-03-30 18:37:01 PKT Opened /Users/macmini/Downloads/chalk-debug-1774877657429.txt for analysis
- $(date '+%Y-%m-%d %H:%M:%S %Z') Findings: auth succeeded, POST /api/v1/rooms/69c0db33177fc4ff2ade6365/participants returned 404, repeated join retries surfaced 'room not found', incident reporter in TH LMS also returned 405.
- $(date '+%Y-%m-%d %H:%M:%S %Z') Likely cause: TH LMS passed sessionData._id as fallback roomId because chalk_room_id missing; backend could not resolve that identifier to a Chalk room.
