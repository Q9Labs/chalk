package recordingbundle

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const maxCanonicalBytes = int(MaxContentBytes*2 + 1_000_000)

type contentMaterial struct {
	Fragments      []RTPFragment         `json:"fragments"`
	TrackTimeline  []TrackTimelineEvent  `json:"track_timeline"`
	LayoutTimeline []LayoutTimelineEvent `json:"layout_timeline"`
	Gaps           []Gap                 `json:"gaps"`
}

type envelopeMaterial struct {
	Version        string          `json:"version"`
	Manifest       Manifest        `json:"manifest"`
	Content        contentMaterial `json:"content"`
	ManifestDigest string          `json:"manifest_digest"`
	ContentDigest  string          `json:"content_digest"`
}

type wireBundle struct {
	Version        string                `json:"version"`
	Manifest       Manifest              `json:"manifest"`
	Fragments      []RTPFragment         `json:"fragments"`
	TrackTimeline  []TrackTimelineEvent  `json:"track_timeline"`
	LayoutTimeline []LayoutTimelineEvent `json:"layout_timeline"`
	Gaps           []Gap                 `json:"gaps"`
	ManifestDigest string                `json:"manifest_digest"`
	ContentDigest  string                `json:"content_digest"`
	BundleDigest   string                `json:"bundle_digest"`
}

// Encode returns canonical bytes for the bundle's schema version.
func Encode(bundle Bundle) ([]byte, error) {
	if bundle.Version == Version {
		return encodeBinary(bundle)
	}
	return encodeLegacy(bundle)
}

// encodeLegacy retains the original canonical JSON contract for stored v1 objects.
func encodeLegacy(bundle Bundle) ([]byte, error) {
	normalized, err := normalizeBundle(bundle)
	if err != nil {
		return nil, err
	}
	content := contentMaterial{
		Fragments:      normalized.Fragments,
		TrackTimeline:  normalized.TrackTimeline,
		LayoutTimeline: normalized.LayoutTimeline,
		Gaps:           normalized.Gaps,
	}
	contentBytes, err := json.Marshal(content)
	if err != nil {
		return nil, fmt.Errorf("encode content: %w", err)
	}
	contentDigest := digestHex(contentBytes)
	normalized.Manifest.ContentSHA256 = contentDigest
	manifestBytes, err := json.Marshal(normalized.Manifest)
	if err != nil {
		return nil, fmt.Errorf("encode manifest: %w", err)
	}
	manifestDigest := digestHex(manifestBytes)
	envelope := envelopeMaterial{
		Version:        normalized.Version,
		Manifest:       normalized.Manifest,
		Content:        content,
		ManifestDigest: manifestDigest,
		ContentDigest:  contentDigest,
	}
	envelopeBytes, err := json.Marshal(envelope)
	if err != nil {
		return nil, fmt.Errorf("encode envelope: %w", err)
	}
	envelopeDigest := digestHex(envelopeBytes)
	wire := wireBundle{
		Version:        normalized.Version,
		Manifest:       normalized.Manifest,
		Fragments:      normalized.Fragments,
		TrackTimeline:  normalized.TrackTimeline,
		LayoutTimeline: normalized.LayoutTimeline,
		Gaps:           normalized.Gaps,
		ManifestDigest: manifestDigest,
		ContentDigest:  contentDigest,
		BundleDigest:   envelopeDigest,
	}
	encoded, err := json.Marshal(wire)
	if err != nil {
		return nil, fmt.Errorf("encode bundle: %w", err)
	}
	if len(encoded) > maxCanonicalBytes {
		return nil, fmt.Errorf("%w: canonical bytes=%d limit=%d", ErrContentLimit, len(encoded), maxCanonicalBytes)
	}
	return encoded, nil
}

// Decode accepts both canonical bundle versions.
func Decode(encoded []byte) (Bundle, error) {
	if bytes.HasPrefix(encoded, []byte(binaryBundleMagic)) {
		return decodeBinary(encoded)
	}
	return decodeLegacy(encoded)
}

