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
	value := strings.ToLower(strings.TrimSpace(raw))
	if strings.HasPrefix(value, "chalkmeet.com/") || strings.HasPrefix(value, "chalk.q9labs.ai/") {
		value = "https://" + value
	}
	if strings.Contains(value, "://") {
		link, err := url.Parse(value)
		if err != nil || link.Scheme != "https" || (link.Host != "chalkmeet.com" && link.Host != "chalk.q9labs.ai") || link.User != nil || link.RawQuery != "" || link.Fragment != "" {
			return "", false
		}
		value = strings.TrimPrefix(link.Path, "/")
	}
	words := strings.FieldsFunc(value, func(r rune) bool { return r == '-' || r == '.' || unicode.IsSpace(r) })
	if len(words) == InviteWordCount {
		valid := true
		for _, word := range words {
			valid = valid && inviteWordSet[word]
		}
		if valid {
			return strings.Join(words, "-"), true
		}
	}
	switch len(value) {
	case 10:
		if !lowercaseLetters(value) {
			return "", false
		}
		return value, true
	case 12:
		if value[3] != '-' || value[8] != '-' {
			return "", false
		}
		code := value[:3] + value[4:8] + value[9:]
		if !lowercaseLetters(code) {
			return "", false
		}
		return code, true
	default:
		return "", false
	}
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
