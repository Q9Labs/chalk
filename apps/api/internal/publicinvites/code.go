package publicinvites

import (
	"crypto/sha256"
	"strings"
)

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