// decodeLegacy strictly validates the original JSON envelope.
func decodeLegacy(encoded []byte) (Bundle, error) {
	if len(encoded) == 0 || len(encoded) > maxCanonicalBytes {
		return Bundle{}, fmt.Errorf("%w: encoded size is invalid", ErrInvalidBundle)
	}
	if err := rejectDuplicateJSONKeys(encoded); err != nil {
		return Bundle{}, err
	}
	var wire wireBundle
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		if strings.Contains(err.Error(), "unknown field") {
			return Bundle{}, fmt.Errorf("%w: %v", ErrUnknownField, err)
		}
		return Bundle{}, fmt.Errorf("%w: decode: %v", ErrInvalidBundle, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return Bundle{}, fmt.Errorf("%w: trailing JSON value", ErrInvalidBundle)
		}
		return Bundle{}, fmt.Errorf("%w: trailing data: %v", ErrInvalidBundle, err)
	}
	if wire.Version != LegacyVersion || wire.Manifest.Version != LegacyVersion {
		return Bundle{}, fmt.Errorf("%w: version=%q manifest=%q", ErrUnknownBundleVersion, wire.Version, wire.Manifest.Version)
	}
	bundle := Bundle(wire)
	normalized, err := normalizeBundle(bundle)
	if err != nil {
		return Bundle{}, err
	}
	content := contentMaterial{
		Fragments:      normalized.Fragments,
		TrackTimeline:  normalized.TrackTimeline,
		LayoutTimeline: normalized.LayoutTimeline,
		Gaps:           normalized.Gaps,
	}
	contentBytes, err := json.Marshal(content)
	if err != nil {
		return Bundle{}, fmt.Errorf("%w: content: %v", ErrInvalidBundle, err)
	}
	contentDigest := digestHex(contentBytes)
	if bundle.ContentDigest != contentDigest || normalized.Manifest.ContentSHA256 != contentDigest {
		return Bundle{}, fmt.Errorf("%w: content", ErrDigestMismatch)
	}
	manifestBytes, err := json.Marshal(normalized.Manifest)
	if err != nil {
		return Bundle{}, fmt.Errorf("%w: manifest: %v", ErrInvalidBundle, err)
	}
	manifestDigest := digestHex(manifestBytes)
	if bundle.ManifestDigest != manifestDigest {
		return Bundle{}, fmt.Errorf("%w: manifest", ErrDigestMismatch)
	}
	envelopeBytes, err := json.Marshal(envelopeMaterial{
		Version:        normalized.Version,
		Manifest:       normalized.Manifest,
		Content:        content,
		ManifestDigest: manifestDigest,
		ContentDigest:  contentDigest,
	})
	if err != nil {
		return Bundle{}, fmt.Errorf("%w: envelope: %v", ErrInvalidBundle, err)
	}
	if bundle.BundleDigest != digestHex(envelopeBytes) {
		return Bundle{}, fmt.Errorf("%w: envelope", ErrDigestMismatch)
	}
	normalized.ManifestDigest = manifestDigest
	normalized.ContentDigest = contentDigest
	normalized.BundleDigest = bundle.BundleDigest
	return cloneBundle(normalized), nil
}

// CanonicalBytes is a method form useful at worker call sites.
func (b Bundle) CanonicalBytes() ([]byte, error) { return Encode(b) }

func digestHex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

// rejectDuplicateJSONKeys catches an ambiguity that encoding/json otherwise
// silently accepts when the same object field appears more than once.
func rejectDuplicateJSONKeys(encoded []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	if err := walkJSONValue(decoder); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidBundle, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: trailing JSON", ErrInvalidBundle)
	}
	return nil
}

func walkJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	switch delimiter := token.(type) {
	case json.Delim:
		switch delimiter {
		case '{':
			seen := make(map[string]struct{})
			for decoder.More() {
				key, err := decoder.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok {
					return errors.New("object key is not a string")
				}
				if _, exists := seen[name]; exists {
					return fmt.Errorf("duplicate field %q", name)
				}
				seen[name] = struct{}{}
				if err := walkJSONValue(decoder); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim('}') {
				return errors.New("object is not closed")
			}
		case '[':
			for decoder.More() {
				if err := walkJSONValue(decoder); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim(']') {
				return errors.New("array is not closed")
			}
		default:
			return fmt.Errorf("unexpected JSON delimiter %q", delimiter)
		}
	}
	return nil
}
