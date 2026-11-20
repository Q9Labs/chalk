package obs

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode"
)

// Handles are display and lookup syntax only. Stores keep the canonical value: a dashed UUID, a W3C trace or span
// id, or a provider token. FormatHandle adds the prefix; ParseHandle strips it and says what the text can mean.

type idKind struct {
	kind, prefix, field, canonical, legacyHashField string
}

type sessionMeaning struct {
	meaning, kind string
	lookup        bool
}

// Candidate is one id a handle can stand for.
type Candidate struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// Handle is a parsed handle. Form is full, short, bare, session, legacy_hash or diagnostic_code.
type Handle struct {
	Form       string      `json:"form"`
	Kind       string      `json:"kind,omitempty"`
	ID         string      `json:"id,omitempty"`
	Prefix     string      `json:"prefix,omitempty"`
	Hash       string      `json:"hash,omitempty"`
	Code       string      `json:"code,omitempty"`
	Candidates []Candidate `json:"candidates,omitempty"`
}

// HandleError says why text is not a handle.
type HandleError string

func (e HandleError) Error() string { return "obs: not a handle: " + string(e) }

// Target is a row a handle can match. LegacyHash is the participant_id_hash an old row carried.
type Target struct {
	Kind       string `json:"kind"`
	ID         string `json:"id"`
	LegacyHash string `json:"legacyHash,omitempty"`
}

// Resolution is unique, ambiguous or none. A reader never picks one of several matches.
type Resolution struct {
	Status  string      `json:"status"`
	Match   *Candidate  `json:"match,omitempty"`
	Matches []Candidate `json:"matches,omitempty"`
}

const minShort = 4

var hexLength = map[string]int{"uuid": 32, "hex32": 32, "hex16": 16}

func kindSpec(kind string) (idKind, bool) {
	index := slices.IndexFunc(registryIDKinds, func(entry idKind) bool { return entry.kind == kind })
	if index < 0 {
		return idKind{}, false
	}
	return registryIDKinds[index], true
}

func isHex(text string) bool {
	if text == "" {
		return false
	}
	for _, r := range text {
		if !strings.ContainsRune("0123456789abcdef", r) {
			return false
		}
	}
	return true
}

func isDashedUUID(text string) bool {
	if len(text) != 36 {
		return false
	}
	for index, r := range text {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if r != '-' {
				return false
			}
		} else if !strings.ContainsRune("0123456789abcdef", r) {
			return false
		}
	}
	return true
}

// hexOf returns the hex digits of a canonical value, or false when id is not one.
func hexOf(entry idKind, id string) (string, bool) {
	if entry.canonical == "token" {
		return "", false
	}
	lower := strings.ToLower(id)
	if entry.canonical == "uuid" && isDashedUUID(lower) {
		lower = strings.ReplaceAll(lower, "-", "")
	}
	return lower, isHex(lower) && len(lower) == hexLength[entry.canonical]
}

func stored(entry idKind, hexDigits string) string {
	if entry.canonical != "uuid" {
		return hexDigits
	}
	return hexDigits[0:8] + "-" + hexDigits[8:12] + "-" + hexDigits[12:16] + "-" + hexDigits[16:20] + "-" + hexDigits[20:]
}

func hasSpace(text string) bool { return strings.IndexFunc(text, unicode.IsSpace) >= 0 }

// CanonicalID returns the stored form of an id, so two spellings of one id compare equal.
func CanonicalID(kind, id string) (string, error) {
	entry, ok := kindSpec(kind)
	if !ok {
		return "", fmt.Errorf("obs: unknown id kind %s", kind)
	}
	if entry.canonical == "token" {
		if id == "" {
			return "", fmt.Errorf("obs: empty %s id", kind)
		}
		return id, nil
	}
	digits, ok := hexOf(entry, id)
	if !ok {
		return "", fmt.Errorf("obs: %s is not a canonical %s id", id, kind)
	}
	return stored(entry, digits), nil
}

// FormatHandle returns the full handle, or with a scope the shortest prefix of at least four hex digits that no
// other id in the scope shares.
func FormatHandle(kind, id string, scope []string) (string, error) {
	entry, ok := kindSpec(kind)
	if !ok {
		return "", fmt.Errorf("obs: unknown id kind %s", kind)
	}
	if entry.canonical == "token" {
		if id == "" || hasSpace(id) {
			return "", fmt.Errorf("obs: %s token must be non-empty without whitespace", kind)
		}
		return entry.prefix + "_" + id, nil
	}
	digits, ok := hexOf(entry, id)
	if !ok {
		return "", fmt.Errorf("obs: %s is not a canonical %s id", id, kind)
	}
	if scope == nil {
		return entry.prefix + "_" + digits, nil
	}
	others := []string{}
	for _, other := range scope {
		if otherDigits, ok := hexOf(entry, other); ok && otherDigits != digits {
			others = append(others, otherDigits)
		}
	}
	length := minShort
	for length < len(digits) && slices.ContainsFunc(others, func(other string) bool { return strings.HasPrefix(other, digits[:length]) }) {
		length++
	}
	return entry.prefix + "_" + digits[:length], nil
}

// DiagnosticCode is CHK- and four Crockford base32 characters from the first 20 bits of a client session id.
func DiagnosticCode(clientSessionID string) (string, error) {
	id, err := CanonicalID("client_session", clientSessionID)
	if err != nil {
		return "", err
	}
	bits, _ := strconv.ParseUint(id[:5], 16, 32)
	code := make([]byte, 0, diagnosticLength)
	for index := diagnosticLength - 1; index >= 0; index-- {
		code = append(code, diagnosticAlphabet[(bits>>(index*5))&31])
	}
	return diagnosticPrefix + string(code), nil
}

