package config

import (
	"strings"
	"testing"
)

func TestPresentingUnavailableUntilRendererConfigComplete(t *testing.T) {
	r2 := R2Config{Bucket: "bucket", Endpoint: "https://r2.example.test", AccessKeyID: "access", SecretAccessKey: "secret"}
	syncToken := SyncTokenConfig{PrivateKey: make([]byte, 64)}
	if len(presentingConfigProblems(PresentingConfig{}, syncToken, r2, RecordingKMSConfig{})) == 0 {
		t.Fatal("presenting is available without capability secret and renderer function")
	}
	complete := PresentingConfig{CapabilitySecret: "01234567890123456789012345678901", RendererFunction: "chalk-local-document-renderer"}
	if len(presentingConfigProblems(complete, syncToken, r2, RecordingKMSConfig{Region: "ap-southeast-1"})) != 0 {
		t.Fatal("provisioned presenting renderer config is not complete")
	}
	if len(presentingConfigProblems(complete, syncToken, R2Config{}, RecordingKMSConfig{Region: "ap-southeast-1"})) == 0 {
		t.Fatal("presenting is available without object storage")
	}
	if len(presentingConfigProblems(complete, SyncTokenConfig{}, r2, RecordingKMSConfig{Region: "ap-southeast-1"})) == 0 {
		t.Fatal("presenting is available without participant token signing keys")
	}
}

func TestPresentingConfigProblemsNameMissingPieces(t *testing.T) {
	problems := presentingConfigProblems(PresentingConfig{}, SyncTokenConfig{}, R2Config{}, RecordingKMSConfig{})
	joined := strings.Join(problems, ";")
	for _, want := range []string{PresentingCapabilitySecret, PresentingRendererFunction, PresentingRendererEndpoint, SyncTokenPrivateKey, R2Bucket, R2AccessKeyID} {
		if !strings.Contains(joined, want) {
			t.Fatalf("presenting problems omit %s: %s", want, joined)
		}
	}
}

func TestLambdaPresentingRequiresKMSRegion(t *testing.T) {
	r2 := R2Config{Bucket: "bucket", Endpoint: "https://r2.example.test", AccessKeyID: "access", SecretAccessKey: "secret"}
	syncToken := SyncTokenConfig{PrivateKey: make([]byte, 64)}
	presenting := PresentingConfig{CapabilitySecret: "01234567890123456789012345678901", RendererFunction: "chalk-production-document-renderer"}
	problems := presentingConfigProblems(presenting, syncToken, r2, RecordingKMSConfig{})
	if len(problems) != 1 || problems[0] != RecordingKMSRegion {
		t.Fatalf("lambda renderer without KMS region problems: %v", problems)
	}
	presenting.RendererEndpoint = "http://127.0.0.1:8093/invoke"
	if problems := presentingConfigProblems(presenting, syncToken, r2, RecordingKMSConfig{}); len(problems) != 0 {
		t.Fatalf("local HTTP renderer endpoint requires no KMS region: %v", problems)
	}
}
