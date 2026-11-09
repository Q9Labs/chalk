# E26 camera replay fixture

`capture-e26-camera.rtp.gz` is sanitized from one camera’s fragments in the first
four retained E26 v2 Capture bundles, in bundle/extended-sequence order. It has
11,216 packets: 3,107 unique media packets and 8,109 repetitions with **different
RTP sequence numbers**. These are the repetitions that sequence deduplication
alone cannot reject. Of those repetitions, 8,107 replay older frames; two
are equal fragments in the current frame and must remain admissible, because
identical fragments within one frame can be legitimate. Both bundle versions used the same Capture admission path
in E26; the two live runs received different streams.

No media, production identifiers, encryption material, original payload hashes,
or absolute times are retained. SSRC becomes 1, the first sequence becomes 65000
(preserving deltas and wrapping), and timestamps are shifted to start at zero.
Payload bytes are replaced by sequential equality-class IDs assigned on first
occurrence of each distinct payload. Packet lengths, marker flags, timestamp
deltas, sequence deltas, ordering, and payload equality are preserved. The test
expands each ID into synthetic bytes of the original length using SHA-256.

The gzip stream (mtime zero) contains fixed 13-byte, big-endian records:

| Offset | Type   | Value                           |
| ------ | ------ | ------------------------------- |
| 0      | uint16 | Shifted RTP sequence            |
| 2      | uint32 | Relative RTP timestamp (90 kHz) |
| 6      | uint16 | Payload length                  |
| 8      | uint32 | Synthetic payload ID            |
| 12     | uint8  | Marker (0 or 1)                 |

The source bundles do not retain per-packet arrival times. The test supplies a
deterministic arrival clock to exercise bundle rotations, writes through the real
Capture reader and encrypted bundle writer, decrypts each output, and compares
all admitted packet fields and payloads between v1 and v2. It also compares total
encrypted object bytes, including framing and metadata. This is an admission and
size fixture; the synthetic payloads are not decodable video.
