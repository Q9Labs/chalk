package recordingbundle

import (
	"bytes"
	"errors"
	"testing"
)

func TestOpenReadsEveryStoredFormat(t *testing.T) {
	key := bytes.Repeat([]byte{0x24}, 32)
	bundle := fixtureBundle()
	plain, err := Encode(bundle)
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := Encrypt(key, bundle)
	if err != nil {
		t.Fatal(err)
	}
	for name, stored := range map[string][]byte{"plain": plain, "encrypted": encrypted} {
		opened, err := Open(stored, key)
		if err != nil || opened.Version != bundle.Version {
			t.Fatalf("%s: version=%s error=%v", name, opened.Version, err)
		}
	}
	if _, err := Open(encrypted, nil); !errors.Is(err, ErrKeyRequired) {
		t.Fatalf("encrypted without key: %v", err)
	}
	if _, err := Open([]byte("not a bundle"), key); !errors.Is(err, ErrInvalidBundle) {
		t.Fatalf("garbage: %v", err)
	}
}