// ParseHandle reads a full or short handle, a bare id, session:<id>, a legacy participant hash or a CHK- code.
func ParseHandle(input string) (Handle, error) {
	text := strings.TrimSpace(input)
	lower := strings.ToLower(text)
	switch {
	case text == "":
		return Handle{}, HandleError("empty")
	case strings.HasPrefix(lower, strings.ToLower(diagnosticPrefix)):
		return parseCode(text[len(diagnosticPrefix):])
	case strings.HasPrefix(lower, "session:"):
		return parseSession(text[len("session:"):])
	case len(lower) == 64 && isHex(lower):
		return parseLegacyHash(lower)
	}
	separator := strings.Index(text, "_")
	if separator <= 0 {
		return parseBare(text)
	}
	index := slices.IndexFunc(registryIDKinds, func(entry idKind) bool { return entry.prefix == lower[:separator] })
	if index < 0 {
		return Handle{}, HandleError("unknown_prefix")
	}
	return parseValue(registryIDKinds[index], text[separator+1:])
}

func parseCode(rest string) (Handle, error) {
	normalized := strings.NewReplacer("O", "0", "I", "1", "L", "1").Replace(strings.ToUpper(rest))
	if len(normalized) != diagnosticLength || strings.Trim(normalized, diagnosticAlphabet) != "" {
		return Handle{}, HandleError("bad_diagnostic_code")
	}
	return Handle{Form: "diagnostic_code", Code: diagnosticPrefix + normalized}, nil
}

func parseSession(id string) (Handle, error) {
	if id == "" {
		return Handle{}, HandleError("empty")
	}
	candidates := []Candidate{}
	for _, meaning := range registrySessionMeanings {
		entry, ok := kindSpec(meaning.kind)
		if !meaning.lookup || !ok {
			continue
		}
		if entry.canonical == "token" {
			candidates = append(candidates, Candidate{Kind: entry.kind, ID: id})
		} else if digits, ok := hexOf(entry, id); ok {
			candidates = append(candidates, Candidate{Kind: entry.kind, ID: stored(entry, digits)})
		}
	}
	return Handle{Form: "session", Candidates: candidates}, nil
}

func parseLegacyHash(hash string) (Handle, error) {
	index := slices.IndexFunc(registryIDKinds, func(entry idKind) bool { return entry.legacyHashField != "" })
	if index < 0 {
		return Handle{}, HandleError("unrecognized")
	}
	return Handle{Form: "legacy_hash", Kind: registryIDKinds[index].kind, Hash: hash}, nil
}

func parseBare(text string) (Handle, error) {
	candidates := []Candidate{}
	for _, entry := range registryIDKinds {
		if digits, ok := hexOf(entry, text); ok {
			candidates = append(candidates, Candidate{Kind: entry.kind, ID: stored(entry, digits)})
		}
	}
	if len(candidates) == 0 {
		return Handle{}, HandleError("unrecognized")
	}
	return Handle{Form: "bare", Candidates: candidates}, nil
}

func parseValue(entry idKind, rest string) (Handle, error) {
	if entry.canonical == "token" {
		if rest == "" || hasSpace(rest) {
			return Handle{}, HandleError("bad_value")
		}
		return Handle{Form: "full", Kind: entry.kind, ID: rest}, nil
	}
	digits := strings.ReplaceAll(strings.ToLower(rest), "-", "")
	full := hexLength[entry.canonical]
	switch {
	case !isHex(digits):
		return Handle{}, HandleError("bad_value")
	case len(digits) > full:
		return Handle{}, HandleError("too_long")
	case len(digits) == full:
		return Handle{Form: "full", Kind: entry.kind, ID: stored(entry, digits)}, nil
	case len(digits) < minShort:
		return Handle{}, HandleError("too_short")
	}
	return Handle{Form: "short", Kind: entry.kind, Prefix: digits}, nil
}

func handleMatches(handle Handle, target Target) bool {
	switch handle.Form {
	case "full":
		return handle.Kind == target.Kind && handle.ID == target.ID
	case "short":
		return handle.Kind == target.Kind && strings.HasPrefix(strings.ReplaceAll(target.ID, "-", ""), handle.Prefix)
	case "bare", "session":
		return slices.Contains(handle.Candidates, Candidate{Kind: target.Kind, ID: target.ID})
	case "legacy_hash":
		return handle.Kind == target.Kind && strings.ToLower(target.LegacyHash) == handle.Hash
	case "diagnostic_code":
		code, err := DiagnosticCode(target.ID)
		return target.Kind == "client_session" && err == nil && code == handle.Code
	}
	return false
}

// ResolveHandle matches a parsed handle against the rows in a scope and returns every match.
func ResolveHandle(handle Handle, targets []Target) Resolution {
	found := []Candidate{}
	for _, target := range targets {
		id, err := CanonicalID(target.Kind, target.ID)
		if err != nil {
			continue
		}
		candidate := Candidate{Kind: target.Kind, ID: id}
		if handleMatches(handle, Target{Kind: target.Kind, ID: id, LegacyHash: target.LegacyHash}) && !slices.Contains(found, candidate) {
			found = append(found, candidate)
		}
	}
	switch len(found) {
	case 0:
		return Resolution{Status: "none"}
	case 1:
		return Resolution{Status: "unique", Match: &found[0]}
	}
	return Resolution{Status: "ambiguous", Matches: found}
}

// LegacyHash is the participant_id_hash older rows carry: the SHA-256 hex of the dashed UUID.
func LegacyHash(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:])
}
