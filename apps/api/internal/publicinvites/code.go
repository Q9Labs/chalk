package publicinvites

import (
	"crypto/sha256"
	_ "embed"
	"net/url"
	"strings"
	"unicode"
)

// InviteWordCount is the only word-count setting; regenerate SQL and SDK with
// node scripts/codegen/invite-words.mjs --write after changing it.
const InviteWordCount = 4

//go:embed words.txt
var inviteWordsText string

var inviteWords = strings.Fields(inviteWordsText)
var inviteWordSet = func() map[string]bool {
	words := make(map[string]bool, len(inviteWords))
	for _, word := range inviteWords {
		words[word] = true
	}
	return words
}()

func InviteWordCode(handle []byte) string {
	digest := sha256.Sum256(append([]byte("chalk/public-invite/words/v1"), handle...))
	words := make([]string, InviteWordCount)
	// Each word takes exactly ten bits. The frozen dictionary has 1,024 entries.
	for i := range words {
		bit := i * 10
		offset := bit / 8
		window := uint32(digest[offset])<<16 | uint32(digest[offset+1])<<8 | uint32(digest[offset+2])
		words[i] = inviteWords[(window>>(14-uint(bit%8)))&1023]
	}
	return strings.Join(words, "-")
}

const inviteCodeContext = "chalk/public-invite/code/v1"

func InviteCode(handle []byte) string {
	digest := sha256.Sum256(append([]byte(inviteCodeContext), handle...))
	code := make([]byte, 10)
	for i := range code {
		code[i] = 'a' + digest[i]%26
	}
	return string(code)
}

func ParseInviteCode(raw string) (string, bool) {
	value, ok := inviteCodeText(raw)
	if !ok {
		return "", false
	}
	if words, ok := inviteWordCode(value); ok {
		return words, true
	}
	return inviteLetterCode(value)
}

// inviteCodeText lowercases the input and, for a Chalk invite link, returns the link's path.
func inviteCodeText(raw string) (string, bool) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if strings.HasPrefix(value, "chalkmeet.com/") || strings.HasPrefix(value, "chalk.q9labs.ai/") {
		value = "https://" + value
	}
	if !strings.Contains(value, "://") {
		return value, true
	}
	link, err := url.Parse(value)
	if err != nil || link.Scheme != "https" || (link.Host != "chalkmeet.com" && link.Host != "chalk.q9labs.ai") || link.User != nil || link.RawQuery != "" || link.Fragment != "" {
		return "", false
	}
	return strings.TrimPrefix(link.Path, "/"), true
}

// inviteWordCode accepts a code written as InviteWordCount known words.
func inviteWordCode(value string) (string, bool) {
	words := strings.FieldsFunc(value, func(r rune) bool { return r == '-' || r == '.' || unicode.IsSpace(r) })
	if len(words) != InviteWordCount {
		return "", false
	}
	for _, word := range words {
		if !inviteWordSet[word] {
			return "", false
		}
	}
	return strings.Join(words, "-"), true
}

// inviteLetterCode accepts ten lowercase letters, or the same letters grouped 3-4-3.
func inviteLetterCode(value string) (string, bool) {
	code := value
	switch {
	case len(value) == 12 && value[3] == '-' && value[8] == '-':
		code = value[:3] + value[4:8] + value[9:]
	case len(value) != 10:
		return "", false
	}
	if !lowercaseLetters(code) {
		return "", false
	}
	return code, true
}

func FormatInviteCode(code string) string {
	if strings.Contains(code, "-") {
		return code
	}
	return code[:3] + "-" + code[3:7] + "-" + code[7:]
}

func lowercaseLetters(value string) bool {
	for i := range value {
		if value[i] < 'a' || value[i] > 'z' {
			return false
		}
	}
	return true
}
