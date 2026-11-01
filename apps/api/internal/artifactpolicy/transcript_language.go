package artifactpolicy

import (
	"encoding/json"
	"errors"
	"slices"
)

var ErrInvalidTranscriptLanguage = errors.New("invalid transcript language")

// TranscriptLanguage is auto or fixed. Its zero value is auto; only the parser
// can construct a fixed mode, so unsupported codes cannot enter the domain.
type TranscriptLanguage struct{ code string }

type TranscriptLanguageKind string

const (
	TranscriptLanguageAuto  TranscriptLanguageKind = "auto"
	TranscriptLanguageFixed TranscriptLanguageKind = "fixed"
)

// Whisper primary language codes, including v3 Cantonese. Aliases and regional
// tags are intentionally not accepted. Source: openai/whisper/whisper/tokenizer.py.
var whisperLanguageCodes = []string{"af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs", "ca", "cs", "cy", "da", "de", "el", "en", "es", "et", "eu", "fa", "fi", "fo", "fr", "gl", "gu", "ha", "haw", "he", "hi", "hr", "ht", "hu", "hy", "id", "is", "it", "ja", "jw", "ka", "kk", "km", "kn", "ko", "la", "lb", "ln", "lo", "lt", "lv", "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt", "my", "ne", "nl", "nn", "no", "oc", "pa", "pl", "ps", "pt", "ro", "ru", "sa", "sd", "si", "sk", "sl", "sn", "so", "sq", "sr", "su", "sv", "sw", "ta", "te", "tg", "th", "tk", "tl", "tr", "tt", "uk", "ur", "uz", "vi", "yi", "yo", "yue", "zh"}

func TranscriptLanguageValues() []string {
	return append([]string{"auto"}, whisperLanguageCodes...)
}
func ParseTranscriptLanguage(value string) (TranscriptLanguage, error) {
	if value == "auto" {
		return TranscriptLanguage{}, nil
	}
	if slices.Contains(whisperLanguageCodes, value) {
		return TranscriptLanguage{code: value}, nil
	}
	return TranscriptLanguage{}, ErrInvalidTranscriptLanguage
}
func (mode TranscriptLanguage) Kind() TranscriptLanguageKind {
	if mode.code == "" {
		return TranscriptLanguageAuto
	}
	return TranscriptLanguageFixed
}
func (mode TranscriptLanguage) String() string {
	if mode.Kind() == TranscriptLanguageAuto {
		return "auto"
	}
	return mode.code
}
func (mode TranscriptLanguage) MarshalJSON() ([]byte, error) { return json.Marshal(mode.String()) }
func (mode *TranscriptLanguage) UnmarshalJSON(data []byte) error {
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return ErrInvalidTranscriptLanguage
	}
	parsed, err := ParseTranscriptLanguage(value)
	if err != nil {
		return err
	}
	*mode = parsed
	return nil
}
func ResolveTranscriptLanguage(explicit, space *TranscriptLanguage, tenant TranscriptLanguage) TranscriptLanguage {
	if explicit != nil {
		return *explicit
	}
	if space != nil {
		return *space
	}
	return tenant
}

// OptionalTranscriptLanguage preserves PATCH omission and Space inheritance.
type OptionalTranscriptLanguage struct {
	Set   bool
	Value *TranscriptLanguage
}

func (value *OptionalTranscriptLanguage) UnmarshalJSON(data []byte) error {
	value.Set = true
	if string(data) == "null" {
		value.Value = nil
		return nil
	}
	var mode TranscriptLanguage
	if err := json.Unmarshal(data, &mode); err != nil {
		return err
	}
	value.Value = &mode
	return nil
}
