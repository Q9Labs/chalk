package whiteboardfiles

import (
	"encoding/hex"
	"errors"
	"testing"
)

func TestValidateAnimatedWebP(t *testing.T) {
	// Two 2-by-2 frames: red then blue.
	data, err := hex.DecodeString(
		"52494646c000000057454250565038580a00000002000000010000010000414e494d06000000ffffffff0000" +
			"414e4d4648000000000000000000010000010000f40100025650382030000000d001009d012a0200020002003425a00274ba01f80003b000fef0c40bff20b96175c8d7ff203fe407fc80fff8f2000000" +
			"414e4d4644000000000000000000010000010000f4010000565038202c0000009401009d012a0200020000003425a00274ba00039800fef9936fff901fff901fff901fff203fe2177b203000",
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateImage(data, "image/webp"); err != nil {
		t.Fatalf("valid animated WebP was rejected: %v", err)
	}
	if err := validateImage(data[:30], "image/webp"); !errors.Is(err, ErrFileTransferFailed) {
		t.Fatalf("WebP canvas without a frame was accepted: %v", err)
	}
}
