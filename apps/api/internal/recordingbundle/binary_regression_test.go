package recordingbundle

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func resignBinaryTestBundle(t *testing.T, encoded []byte, change func(*binaryHeader, []byte)) []byte {
	t.Helper()
	headerLength := int(binary.BigEndian.Uint32(encoded[4:8]))
	var header binaryHeader
	if err := json.Unmarshal(encoded[8:8+headerLength], &header); err != nil {
		t.Fatal(err)
	}
	packets := append([]byte(nil), encoded[8+headerLength:]...)
	change(&header, packets)
	content, err := json.Marshal(header.Content)
	if err != nil {
		t.Fatal(err)
	}
	contentHash := sha256.New()
	contentHash.Write(content)
	contentHash.Write(packets)
	header.ContentDigest = hex.EncodeToString(contentHash.Sum(nil))
	header.Manifest.ContentSHA256 = header.ContentDigest
	manifest, err := json.Marshal(header.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	header.ManifestDigest = digestHex(manifest)
	header.BundleDigest = ""
	unsigned, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	bundleHash := sha256.New()
	bundleHash.Write(unsigned)
	bundleHash.Write(packets)
	header.BundleDigest = hex.EncodeToString(bundleHash.Sum(nil))
	signed, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	result := make([]byte, 8, 8+len(signed)+len(packets))
	copy(result, binaryBundleMagic)
	binary.BigEndian.PutUint32(result[4:8], uint32(len(signed)))
	result = append(result, signed...)
	return append(result, packets...)
}

func TestBinaryRejectsTruncationOversizedLengthsAndWrongPacketCount(t *testing.T) {
	encoded, err := Encode(fixtureBundle())
	if err != nil {
		t.Fatal(err)
	}
	for _, size := range []int{0, 4, 7, len(encoded) - 1} {
		if _, err := Decode(encoded[:size]); err == nil {
			t.Fatalf("accepted truncation at %d", size)
		}
	}
	oversizedHeader := append([]byte(nil), encoded...)
	binary.BigEndian.PutUint32(oversizedHeader[4:8], maxBinaryHeader+1)
	if _, err := Decode(oversizedHeader); !errors.Is(err, ErrInvalidBundle) {
		t.Fatalf("oversized header: %v", err)
	}
	oversizedRecord := resignBinaryTestBundle(t, encoded, func(_ *binaryHeader, packets []byte) {
		binary.BigEndian.PutUint32(packets[:4], packetHeaderBytes+MaxPacketPayloadBytes+1)
	})
	if _, err := Decode(oversizedRecord); !errors.Is(err, ErrInvalidBundle) {
		t.Fatalf("oversized record: %v", err)
	}
	wrongCount := resignBinaryTestBundle(t, encoded, func(header *binaryHeader, _ []byte) {
		header.Content.Fragments[0].PacketCount++
	})
	if _, err := Decode(wrongCount); !errors.Is(err, ErrInvalidBundle) {
		t.Fatalf("wrong packet count: %v", err)
	}
}

func TestEncryptedEnvelopeRejectsOppositePlaintextVersion(t *testing.T) {
	key := bytes.Repeat([]byte{0x24}, 32)
	nonce := bytes.Repeat([]byte{0x33}, 12)
	gcm, err := bundleGCM(key)
	if err != nil {
		t.Fatal(err)
	}
	v2Plaintext, v2, err := canonicalBundle(fixtureBundle())
	if err != nil {
		t.Fatal(err)
	}
	legacyAAD := encryptionAAD(v2)
	aadBytes, err := json.Marshal(legacyAAD)
	if err != nil {
		t.Fatal(err)
	}
	legacy := encryptedObject{Version: LegacyEncryptedObjectVersion, Algorithm: EncryptionAlgorithm, Nonce: base64.RawStdEncoding.EncodeToString(nonce), AAD: legacyAAD, Ciphertext: base64.RawStdEncoding.EncodeToString(gcm.Seal(nil, nonce, v2Plaintext, aadBytes))}
	encodedLegacy, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Decrypt(key, encodedLegacy); !errors.Is(err, ErrInvalidEncryptedData) {
		t.Fatalf("v2 plaintext in v1 envelope: %v", err)
	}
	v1Plaintext, v1, err := canonicalBundle(legacyFixtureBundle())
	if err != nil {
		t.Fatal(err)
	}
	binaryAAD := encryptionAAD(v1)
	binaryAAD.Version = EncryptedObjectVersion
	context, err := json.Marshal(binaryAAD)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := hex.DecodeString(v1.ManifestDigest)
	if err != nil {
		t.Fatal(err)
	}
	prefix := make([]byte, binaryEnvelopeFixed)
	copy(prefix, binaryEnvelopeMagic)
	copy(prefix[4:16], nonce)
	binary.BigEndian.PutUint16(prefix[18:20], uint16(len(context)))
	copy(prefix[20:52], digest)
	prefix = append(prefix, context...)
	forged := gcm.Seal(prefix, nonce, v1Plaintext, prefix)
	if _, err := Decrypt(key, forged); !errors.Is(err, ErrInvalidEncryptedData) {
		t.Fatalf("v1 plaintext in v2 envelope: %v", err)
	}
}

func TestBinaryEncryptRejectsOversizedAADContextAtWrite(t *testing.T) {
	bundle := fixtureBundle()
	longID := strings.Repeat(`"`, MaxIdentifierBytes)
	bundle.Manifest.RecordingID = longID
	bundle.Manifest.Encryption = EncryptionContext{
		Environment: longID, TenantID: longID, EpisodeID: longID,
		RecordingID: longID, JobID: longID, BundleSchema: Version, KeyHandle: longID,
	}
	if _, err := Encrypt(bytes.Repeat([]byte{0x24}, 32), bundle); !errors.Is(err, ErrInvalidBundle) {
		t.Fatalf("oversized AAD write error = %v", err)
	}
}
