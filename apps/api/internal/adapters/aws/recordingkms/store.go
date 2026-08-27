package recordingkms

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/kms/types"

	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
)

var (
	ErrMissingConfig  = errors.New("missing recording kms config")
	ErrProviderFailed = errors.New("recording kms provider failed")
)

type Config struct {
	KeyID          string
	Region         string
	RequestTimeout time.Duration
}

type client interface {
	GenerateDataKey(ctx context.Context, params *kms.GenerateDataKeyInput, optFns ...func(*kms.Options)) (*kms.GenerateDataKeyOutput, error)
	Decrypt(ctx context.Context, params *kms.DecryptInput, optFns ...func(*kms.Options)) (*kms.DecryptOutput, error)
}

type Store struct {
	keyID  string
	client client
}

func NewStore(ctx context.Context, config Config) (Store, error) {
	if strings.TrimSpace(config.KeyID) == "" || strings.TrimSpace(config.Region) == "" || config.RequestTimeout <= 0 {
		return Store{}, ErrMissingConfig
	}
	awsConfig, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(config.Region))
	if err != nil {
		return Store{}, fmt.Errorf("load recording kms config: %w", err)
	}
	awsConfig.HTTPClient = &http.Client{Timeout: config.RequestTimeout}
	return newStore(config.KeyID, kms.NewFromConfig(awsConfig)), nil
}

func newStore(keyID string, client client) Store {
	return Store{keyID: strings.TrimSpace(keyID), client: client}
}

func (s Store) GenerateDataKey(ctx context.Context, keyID string, encryptionContext map[string]string) (recordingkeys.GenerateDataKeyResult, error) {
	if s.client == nil || s.keyID == "" || strings.TrimSpace(keyID) != s.keyID {
		return recordingkeys.GenerateDataKeyResult{}, recordingkeys.ErrKMSUnavailable
	}
	output, err := s.client.GenerateDataKey(ctx, &kms.GenerateDataKeyInput{
		KeyId:             &s.keyID,
		KeySpec:           types.DataKeySpecAes256,
		EncryptionContext: cloneContext(encryptionContext),
	})
	if err != nil {
		return recordingkeys.GenerateDataKeyResult{}, fmt.Errorf("generate data key: %w", errors.Join(ErrProviderFailed, err))
	}
	if output == nil || len(output.Plaintext) == 0 || len(output.CiphertextBlob) == 0 {
		return recordingkeys.GenerateDataKeyResult{}, fmt.Errorf("generate data key: %w", ErrProviderFailed)
	}
	return recordingkeys.GenerateDataKeyResult{
		Plaintext:      append([]byte(nil), output.Plaintext...),
		CiphertextBlob: append([]byte(nil), output.CiphertextBlob...),
	}, nil
}

func (s Store) Decrypt(ctx context.Context, keyID string, ciphertextBlob []byte, encryptionContext map[string]string) ([]byte, error) {
	if s.client == nil || s.keyID == "" || strings.TrimSpace(keyID) != s.keyID {
		return nil, recordingkeys.ErrKMSUnavailable
	}
	if len(ciphertextBlob) == 0 {
		return nil, recordingkeys.ErrCiphertextInvalid
	}
	output, err := s.client.Decrypt(ctx, &kms.DecryptInput{
		KeyId:             &s.keyID,
		CiphertextBlob:    append([]byte(nil), ciphertextBlob...),
		EncryptionContext: cloneContext(encryptionContext),
	})
	if err != nil {
		return nil, fmt.Errorf("decrypt data key: %w", errors.Join(ErrProviderFailed, err))
	}
	if output == nil || len(output.Plaintext) == 0 {
		return nil, fmt.Errorf("decrypt data key: %w", ErrProviderFailed)
	}
	return append([]byte(nil), output.Plaintext...), nil
}

func cloneContext(value map[string]string) map[string]string {
	if len(value) == 0 {
		return nil
	}
	copyValue := make(map[string]string, len(value))
	for key, item := range value {
		copyValue[key] = item
	}
	return copyValue
}

var _ recordingkeys.KMS = Store{}
