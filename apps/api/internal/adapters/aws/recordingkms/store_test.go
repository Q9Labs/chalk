package recordingkms

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/kms/types"
	"github.com/aws/smithy-go"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
)

func TestStoreGenerateAndDecrypt(t *testing.T) {
	client := &kmsClientStub{
		generateOutput: &kms.GenerateDataKeyOutput{Plaintext: []byte("plaintext"), CiphertextBlob: []byte("ciphertext")},
		decryptOutput:  &kms.DecryptOutput{Plaintext: []byte("decrypted")},
	}
	store := newStore("arn:test:key", client)
	contextValues := map[string]string{"environment": "test", "recording_id": "recording"}

	generated, err := store.GenerateDataKey(context.Background(), "arn:test:key", contextValues)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if string(generated.Plaintext) != "plaintext" || string(generated.CiphertextBlob) != "ciphertext" || client.generateInput.KeyId == nil || *client.generateInput.KeyId != "arn:test:key" || client.generateInput.KeySpec != types.DataKeySpecAes256 {
		t.Fatalf("generate output/input = %#v / %#v", generated, client.generateInput)
	}
	contextValues["mutated"] = "caller"
	if _, ok := client.generateInput.EncryptionContext["mutated"]; ok {
		t.Fatal("provider input retained caller map mutation")
	}

	decrypted, err := store.Decrypt(context.Background(), "arn:test:key", []byte("ciphertext"), contextValues)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if string(decrypted) != "decrypted" || string(client.decryptInput.CiphertextBlob) != "ciphertext" {
		t.Fatalf("decrypt output/input = %q / %#v", decrypted, client.decryptInput)
	}
}

func TestStoreRejectsProviderFailures(t *testing.T) {
	providerErr := &smithy.GenericAPIError{Code: "KMSUnavailable", Message: "down"}
	store := newStore("key", &kmsClientStub{generateErr: providerErr, decryptErr: providerErr})
	_, err := store.GenerateDataKey(context.Background(), "key", map[string]string{"a": "b"})
	if !errors.Is(err, ErrProviderFailed) || !errors.Is(err, providerErr) {
		t.Fatalf("generate error = %v", err)
	}
	_, err = store.Decrypt(context.Background(), "key", []byte("ciphertext"), map[string]string{"a": "b"})
	if !errors.Is(err, ErrProviderFailed) || !errors.Is(err, providerErr) {
		t.Fatalf("decrypt error = %v", err)
	}
	if _, err := store.Decrypt(context.Background(), "key", nil, nil); !errors.Is(err, recordingkeys.ErrCiphertextInvalid) {
		t.Fatalf("empty ciphertext error = %v", err)
	}
}

func TestNewStoreRequiresConfig(t *testing.T) {
	if _, err := NewStore(context.Background(), Config{KeyID: "key", Region: "us-east-1"}); !errors.Is(err, ErrMissingConfig) {
		t.Fatalf("missing timeout error = %v", err)
	}
	if _, err := NewStore(context.Background(), Config{Region: "us-east-1", RequestTimeout: 1}); !errors.Is(err, ErrMissingConfig) {
		t.Fatalf("missing key error = %v", err)
	}
}

type kmsClientStub struct {
	generateInput  *kms.GenerateDataKeyInput
	decryptInput   *kms.DecryptInput
	generateOutput *kms.GenerateDataKeyOutput
	decryptOutput  *kms.DecryptOutput
	generateErr    error
	decryptErr     error
}

func (c *kmsClientStub) GenerateDataKey(_ context.Context, input *kms.GenerateDataKeyInput, _ ...func(*kms.Options)) (*kms.GenerateDataKeyOutput, error) {
	c.generateInput = input
	return c.generateOutput, c.generateErr
}

func (c *kmsClientStub) Decrypt(_ context.Context, input *kms.DecryptInput, _ ...func(*kms.Options)) (*kms.DecryptOutput, error) {
	c.decryptInput = input
	return c.decryptOutput, c.decryptErr
}

var _ = aws.String
