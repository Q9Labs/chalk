package edjwt

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

var errs = Errors{
	Malformed:  errors.New("malformed"),
	Header:     errors.New("header"),
	UnknownKey: errors.New("unknown key"),
	Signature:  errors.New("signature"),
}

type claims struct {
	Subject string `json:"sub"`
}

func encode(text string) string { return base64.RawURLEncoding.EncodeToString([]byte(text)) }

func sign(private ed25519.PrivateKey, head, body string) string {
	signingInput := encode(head) + "." + encode(body)
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, []byte(signingInput)))
}

func TestVerifyReportsTheFirstFailedCheck(t *testing.T) {
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	keys, ok := NewKeys(map[string]ed25519.PublicKey{"k1": public})
	if !ok {
		t.Fatal("NewKeys rejected a valid key")
	}
	good := `{"alg":"EdDSA","typ":"JWT","kid":"k1"}`
	_, otherPrivate, _ := ed25519.GenerateKey(nil)

	tests := []struct {
		name  string
		token string
		want  error
	}{
		{"valid", sign(private, good, `{"sub":"a"}`), nil},
		{"empty", "", errs.Malformed},
		{"two parts", "a.b", errs.Malformed},
		{"empty part", "a..c", errs.Malformed},
		{"too long", strings.Repeat("a", maxTokenBytes+1), errs.Malformed},
		{"wrong algorithm", sign(private, `{"alg":"HS256","typ":"JWT","kid":"k1"}`, `{"sub":"a"}`), errs.Header},
		{"missing key id", sign(private, `{"alg":"EdDSA","typ":"JWT"}`, `{"sub":"a"}`), errs.Header},
		{"unknown header field", sign(private, `{"alg":"EdDSA","typ":"JWT","kid":"k1","x":1}`, `{"sub":"a"}`), errs.Header},
		{"unknown key", sign(private, `{"alg":"EdDSA","typ":"JWT","kid":"k2"}`, `{"sub":"a"}`), errs.UnknownKey},
		{"wrong signer", sign(otherPrivate, good, `{"sub":"a"}`), errs.Signature},
		{"unknown claim", sign(private, good, `{"sub":"a","extra":1}`), errs.Malformed},
		{"trailing claims", sign(private, good, `{"sub":"a"} {}`), errs.Malformed},
	}
	for _, test := range tests {
		var decoded claims
		if got := keys.Verify(test.token, errs, &decoded); got != test.want {
			t.Errorf("%s: error = %v, want %v", test.name, got, test.want)
		}
	}
}

func TestNewKeysRejectsBadSets(t *testing.T) {
	public, _, _ := ed25519.GenerateKey(nil)
	for name, set := range map[string]map[string]ed25519.PublicKey{
		"none":      {},
		"blank id":  {"": public},
		"padded id": {" k": public},
		"short key": {"k": public[:10]},
	} {
		if _, ok := NewKeys(set); ok {
			t.Errorf("%s: NewKeys accepted the set", name)
		}
	}
}
