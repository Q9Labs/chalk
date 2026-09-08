package utilities

import (
	"encoding/json"
	"testing"
)

func TestIDJSONRoundTrip(t *testing.T) {
	id, err := ParseID("6a9b6a12-7457-4fe9-a58b-8b234d0be00e")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(id)
	if err != nil || string(encoded) != `"6a9b6a12-7457-4fe9-a58b-8b234d0be00e"` {
		t.Fatalf("encode ID: %s, %v", encoded, err)
	}
	var decoded ID
	if err := json.Unmarshal(encoded, &decoded); err != nil || decoded != id {
		t.Fatalf("decode ID: %v, %v", decoded, err)
	}
	for _, invalid := range []string{`{}`, `123`, `"not-a-uuid"`} {
		if err := json.Unmarshal([]byte(invalid), &decoded); err == nil {
			t.Fatalf("accepted invalid ID %s", invalid)
		}
	}
	if decoded != id {
		t.Fatal("invalid decoding changed the existing ID")
	}
}
