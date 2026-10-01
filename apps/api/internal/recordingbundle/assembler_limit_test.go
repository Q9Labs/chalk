package recordingbundle

import (
	"bytes"
	"errors"
	"testing"
)

func TestAssemblerContentLimitSealsAcceptedPayloadNotFraming(t *testing.T) {
	for _, schema := range []string{LegacyVersion, Version} {
		t.Run(schema, func(t *testing.T) {
			config := testConfig(0)
			config.Encryption.BundleSchema = schema
			config.MaxContentBytes = 24
			assembler, err := NewAssembler(config)
			if err != nil {
				t.Fatal(err)
			}
			track := testTrack("camera", 1, "0")
			payload := bytes.Repeat([]byte{1}, 12)
			for sequence := uint16(1); sequence <= 2; sequence++ {
				if err := assembler.AddPacket(testPacket(track, 0, 0, sequence, payload...)); err != nil {
					t.Fatalf("framing counted toward payload cap: %v", err)
				}
			}
			if err := assembler.AddPacket(testPacket(track, 1, 1, 3, 2)); !errors.Is(err, ErrAssemblerClosed) {
				t.Fatalf("overflow=%v, want retryable rotation", err)
			}
			sealed, err := assembler.Seal()
			if err != nil {
				t.Fatalf("accepted payload lost: %v", err)
			}
			if sealed.ContentBytes != 24 || sealed.PacketCount != 2 || len(sealed.Bytes) <= sealed.ContentBytes {
				t.Fatalf("sealed bytes/count=%d/%d encoded=%d", sealed.ContentBytes, sealed.PacketCount, len(sealed.Bytes))
			}
			decoded, err := Decode(sealed.Bytes)
			if err != nil || !bytes.Equal(decoded.Fragments[0].Packets[1].Payload, payload) {
				t.Fatalf("payload round trip: %v", err)
			}
		})
	}
}
