package recordingbundle

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
)

const (
	// CBE2: magic, nonce, handle length, AAD length, raw manifest digest,
	// handle, canonical AAD JSON, and AES-GCM ciphertext with its tag.
	binaryEnvelopeMagic = "CBE2"
	binaryEnvelopeFixed = 4 + 12 + 2 + 2 + sha256.Size
	maxAADContextBytes  = 4096
)

// The authenticated prefix carries the format, nonce, key reference, manifest
// digest, and the original server-issued AAD. Only the ciphertext follows it.
func encryptBinary(key []byte, bundle Bundle, random io.Reader) ([]byte, error) {
	if bundle.Version != Version {
		return nil, ErrInvalidBundle
	}
	if len(key) != 32 || random == nil {
		return nil, ErrInvalidEncryptionKey
	}
	plaintext, decoded, err := canonicalBundle(bundle)
	if err != nil {
		return nil, err
	}
	defer clear(plaintext)
	context, err := json.Marshal(encryptionAAD(decoded))
	if err != nil {
		return nil, fmt.Errorf("encode bundle context: %w", err)
	}
	handle := []byte(decoded.Manifest.Encryption.KeyHandle)
	if len(handle) > MaxIdentifierBytes || len(context) > maxAADContextBytes {
		return nil, ErrInvalidBundle
	}
	digest, err := hex.DecodeString(decoded.ManifestDigest)
	if err != nil || len(digest) != sha256.Size {
		return nil, ErrInvalidBundle
	}
	gcm, err := bundleGCM(key)
	if err != nil {
		return nil, err
	}
	prefix := make([]byte, binaryEnvelopeFixed, binaryEnvelopeFixed+len(handle)+len(context)+len(plaintext)+gcm.Overhead())
	copy(prefix, binaryEnvelopeMagic)
	if _, err := io.ReadFull(random, prefix[4:16]); err != nil {
		return nil, fmt.Errorf("create recording bundle nonce: %w", err)
	}
	binary.BigEndian.PutUint16(prefix[16:18], uint16(len(handle)))
	binary.BigEndian.PutUint16(prefix[18:20], uint16(len(context)))
	copy(prefix[20:52], digest)
	prefix = append(prefix, handle...)
	prefix = append(prefix, context...)
	encoded := gcm.Seal(prefix, prefix[4:16], plaintext, prefix)
	if len(encoded) > maxEncryptedObjectSize {
		return nil, ErrContentLimit
	}
	return encoded, nil
}

func decryptBinary(key, encoded []byte) (Bundle, error) {
	if len(key) != 32 {
		return Bundle{}, ErrInvalidEncryptionKey
	}
	if len(encoded) < binaryEnvelopeFixed+16 || len(encoded) > maxEncryptedObjectSize {
		return Bundle{}, ErrInvalidEncryptedData
	}
	handleLength := int(binary.BigEndian.Uint16(encoded[16:18]))
	contextLength := int(binary.BigEndian.Uint16(encoded[18:20]))
	if handleLength > MaxIdentifierBytes || contextLength == 0 || contextLength > maxAADContextBytes ||
		binaryEnvelopeFixed+handleLength+contextLength+16 > len(encoded) {
		return Bundle{}, ErrInvalidEncryptedData
	}
	prefixEnd := binaryEnvelopeFixed + handleLength + contextLength
	prefix := encoded[:prefixEnd]
	contextBytes := encoded[binaryEnvelopeFixed+handleLength : prefixEnd]
	if err := rejectDuplicateJSONKeys(contextBytes); err != nil {
		return Bundle{}, ErrInvalidEncryptedData
	}
	var context EncryptionAAD
	decoder := json.NewDecoder(bytes.NewReader(contextBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&context); err != nil || context.Version != EncryptedObjectVersion {
		return Bundle{}, ErrInvalidEncryptedData
	}
	gcm, err := bundleGCM(key)
	if err != nil {
		return Bundle{}, err
	}
	plaintext, err := gcm.Open(nil, encoded[4:16], encoded[prefixEnd:], prefix)
	if err != nil {
		return Bundle{}, ErrInvalidEncryptedData
	}
	bundle, err := Decode(plaintext)
	clear(plaintext)
	if err != nil {
		return Bundle{}, fmt.Errorf("%w: %w", ErrInvalidEncryptedData, err)
	}
	manifestDigest, err := hex.DecodeString(bundle.ManifestDigest)
	if err != nil || bundle.Version != Version || !bytes.Equal(encoded[20:52], manifestDigest) ||
		string(encoded[binaryEnvelopeFixed:binaryEnvelopeFixed+handleLength]) != bundle.Manifest.Encryption.KeyHandle ||
		context != encryptionAAD(bundle) {
		return Bundle{}, ErrInvalidEncryptedData
	}
	return bundle, nil
}
