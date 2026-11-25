package config

import (
	"fmt"
	"strings"
	"time"
)

const (
	R2AccessKeyID                       = "CHALK_R2_ACCESS_KEY_ID"
	R2AccountID                         = "CHALK_R2_ACCOUNT_ID"
	R2Bucket                            = "CHALK_R2_BUCKET"
	R2Endpoint                          = "CHALK_R2_ENDPOINT"
	R2SecretAccessKey                   = "CHALK_R2_SECRET_ACCESS_KEY"
	R2RequestTimeoutMS                  = "CHALK_R2_REQUEST_TIMEOUT_MS"
	TranscriptionWorkloadAuthSecret     = "CHALK_TRANSCRIPTION_WORKLOAD_AUTH_SECRET"
	TranscriptionControlAudience        = "CHALK_TRANSCRIPTION_CONTROL_AUDIENCE"
	TranscriptionDispatcherFunction     = "CHALK_TRANSCRIPTION_DISPATCHER_FUNCTION_NAME"
	PresentingWorkloadAuthSecret        = "CHALK_PRESENTING_WORKLOAD_AUTH_SECRET"
	PresentingControlAudience           = "CHALK_PRESENTING_CONTROL_AUDIENCE"
	PresentingRendererFunction          = "CHALK_PRESENTING_RENDERER_FUNCTION_NAME"
	PresentingRendererEndpoint          = "CHALK_PRESENTING_RENDERER_ENDPOINT"
	RecordingKMSKeyID                   = "CHALK_RECORDING_KMS_KEY_ID"
	RecordingKMSRegion                  = "CHALK_RECORDING_KMS_REGION"
	RecordingKMSRequestTimeoutMS        = "CHALK_RECORDING_KMS_REQUEST_TIMEOUT_MS"
	DefaultR2RequestTimeoutMS           = int64(10000)
	DefaultRecordingKMSRequestTimeoutMS = int64(10000)
	DefaultTranscriptionControlAudience = "chalk-control-api"
	DefaultR2Timeout                    = time.Duration(DefaultR2RequestTimeoutMS) * time.Millisecond
)

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

type PresentingConfig struct {
	WorkloadAuthSecret string
	ControlAudience    string
	RendererFunction   string
	RendererEndpoint   string
}

func (cfg *Config) loadTimeouts() error {
	var err error
	cfg.R2.RequestTimeout, err = envPositiveMilliseconds(R2RequestTimeoutMS, DefaultR2RequestTimeoutMS)
	if err != nil {
		return err
	}
	cfg.RecordingKMS.RequestTimeout, err = envPositiveMilliseconds(RecordingKMSRequestTimeoutMS, DefaultRecordingKMSRequestTimeoutMS)
	if err != nil {
		return err
	}
	return nil
}

func (cfg *Config) loadStorage() error {
	cfg.R2 = R2Config{
		AccessKeyID:      envOrDefault(R2AccessKeyID, ""),
		AccountID:        envOrDefault(R2AccountID, ""),
		Bucket:           envOrDefault(R2Bucket, ""),
		Endpoint:         envOrDefault(R2Endpoint, ""),
		InternalEndpoint: envOrDefault(R2InternalEndpoint, ""),
		SecretAccessKey:  envOrDefault(R2SecretAccessKey, ""),
		RequestTimeout:   cfg.R2.RequestTimeout,
	}
	var err error
	cfg.RecorderFleetIssuer, err = loadRecorderFleetIssuerConfig()
	if err != nil {
		return err
	}
	cfg.RecordingKMS = RecordingKMSConfig{
		KeyID:          strings.TrimSpace(envOrDefault(RecordingKMSKeyID, "")),
		Region:         strings.TrimSpace(envOrDefault(RecordingKMSRegion, "")),
		RequestTimeout: cfg.RecordingKMS.RequestTimeout,
	}
	if cfg.Capabilities.Recording {
		if err := validateR2Config(cfg.R2, RecordingEnabled); err != nil {
			return err
		}
		if cfg.RecordingKMS.KeyID == "" || cfg.RecordingKMS.Region == "" {
			return fmt.Errorf("%s and %s must be set when %s=true", RecordingKMSKeyID, RecordingKMSRegion, RecordingEnabled)
		}
	}
	cfg.Presenting = PresentingConfig{
		WorkloadAuthSecret: envOrDefault(PresentingWorkloadAuthSecret, ""),
		ControlAudience:    envOrDefault(PresentingControlAudience, DefaultTranscriptionControlAudience),
		RendererFunction:   envOrDefault(PresentingRendererFunction, ""),
		RendererEndpoint:   envOrDefault(PresentingRendererEndpoint, ""),
	}
	if cfg.Capabilities.Presenting && !presentingConfigComplete(cfg.Presenting, cfg.SyncToken, cfg.R2) {
		cfg.Capabilities.Presenting = false
	}
	cfg.Transcription = TranscriptionConfig{
		WorkloadAuthSecret: envOrDefault(TranscriptionWorkloadAuthSecret, ""),
		ControlAudience:    envOrDefault(TranscriptionControlAudience, DefaultTranscriptionControlAudience),
		DispatcherFunction: envOrDefault(TranscriptionDispatcherFunction, ""),
	}
	if cfg.Capabilities.Transcription {
		if err := validateTranscriptionConfig(cfg.Transcription, cfg.R2); err != nil {
			return err
		}
	}
	if cfg.Capabilities.WhiteboardFiles {
		if err := validateWhiteboardFilesConfig(cfg.SyncToken, cfg.R2); err != nil {
			return err
		}
	}
	return nil
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

func presentingConfigComplete(presenting PresentingConfig, syncToken SyncTokenConfig, r2 R2Config) bool {
	return len(presenting.WorkloadAuthSecret) >= 32 &&
		(strings.TrimSpace(presenting.RendererFunction) != "" || strings.TrimSpace(presenting.RendererEndpoint) != "") &&
		len(syncToken.PrivateKey) != 0 &&
		validateR2Config(r2, PresentingEnabled) == nil
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

const (
	DefaultRecordingKMSTimeout = time.Duration(DefaultRecordingKMSRequestTimeoutMS) * time.Millisecond
)
