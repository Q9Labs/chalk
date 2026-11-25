package config

import "testing"

func TestPresentingUnavailableUntilRendererConfigComplete(t *testing.T) {
	r2 := R2Config{Bucket: "bucket", Endpoint: "https://r2.example.test", AccessKeyID: "access", SecretAccessKey: "secret"}
	syncToken := SyncTokenConfig{PrivateKey: make([]byte, 64)}
	if presentingConfigComplete(PresentingConfig{}, syncToken, r2) {
		t.Fatal("presenting is available without capability secret and renderer function")
	}
	complete := PresentingConfig{CapabilitySecret: "01234567890123456789012345678901", RendererFunction: "chalk-local-document-renderer"}
	if !presentingConfigComplete(complete, syncToken, r2) {
		t.Fatal("provisioned local presenting renderer config is not complete")
	}
	if presentingConfigComplete(complete, syncToken, R2Config{}) {
		t.Fatal("presenting is available without object storage")
	}
	if presentingConfigComplete(complete, SyncTokenConfig{}, r2) {
		t.Fatal("presenting is available without participant token signing keys")
	}
}
