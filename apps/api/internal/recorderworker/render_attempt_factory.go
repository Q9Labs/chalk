package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
)

const (
	nativeRenderFPS = 15
	renderVideoName = "recording.mp4"
)

var ErrInvalidProductionRenderAttempt = errors.New("invalid production recording render attempt")

// RenderAuthorityPort is the complete least-authority surface used by one
// production render attempt. Object bytes use the upload client carried by the
// implementation, never the recorder worker mTLS transport.
type RenderAuthorityPort interface {
	ResolveRenderInput(context.Context, recordingrender.Authority) (recordingrender.ResolvedInput, error)
	AccessRenderKey(context.Context, recordingrender.AccessKeyInput) (recordingrender.DataKey, error)
	DownloadRenderObject(context.Context, recordingrender.DownloadableObject, string) error
	ReserveRenderObject(context.Context, recordingrender.ReserveObjectInput) (recordingrender.ReservedObject, error)
	FinalizeRenderObject(context.Context, recordingrender.FinalizeObjectInput) (recordingrender.FinalizedObject, error)
	UploadRenderObject(context.Context, objectstorage.SignedURL, io.Reader, int64) error
	CommitRenderObject(context.Context, recordingrender.CommitObjectInput) (recordingrender.CommittedObject, error)
	CommitRender(context.Context, recordingrender.CommitInput) (recordingrender.CommitResult, error)
	CommitTranscriptionPreparation(context.Context, recordingrender.TranscriptionPreparationInput) (*recordingrender.TranscriptionResult, error)
}

type RecordingDecodeWriter func(context.Context, recordingdecode.Request) (recordingdecode.Result, error)

type ProductionRenderAttemptConfig struct {
	Control     RenderAuthorityPort
	WorkRoot    string
	Environment string
	FFmpegPath  string
	Encoder     VideoEncoder
	Compose     ComposeProducer
	Commands    CommandRunner
	Decode      RecordingDecodeWriter
	Observer    RenderAttemptObserver
	Now         func() time.Time
	RetryWait   func(context.Context, time.Duration) error
}

type ProductionRenderAttemptFactory struct {
	config ProductionRenderAttemptConfig
}

func NewProductionRenderAttemptFactory(config ProductionRenderAttemptConfig) (*ProductionRenderAttemptFactory, error) {
	config.WorkRoot = filepath.Clean(config.WorkRoot)
	config.Environment = strings.TrimSpace(config.Environment)
	config.FFmpegPath = strings.TrimSpace(config.FFmpegPath)
	if config.Decode == nil {
		config.Decode = recordingdecode.Write
	}
	if config.RetryWait == nil {
		config.RetryWait = waitForCaptureDaemon
	}
	if config.Now == nil {
		config.Now = func() time.Time { return time.Now().UTC() }
	}
	if config.Control == nil || config.Compose == nil || config.Commands == nil || !filepath.IsAbs(config.WorkRoot) || config.Environment == "" {
		return nil, ErrInvalidProductionRenderAttempt
	}
	if config.Encoder != EncoderLibX264 && config.Encoder != EncoderVideoToolbox && config.Encoder != EncoderNVENC {
		return nil, ErrInvalidProductionRenderAttempt
	}
	if info, err := os.Stat(config.WorkRoot); err != nil || !info.IsDir() {
		return nil, ErrInvalidProductionRenderAttempt
	}
	return &ProductionRenderAttemptFactory{config: config}, nil
}

func (factory *ProductionRenderAttemptFactory) NewRenderAttempt(_ context.Context, claim ClaimResult) (RenderAttempt, error) {
	if factory == nil {
		return nil, ErrInvalidProductionRenderAttempt
	}
	authority, err := renderAuthorityFromClaim(claim, factory.config.Now())
	if err != nil {
		return nil, err
	}
	workspace, err := os.MkdirTemp(factory.config.WorkRoot, "recording-render-"+authority.RecordingID.String()+"-")
	if err != nil {
		return nil, fmt.Errorf("create recording render workspace: %w", err)
	}
	if err := os.Chmod(workspace, 0o700); err != nil {
		_ = os.RemoveAll(workspace)
		return nil, fmt.Errorf("secure recording render workspace: %w", err)
	}
	return &ProductionRenderAttempt{config: factory.config, claim: claim, authority: authority, workspace: workspace}, nil
}
