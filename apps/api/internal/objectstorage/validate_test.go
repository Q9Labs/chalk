package objectstorage

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type recordingStore struct {
	Store
	uploads []CreateUploadURLInput
}

func (s *recordingStore) CreateUploadURL(_ context.Context, input CreateUploadURLInput) (SignedURL, error) {
	s.uploads = append(s.uploads, input)
	return SignedURL{URL: "https://example.test"}, nil
}

func TestValidateKey(t *testing.T) {
	for _, key := range []string{"a", "tenants/t/file.bin", " padded "} {
		if err := ValidateKey(key); err != nil {
			t.Errorf("%q rejected: %v", key, err)
		}
	}
	for _, key := range []string{"", "/abs", "a//b", "a/./b", "a/../b", "a/b/", "tab\there", strings.Repeat("k", maxObjectKeyBytes+1)} {
		if !errors.Is(ValidateKey(key), ErrInvalidObjectKey) {
			t.Errorf("%q accepted", key)
		}
	}
}

func TestCreateUploadURLNormalizesAndRejects(t *testing.T) {
	store := &recordingStore{}
	service := NewService(store)
	valid := CreateUploadURLInput{Key: " k/a ", ContentType: "text/plain", ContentLength: 1, ExpiresIn: time.Minute,
		ChecksumSHA256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", Metadata: map[string]string{"upload-id": "x"}}
	if _, err := service.CreateUploadURL(context.Background(), valid); err != nil || store.uploads[0].Key != "k/a" {
		t.Fatalf("valid input: %v, %+v", err, store.uploads)
	}
	cases := map[string]struct {
		change func(*CreateUploadURLInput)
		want   error
	}{
		"key":            {func(i *CreateUploadURLInput) { i.Key = "" }, ErrInvalidObjectKey},
		"content type":   {func(i *CreateUploadURLInput) { i.ContentType = "plain" }, ErrInvalidContentType},
		"expiry":         {func(i *CreateUploadURLInput) { i.ExpiresIn = 0 }, ErrInvalidURLExpiration},
		"negative size":  {func(i *CreateUploadURLInput) { i.ContentLength = -1 }, ErrInvalidObjectSize},
		"empty if-none":  {func(i *CreateUploadURLInput) { i.IfNoneMatch, i.ContentLength = true, 0 }, ErrInvalidObjectSize},
		"checksum":       {func(i *CreateUploadURLInput) { i.ChecksumSHA256 = "AAAA" }, ErrInvalidChecksum},
		"metadata key":   {func(i *CreateUploadURLInput) { i.Metadata = map[string]string{"Upper": "x"} }, ErrInvalidMetadata},
		"metadata value": {func(i *CreateUploadURLInput) { i.Metadata = map[string]string{"k": "a\nb"} }, ErrInvalidMetadata},
		"metadata count": {func(i *CreateUploadURLInput) { i.Metadata = manyEntries(maxMetadataEntries + 1) }, ErrInvalidMetadata},
	}
	for name, test := range cases {
		input := valid
		test.change(&input)
		if _, err := service.CreateUploadURL(context.Background(), input); !errors.Is(err, test.want) {
			t.Errorf("%s: error = %v, want %v", name, err, test.want)
		}
	}
	if _, err := NewService(nil).CreateUploadURL(context.Background(), valid); !errors.Is(err, ErrStoreUnavailable) {
		t.Errorf("a service without a store must be unavailable: %v", err)
	}
}

func manyEntries(count int) map[string]string {
	entries := make(map[string]string, count)
	for index := range count {
		entries[strings.Repeat("k", index+1)] = "v"
	}
	return entries
}
