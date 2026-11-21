package recordingdecode

import "github.com/q9labs/chalk/apps/api/internal/recordingbundle"

// withinPresentation rejects packets past the frozen presentation and skips a
// packet that starts exactly at its end. Such a packet contributes no samples;
// in particular, a legacy sub-millisecond overhang must not create an empty
// segment or silence beyond the end.
func withinPresentation(rate uint64, durationMS int64, visit func(recordingbundle.RTPPacket) error) func(recordingbundle.RTPPacket) error {
	return func(packet recordingbundle.RTPPacket) error {
		if err := validateMediaTimestamp(packet.Timestamp, rate, durationMS); err != nil {
			return err
		}
		if uint64(packet.Timestamp)*1_000 >= uint64(durationMS)*rate {
			return nil
		}
		return visit(packet)
	}
}
