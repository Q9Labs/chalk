package recordingpresentation

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func TestEncodeEmptyPresentedBoard(t *testing.T) {
	fixture, err := os.ReadFile("testdata/empty-presented-board.json")
	if err != nil {
		t.Fatal(err)
	}
	timeline, err := Decode(fixture)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := Encode(timeline)
	if err != nil {
		t.Fatal(err)
	}

	// The renderer's validator checks the same fixture. Keep the canonical
	// encoding identical so the wire contract covers the Go producer too.
	var expected bytes.Buffer
	if err := json.Compact(&expected, fixture); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, expected.Bytes()) {
		t.Fatalf("encoded timeline doesn't match the renderer fixture:\n got %s\nwant %s", encoded, expected.Bytes())
	}
}
