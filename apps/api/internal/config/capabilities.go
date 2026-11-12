package config

import (
	"fmt"
	"strings"
	"time"
)

type CapabilityConfig struct {
	Recording       bool
	Transcription   bool
	WhiteboardFiles bool
}

type R2Config struct {
	AccessKeyID     string
	AccountID       string
	Bucket          string
	Endpoint        string
	SecretAccessKey string
	RequestTimeout  time.Duration
}

type RecordingKMSConfig struct {
	KeyID          string
	Region         string
	RequestTimeout time.Duration
}

type TranscriptionConfig struct {
	WorkloadAuthSecret string
	ControlAudience    string
	DispatcherFunction string
}

func loadCapabilityConfig(environment string) (CapabilityConfig, error) {
	defaultEnabled := environment != DefaultEnvironment
	transcription, err := envStrictBool(TranscriptionEnabled, defaultEnabled)
	if err != nil {
		return CapabilityConfig{}, err
	}
	recording, err := envStrictBool(RecordingEnabled, defaultEnabled)
	if err != nil {
		return CapabilityConfig{}, err
	}
	whiteboardFiles, err := envStrictBool(WhiteboardFilesEnabled, false)
	if err != nil {
		return CapabilityConfig{}, err
	}
	return CapabilityConfig{Recording: recording, Transcription: transcription, WhiteboardFiles: whiteboardFiles}, nil
}

func validateTranscriptionConfig(transcription TranscriptionConfig, r2 R2Config) error {
	if len(transcription.WorkloadAuthSecret) < 32 {
		return fmt.Errorf("%s must contain at least 32 bytes when %s=true", TranscriptionWorkloadAuthSecret, TranscriptionEnabled)
	}
	if strings.TrimSpace(transcription.DispatcherFunction) == "" {
		return fmt.Errorf("%s must be set when %s=true", TranscriptionDispatcherFunction, TranscriptionEnabled)
	}
	if err := validateR2Config(r2, TranscriptionEnabled); err != nil {
		return err
	}
	return nil
}

func validateWhiteboardFilesConfig(syncToken SyncTokenConfig, r2 R2Config) error {
	if len(syncToken.PrivateKey) == 0 {
		return fmt.Errorf("%s, %s, %s, and %s must be set when %s=true", SyncTokenAudience, SyncTokenIssuer, SyncTokenKeyID, SyncTokenPrivateKey, WhiteboardFilesEnabled)
	}
	return validateR2Config(r2, WhiteboardFilesEnabled)
}

func validateR2Config(r2 R2Config, capability string) error {
	if strings.TrimSpace(r2.Bucket) == "" || (strings.TrimSpace(r2.AccountID) == "" && strings.TrimSpace(r2.Endpoint) == "") || strings.TrimSpace(r2.AccessKeyID) == "" || strings.TrimSpace(r2.SecretAccessKey) == "" {
		return fmt.Errorf("%s, either %s or %s, %s, and %s must be set when %s=true", R2Bucket, R2AccountID, R2Endpoint, R2AccessKeyID, R2SecretAccessKey, capability)
	}
	return nil
}

func loadR2Config() (R2Config, error) {
	requestTimeout, err := envPositiveMilliseconds(R2RequestTimeoutMS, DefaultR2RequestTimeoutMS)
	if err != nil {
		return R2Config{}, err
	}
	return R2Config{
		AccessKeyID:     envOrDefault(R2AccessKeyID, ""),
		AccountID:       envOrDefault(R2AccountID, ""),
		Bucket:          envOrDefault(R2Bucket, ""),
		Endpoint:        envOrDefault(R2Endpoint, ""),
		SecretAccessKey: envOrDefault(R2SecretAccessKey, ""),
		RequestTimeout:  requestTimeout,
	}, nil
}

func loadRecordingKMSConfig() (RecordingKMSConfig, error) {
	requestTimeout, err := envPositiveMilliseconds(RecordingKMSRequestTimeoutMS, DefaultRecordingKMSRequestTimeoutMS)
	if err != nil {
		return RecordingKMSConfig{}, err
	}
	return RecordingKMSConfig{
		KeyID:          strings.TrimSpace(envOrDefault(RecordingKMSKeyID, "")),
		Region:         strings.TrimSpace(envOrDefault(RecordingKMSRegion, "")),
		RequestTimeout: requestTimeout,
	}, nil
}
