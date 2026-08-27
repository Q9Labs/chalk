package recordingbundle

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	EncryptedObjectVersion = "recording_bundle_envelope.v1"
	EncryptionAlgorithm    = "AES-256-GCM"
	maxEncryptedObjectSize = maxCanonicalBytes*2 + 4096
)

var (
	ErrInvalidEncryptionKey = errors.New("recording bundle encryption key is invalid")
	ErrInvalidEncryptedData = errors.New("encrypted recording bundle is invalid")
)

// EncryptionAAD is non-secret authenticated context. It binds the ciphertext
// to the server-issued attempt, bundle identity, and KMS context without
// placing plaintext key material in the object.
type EncryptionAAD struct {
	Version                string            `json:"version"`
	RecordingID            string            `json:"recording_id"`
	CaptureEpoch           uint64            `json:"capture_epoch"`
	Sequence               uint64            `json:"sequence"`
	RecorderEnvelopeDigest string            `json:"recorder_envelope_digest"`
	ManifestDigest         string            `json:"manifest_digest"`
	Encryption             EncryptionContext `json:"encryption"`
}

type encryptedObject struct {
	Version    string        `json:"version"`
	Algorithm  string        `json:"algorithm"`
	Nonce      string        `json:"nonce"`
	AAD        EncryptionAAD `json:"aad"`
	Ciphertext string        `json:"ciphertext"`
}

// Encrypt seals canonical recording_bundle.v1 bytes with a fresh random
// nonce. The caller remains responsible for clearing its plaintext key.
func Encrypt(key []byte, bundle Bundle) ([]byte, error) {
	return encryptWithRandom(key, bundle, rand.Reader)
}

func encryptWithRandom(key []byte, bundle Bundle, random io.Reader) ([]byte, error) {
	if len(key) != 32 || random == nil {
		return nil, ErrInvalidEncryptionKey
	}
	plaintext, decoded, err := canonicalBundle(bundle)
	if err != nil {
		return nil, err
	}
	defer clear(plaintext)
	aad := encryptionAAD(decoded)
	aadBytes, err := json.Marshal(aad)
	if err != nil {
		return nil, fmt.Errorf("encode recording bundle aad: %w", err)
	}
	gcm, err := bundleGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(random, nonce); err != nil {
		return nil, fmt.Errorf("create recording bundle nonce: %w", err)
	}
	envelope := encryptedObject{
		Version:    EncryptedObjectVersion,
		Algorithm:  EncryptionAlgorithm,
		Nonce:      base64.RawStdEncoding.EncodeToString(nonce),
		AAD:        aad,
		Ciphertext: base64.RawStdEncoding.EncodeToString(gcm.Seal(nil, nonce, plaintext, aadBytes)),
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return nil, fmt.Errorf("encode encrypted recording bundle: %w", err)
	}
	if len(encoded) > maxEncryptedObjectSize {
		return nil, fmt.Errorf("%w: encrypted object exceeds limit", ErrContentLimit)
	}
	return encoded, nil
}

// Decrypt authenticates the object envelope and returns the strict canonical
// bundle. Unknown versions, fields, altered context, and altered ciphertext
// fail closed.
func Decrypt(key []byte, encoded []byte) (Bundle, error) {
	if len(key) != 32 {
		return Bundle{}, ErrInvalidEncryptionKey
	}
	if len(encoded) == 0 || len(encoded) > maxEncryptedObjectSize {
		return Bundle{}, ErrInvalidEncryptedData
	}
	if err := rejectDuplicateJSONKeys(encoded); err != nil {
		return Bundle{}, errors.Join(ErrInvalidEncryptedData, err)
	}
	var envelope encryptedObject
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return Bundle{}, fmt.Errorf("%w: decode: %v", ErrInvalidEncryptedData, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Bundle{}, fmt.Errorf("%w: trailing data", ErrInvalidEncryptedData)
	}
	if envelope.Version != EncryptedObjectVersion || envelope.Algorithm != EncryptionAlgorithm {
		return Bundle{}, ErrInvalidEncryptedData
	}
	nonce, err := base64.RawStdEncoding.Strict().DecodeString(envelope.Nonce)
	if err != nil {
		return Bundle{}, ErrInvalidEncryptedData
	}
	ciphertext, err := base64.RawStdEncoding.Strict().DecodeString(envelope.Ciphertext)
	if err != nil {
		return Bundle{}, ErrInvalidEncryptedData
	}
	aadBytes, err := json.Marshal(envelope.AAD)
	if err != nil {
		return Bundle{}, ErrInvalidEncryptedData
	}
	gcm, err := bundleGCM(key)
	if err != nil {
		return Bundle{}, err
	}
	if len(nonce) != gcm.NonceSize() {
		return Bundle{}, ErrInvalidEncryptedData
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, aadBytes)
	if err != nil {
		return Bundle{}, ErrInvalidEncryptedData
	}
	decrypted, err := Decode(plaintext)
	clear(plaintext)
	if err != nil {
		return Bundle{}, errors.Join(ErrInvalidEncryptedData, err)
	}
	if envelope.AAD != encryptionAAD(decrypted) {
		return Bundle{}, ErrInvalidEncryptedData
	}
	return decrypted, nil
}

// ObjectChecksumHex is the lowercase SHA-256 checksum of the exact encrypted
// bytes uploaded to object storage.
func ObjectChecksumHex(encoded []byte) string {
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

// ObjectChecksumBase64 is the RFC 4648 checksum used by S3-compatible
// ChecksumSHA256 request and response fields.
func ObjectChecksumBase64(encoded []byte) string {
	digest := sha256.Sum256(encoded)
	return base64.StdEncoding.EncodeToString(digest[:])
}

func canonicalBundle(bundle Bundle) ([]byte, Bundle, error) {
	encoded, err := Encode(bundle)
	if err != nil {
		return nil, Bundle{}, err
	}
	decoded, err := Decode(encoded)
	if err != nil {
		return nil, Bundle{}, err
	}
	return encoded, decoded, nil
}

func encryptionAAD(bundle Bundle) EncryptionAAD {
	return EncryptionAAD{
		Version:                EncryptedObjectVersion,
		RecordingID:            bundle.Manifest.RecordingID,
		CaptureEpoch:           bundle.Manifest.CaptureEpoch,
		Sequence:               bundle.Manifest.Sequence,
		RecorderEnvelopeDigest: bundle.Manifest.RecorderEnvelopeDigest,
		ManifestDigest:         bundle.ManifestDigest,
		Encryption:             bundle.Manifest.Encryption,
	}
}

func bundleGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrInvalidEncryptionKey
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create recording bundle cipher: %w", err)
	}
	return gcm, nil
}

// ClearSealedBundle clears caller-owned canonical plaintext and RTP payload
// buffers after the encrypted object has been produced.
func ClearSealedBundle(sealed *SealedBundle) {
	if sealed == nil {
		return
	}
	clear(sealed.Bytes)
	sealed.Bytes = nil
	for fragmentIndex := range sealed.Bundle.Fragments {
		for packetIndex := range sealed.Bundle.Fragments[fragmentIndex].Packets {
			packet := &sealed.Bundle.Fragments[fragmentIndex].Packets[packetIndex]
			clear(packet.Payload)
			packet.Payload = nil
		}
		sealed.Bundle.Fragments[fragmentIndex].Packets = nil
	}
	sealed.Bundle.Fragments = nil
	sealed.ContentBytes = 0
	sealed.PacketCount = 0
}
