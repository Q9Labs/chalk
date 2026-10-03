package recordingbundle

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

// ErrKeyRequired reports an encrypted bundle opened without a key.
var ErrKeyRequired = errors.New("recording bundle is encrypted and needs a key")

// Open reads a stored bundle in any of the four stored formats: the binary
// bundle (magic CBN2), the binary envelope (magic CBE2), the legacy JSON
// bundle, or the legacy JSON envelope. The key is only used for envelopes.
func Open(encoded, key []byte) (Bundle, error) {
	if bytes.HasPrefix(encoded, []byte(binaryBundleMagic)) {
		return Decode(encoded)
	}
	encrypted := bytes.HasPrefix(encoded, []byte(binaryEnvelopeMagic))
	if !encrypted {
		var probe struct {
			Nonce *string `json:"nonce"`
		}
		if err := json.Unmarshal(encoded, &probe); err != nil {
			return Bundle{}, fmt.Errorf("%w: unrecognized stored format (expected CBN2, CBE2, or JSON)", ErrInvalidBundle)
		}
		encrypted = probe.Nonce != nil
	}
	if !encrypted {
		return Decode(encoded)
	}
	if len(key) == 0 {
		return Bundle{}, ErrKeyRequired
	}
	return Decrypt(key, encoded)
}
