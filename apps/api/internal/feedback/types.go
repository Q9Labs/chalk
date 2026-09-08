package feedback

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
	"unicode"

	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	EvidenceSchemaVersion      = "FeedbackEvidence/v1"
	ReportSchemaVersion        = "FeedbackReportRequest/v1"
	ReceiptSchemaVersion       = "FeedbackReportReceipt/v1"
	ScreenshotSchemaVersion    = "FeedbackScreenshot/v1"
	MaxMessageBytes            = 8000
	MaxEvidenceBytes           = 128 * 1024
	MaxRequestBytes            = 1 << 20
	MaxScreenshotBytes         = 450 * 1024
	MaxScreenshotWidth         = 1920
	MaxScreenshotHeight        = 1080
	MaxTelemetryEvents         = 50
	MaxDiagnosticEvents        = 50
	MaxLocalStateEntries       = 32
	MaxCookieEntries           = 16
	MaxEvidenceDownloadBytes   = 128 * 1024
	MaxScreenshotDownloadBytes = 450 * 1024
)

var (
	ErrInvalidRequest        = errors.New("invalid feedback request")
	ErrInvalidEvidence       = errors.New("invalid feedback evidence")
	ErrInvalidScreenshot     = errors.New("invalid feedback screenshot")
	ErrIdempotencyConflict   = errors.New("feedback idempotency conflict")
	ErrReportNotFound        = errors.New("feedback report not found")
	ErrStorageUnavailable    = errors.New("feedback storage unavailable")
	ErrRepositoryUnavailable = errors.New("feedback repository unavailable")
	ErrForbidden             = errors.New("feedback forbidden")
	ErrUnauthenticated       = errors.New("feedback unauthenticated")
)

type Category string

const (
	CategoryBug            Category = "bug"
	CategoryFeatureRequest Category = "feature_request"
	CategoryOther          Category = "other"
)

type Source string

const (
	SourceEmbedded    Source = "embedded"
	SourceChalkWeb    Source = "chalk_web"
	SourceChalkMobile Source = "chalk_mobile"
	SourceDashboard   Source = "dashboard"
)

type SubmitterKind string

const (
	SubmitterAccount     SubmitterKind = "account"
	SubmitterParticipant SubmitterKind = "participant"
)

type FeedbackApp struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
	Build   string `json:"build,omitempty"`
}

type FeedbackSDK struct {
	Client      string `json:"client"`
	React       string `json:"react,omitempty"`
	ReactNative string `json:"react_native,omitempty"`
}

type FeedbackPlatform struct {
	Kind           string `json:"kind"`
	OSName         string `json:"os_name,omitempty"`
	OSVersion      string `json:"os_version,omitempty"`
	BrowserName    string `json:"browser_name,omitempty"`
	BrowserVersion string `json:"browser_version,omitempty"`
	DeviceClass    string `json:"device_class,omitempty"`
	DeviceModel    string `json:"device_model,omitempty"`
}

type FeedbackConnection struct {
	State     string `json:"state"`
	ErrorCode string `json:"error_code,omitempty"`
}

type FeedbackScope struct {
	SpaceID       string `json:"space_id,omitempty"`
	EpisodeID     string `json:"episode_id,omitempty"`
	ParticipantID string `json:"participant_id,omitempty"`
}

type FeedbackCorrelations struct {
	JourneyID           string `json:"journey_id,omitempty"`
	RootJourneyID       string `json:"root_journey_id,omitempty"`
	TraceID             string `json:"trace_id,omitempty"`
	SpanID              string `json:"span_id,omitempty"`
	RequestID           string `json:"request_id,omitempty"`
	CommandID           string `json:"command_id,omitempty"`
	DiagnosticReference string `json:"diagnostic_reference,omitempty"`
}

type FeedbackDiagnostics struct {
	Availability     string            `json:"availability"`
	DroppedCount     int               `json:"dropped_count"`
	TelemetryEvents  []json.RawMessage `json:"telemetry_events"`
	DiagnosticEvents []json.RawMessage `json:"diagnostic_events"`
}

type FeedbackLocalStateEntry struct {
	Key   string `json:"key"`
	Value any    `json:"value"`
}

type FeedbackLocalState struct {
	RegistryVersion string                    `json:"registry_version"`
	Entries         []FeedbackLocalStateEntry `json:"entries"`
}

type FeedbackCookieEntry struct {
	Name    string `json:"name"`
	Present bool   `json:"present"`
	Value   string `json:"value,omitempty"`
}

type FeedbackCookies struct {
	RegistryVersion string                `json:"registry_version"`
	Entries         []FeedbackCookieEntry `json:"entries"`
}

type FeedbackScreenshotState struct {
	State       string `json:"state"`
	CapturedAt  string `json:"captured_at,omitempty"`
	FailureCode string `json:"failure_code,omitempty"`
}

type FeedbackEvidence struct {
	SchemaVersion string                  `json:"schema_version"`
	CollectedAt   string                  `json:"collected_at"`
	App           *FeedbackApp            `json:"app,omitempty"`
	SDK           FeedbackSDK             `json:"sdk"`
	Platform      FeedbackPlatform        `json:"platform"`
	Connection    *FeedbackConnection     `json:"connection,omitempty"`
	Scope         *FeedbackScope          `json:"scope,omitempty"`
	Correlations  FeedbackCorrelations    `json:"correlations"`
	Diagnostics   FeedbackDiagnostics     `json:"diagnostics"`
	LocalState    FeedbackLocalState      `json:"local_state"`
	Cookies       FeedbackCookies         `json:"cookies"`
	Screenshot    FeedbackScreenshotState `json:"screenshot"`
}

type FeedbackScreenshot struct {
	SchemaVersion string `json:"schema_version"`
	MimeType      string `json:"mime_type"`
	Width         int    `json:"width"`
	Height        int    `json:"height"`
	CapturedAt    string `json:"captured_at"`
	DataBase64    string `json:"data_base64"`
}

type ReportRequest struct {
	SchemaVersion string              `json:"schema_version"`
	Category      Category            `json:"category"`
	Message       string              `json:"message"`
	Source        Source              `json:"source"`
	Evidence      FeedbackEvidence    `json:"evidence"`
	Screenshot    *FeedbackScreenshot `json:"screenshot,omitempty"`
}

type Receipt struct {
	SchemaVersion string    `json:"schema_version"`
	ID            string    `json:"id"`
	SubmittedAt   time.Time `json:"submitted_at"`
}

// FeedbackContext carries only verified, safe subject data across the HTTP
// boundary. Participant credentials themselves never enter this type.
type FeedbackContext struct {
	TenantID              utilities.ID
	UserID                utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	SubmitterKind         SubmitterKind
	SubmitterID           string
	Environment           string
	Audience              string
	DiagnosticReference   string
	JourneyID             utilities.ID
	RootJourneyID         utilities.ID
	TraceID               string
	SpanID                string
	RequestID             string
	CommandID             string
}

type SubmitInput struct {
	Context        FeedbackContext
	IdempotencyKey string
	Request        ReportRequest
}

type Report struct {
	ID                    utilities.ID
	TenantID              utilities.ID
	Category              Category
	Source                Source
	Message               string
	SubmitterKind         SubmitterKind
	SubmitterID           string
	UserID                *utilities.ID
	SpaceID               *utilities.ID
	EpisodeID             *utilities.ID
	ParticipantID         *utilities.ID
	Environment           string
	Audience              string
	DiagnosticReference   string
	JourneyID             *utilities.ID
	RootJourneyID         *utilities.ID
	TraceID               string
	SpanID                string
	RequestID             string
	CommandID             string
	SubmissionJourneyID   *utilities.ID
	SubmissionTraceID     string
	SubmissionSpanID      string
	IdempotencyKey        string
	RequestDigest         [32]byte
	EvidenceObjectKey     string
	EvidenceSize          int64
	EvidenceSHA256        [32]byte
	EvidenceSchemaVersion string
	ScreenshotFailureCode string
	Screenshot            *ScreenshotMetadata
	CreatedAt             time.Time
	SubmittedAt           time.Time
}

type ScreenshotMetadata struct {
	ObjectKey   string
	ContentType string
	Size        int64
	SHA256      [32]byte
	Width       int
	Height      int
	CapturedAt  time.Time
}

type ListInput struct {
	Category Category
	Source   Source
	TenantID *utilities.ID
	From     *time.Time
	To       *time.Time
	Cursor   *pagination.Cursor
	Limit    int
}

type ListResult struct {
	Reports    []Report
	NextCursor *pagination.Cursor
	HasMore    bool
}

type CreateInput struct {
	Report Report
}

type IdempotencyLookup struct {
	TenantID      utilities.ID
	SubmitterKind SubmitterKind
	SubmitterID   string
	Key           string
}

type Repository interface {
	GetByIdempotency(context.Context, IdempotencyLookup) (Report, error)
	Create(context.Context, CreateInput) (Report, error)
	Get(context.Context, utilities.ID) (Report, error)
	GetForTenant(context.Context, utilities.ID, utilities.ID) (Report, error)
	List(context.Context, ListInput) (ListResult, error)
}

type Object struct {
	Key         string
	ContentType string
	Size        int64
	SHA256      [32]byte
	Body        []byte
}

type ObjectStore interface {
	Put(context.Context, string, string, []byte) (Object, error)
	Get(context.Context, string) (Object, error)
	Delete(context.Context, string) error
}

type Telemetry interface {
	RecordFeedback(context.Context, string, string, string, time.Duration)
}

// ObjectStorageAdapter maps the shared objectstorage service into the narrow
// Feedback port and verifies checksums at the boundary.
type ObjectStorageAdapter struct {
	service objectstorage.Service
}

func NewObjectStorageAdapter(service objectstorage.Service) ObjectStorageAdapter {
	return ObjectStorageAdapter{service: service}
}

func (a ObjectStorageAdapter) Put(ctx context.Context, key, contentType string, body []byte) (Object, error) {
	if a.service == (objectstorage.Service{}) {
		return Object{}, ErrStorageUnavailable
	}
	checksum := sha256.Sum256(body)
	stored, err := a.service.PutObject(ctx, objectstorage.PutObjectInput{Key: key, Body: bytes.NewReader(body), ContentType: contentType, ContentLength: int64(len(body)), IfNoneMatch: true})
	if err != nil {
		return Object{}, err
	}
	return Object{Key: stored.Key, ContentType: stored.ContentType, Size: stored.Size, SHA256: checksum}, nil
}

func (a ObjectStorageAdapter) Get(ctx context.Context, key string) (Object, error) {
	if a.service == (objectstorage.Service{}) {
		return Object{}, ErrStorageUnavailable
	}
	stored, err := a.service.GetObject(ctx, key)
	if err != nil {
		return Object{}, err
	}
	body, err := io.ReadAll(io.LimitReader(stored.Body, MaxScreenshotDownloadBytes+MaxEvidenceDownloadBytes+1))
	closeErr := stored.Body.Close()
	if err != nil {
		return Object{}, err
	}
	if closeErr != nil {
		return Object{}, closeErr
	}
	if int64(len(body)) != stored.Size {
		return Object{}, ErrStorageUnavailable
	}
	return Object{Key: stored.Key, ContentType: stored.ContentType, Size: stored.Size, SHA256: sha256.Sum256(body), Body: body}, nil
}

func (a ObjectStorageAdapter) Delete(ctx context.Context, key string) error {
	if a.service == (objectstorage.Service{}) {
		return ErrStorageUnavailable
	}
	return a.service.DeleteObject(ctx, key)
}

func (r ReportRequest) canonicalDigest() ([32]byte, error) {
	encoded, err := canonicalJSON(r)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(encoded), nil
}

func (r ReportRequest) validate() (ReportRequest, []byte, [32]byte, error) {
	request := r
	request.Message = strings.TrimSpace(request.Message)
	if request.SchemaVersion != ReportSchemaVersion || !validCategory(request.Category) || !validSource(request.Source) {
		return ReportRequest{}, nil, [32]byte{}, ErrInvalidRequest
	}
	if err := validMessage(request.Message); err != nil {
		return ReportRequest{}, nil, [32]byte{}, err
	}
	if err := request.Evidence.validate(); err != nil {
		return ReportRequest{}, nil, [32]byte{}, err
	}
	if request.Screenshot != nil {
		if err := request.Screenshot.validate(); err != nil {
			return ReportRequest{}, nil, [32]byte{}, err
		}
		if request.Evidence.Screenshot.State != "captured" && request.Evidence.Screenshot.State != "partial" {
			return ReportRequest{}, nil, [32]byte{}, ErrInvalidScreenshot
		}
		if request.Evidence.Screenshot.CapturedAt == "" || request.Evidence.Screenshot.CapturedAt != request.Screenshot.CapturedAt {
			return ReportRequest{}, nil, [32]byte{}, ErrInvalidScreenshot
		}
	} else if request.Evidence.Screenshot.State == "captured" || request.Evidence.Screenshot.State == "partial" {
		return ReportRequest{}, nil, [32]byte{}, ErrInvalidScreenshot
	}
	evidenceJSON, err := canonicalJSON(request.Evidence)
	if err != nil || len(evidenceJSON) == 0 || len(evidenceJSON) > MaxEvidenceBytes {
		return ReportRequest{}, nil, [32]byte{}, ErrInvalidEvidence
	}
	digest, err := request.canonicalDigest()
	if err != nil {
		return ReportRequest{}, nil, [32]byte{}, ErrInvalidRequest
	}
	return request, evidenceJSON, digest, nil
}

func canonicalJSON(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return nil, err
	}
	return json.Marshal(decoded)
}

func validCategory(category Category) bool {
	return category == CategoryBug || category == CategoryFeatureRequest || category == CategoryOther
}

func validSource(source Source) bool {
	return source == SourceEmbedded || source == SourceChalkWeb || source == SourceChalkMobile || source == SourceDashboard
}

func validMessage(message string) error {
	if message == "" || len([]byte(message)) > MaxMessageBytes {
		return ErrInvalidRequest
	}
	for _, r := range message {
		if unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' {
			return ErrInvalidRequest
		}
	}
	return nil
}

func (e FeedbackEvidence) validate() error {
	if e.SchemaVersion != EvidenceSchemaVersion {
		return ErrInvalidEvidence
	}
	if _, err := time.Parse(time.RFC3339Nano, e.CollectedAt); err != nil {
		return ErrInvalidEvidence
	}
	if e.SDK.Client == "" || !validPlatform(e.Platform.Kind) || !validDeviceClass(e.Platform.DeviceClass) || validateFeedbackMetadata(e) != nil {
		return ErrInvalidEvidence
	}
	if e.Diagnostics.Availability != "available" && e.Diagnostics.Availability != "disabled" && e.Diagnostics.Availability != "disposed" && e.Diagnostics.Availability != "unavailable" {
		return ErrInvalidEvidence
	}
	if e.Diagnostics.DroppedCount < 0 || len(e.Diagnostics.TelemetryEvents) > MaxTelemetryEvents || len(e.Diagnostics.DiagnosticEvents) > MaxDiagnosticEvents || len(e.LocalState.Entries) > MaxLocalStateEntries || len(e.Cookies.Entries) > MaxCookieEntries {
		return ErrInvalidEvidence
	}
	if err := validateFeedbackCorrelations(e.Correlations); err != nil {
		return err
	}
	if err := validateFeedbackScope(e.Scope); err != nil {
		return err
	}
	if e.LocalState.RegistryVersion != "FeedbackLocalState/v1" || e.Cookies.RegistryVersion != "FeedbackCookies/v1" {
		return ErrInvalidEvidence
	}
	if e.Screenshot.State != "captured" && e.Screenshot.State != "partial" && e.Screenshot.State != "removed" && e.Screenshot.State != "unavailable" {
		return ErrInvalidEvidence
	}
	if e.Screenshot.CapturedAt != "" {
		if _, err := time.Parse(time.RFC3339Nano, e.Screenshot.CapturedAt); err != nil {
			return ErrInvalidEvidence
		}
	}
	if (e.Screenshot.State == "captured" || e.Screenshot.State == "partial") && e.Screenshot.CapturedAt == "" {
		return ErrInvalidEvidence
	}
	if e.Screenshot.FailureCode != "" {
		switch e.Screenshot.FailureCode {
		case "capture_failed", "unsupported", "tainted", "secure_surface", "too_large":
		default:
			return ErrInvalidEvidence
		}
		if e.Screenshot.State == "captured" || e.Screenshot.State == "partial" {
			return ErrInvalidEvidence
		}
	}
	for _, event := range e.Diagnostics.TelemetryEvents {
		if validateTelemetryEvent(event) != nil {
			return ErrInvalidEvidence
		}
	}
	for _, event := range e.Diagnostics.DiagnosticEvents {
		if len(event) == 0 || len(event) > 2048 {
			return ErrInvalidEvidence
		}
		var diagnostic episodediagnostics.DiagnosticEventDraft
		if decodeClosedJSON(event, &diagnostic) != nil || episodediagnostics.ValidateDiagnosticEventDraft(diagnostic) != nil {
			return ErrInvalidEvidence
		}
	}
	if validateLocalStateEntries(e.LocalState.Entries) != nil {
		return ErrInvalidEvidence
	}
	seenCookies := make(map[string]struct{}, len(e.Cookies.Entries))
	for _, entry := range e.Cookies.Entries {
		if entry.Name != "chalk_theme" && entry.Name != "chalk_sidebar_state" && entry.Name != "account" && entry.Name != "csrf" {
			return ErrInvalidEvidence
		}
		if _, exists := seenCookies[entry.Name]; exists {
			return ErrInvalidEvidence
		}
		seenCookies[entry.Name] = struct{}{}
		if !entry.Present && entry.Value != "" {
			return ErrInvalidEvidence
		}
		if entry.Name == "chalk_theme" && entry.Value != "" && entry.Value != "light" && entry.Value != "dark" && entry.Value != "system" {
			return ErrInvalidEvidence
		}
		if entry.Name == "chalk_sidebar_state" && entry.Value != "" && entry.Value != "true" && entry.Value != "false" {
			return ErrInvalidEvidence
		}
		if (entry.Name == "account" || entry.Name == "csrf") && entry.Value != "" {
			return ErrInvalidEvidence
		}
	}
	return nil
}

func validPlatform(kind string) bool {
	return kind == "web" || kind == "ios" || kind == "android" || kind == "macos"
}

func validDeviceClass(value string) bool {
	return value == "" || value == "phone" || value == "tablet" || value == "desktop"
}

func validateFeedbackScope(scope *FeedbackScope) error {
	if scope == nil {
		return nil
	}
	for _, value := range []string{scope.SpaceID, scope.EpisodeID, scope.ParticipantID} {
		if value == "" {
			continue
		}
		id, err := utilities.ParseID(value)
		if err != nil || id.IsZero() {
			return ErrInvalidEvidence
		}
	}
	return nil
}

func validateFeedbackCorrelations(correlations FeedbackCorrelations) error {
	for _, value := range []string{correlations.JourneyID, correlations.RootJourneyID} {
		if value == "" {
			continue
		}
		id, err := utilities.ParseID(value)
		if err != nil || id.IsZero() {
			return ErrInvalidEvidence
		}
	}
	if !validOptionalHex(correlations.TraceID, 16) || !validOptionalHex(correlations.SpanID, 8) {
		return ErrInvalidEvidence
	}
	for _, value := range []string{correlations.RequestID, correlations.CommandID} {
		if !validFeedbackToken(value, false) {
			return ErrInvalidEvidence
		}
	}
	if correlations.DiagnosticReference != "" && episodediagnostics.ValidateDiagnosticReferenceString(correlations.DiagnosticReference) != nil {
		return ErrInvalidEvidence
	}
	return nil
}

func containsControl(value string) bool {
	for _, character := range value {
		if unicode.IsControl(character) {
			return true
		}
	}
	return false
}

func (s FeedbackScreenshot) validate() error {
	if s.SchemaVersion != ScreenshotSchemaVersion || (s.MimeType != "image/jpeg" && s.MimeType != "image/png" && s.MimeType != "image/webp") || s.Width < 1 || s.Width > MaxScreenshotWidth || s.Height < 1 || s.Height > MaxScreenshotHeight {
		return ErrInvalidScreenshot
	}
	if _, err := time.Parse(time.RFC3339Nano, s.CapturedAt); err != nil {
		return ErrInvalidScreenshot
	}
	data, err := base64.StdEncoding.DecodeString(s.DataBase64)
	if err != nil || len(data) == 0 || len(data) > MaxScreenshotBytes {
		return ErrInvalidScreenshot
	}
	if err := validateScreenshotBytes(data, s.MimeType, s.Width, s.Height); err != nil {
		return err
	}
	return nil
}

func (r Report) Receipt() Receipt {
	return Receipt{SchemaVersion: ReceiptSchemaVersion, ID: r.ID.String(), SubmittedAt: r.SubmittedAt}
}

func (r Report) EvidenceChecksum() string {
	return hex.EncodeToString(r.EvidenceSHA256[:])
}

func screenshotData(s *FeedbackScreenshot) ([]byte, error) {
	if s == nil {
		return nil, nil
	}
	data, err := base64.StdEncoding.DecodeString(s.DataBase64)
	if err != nil {
		return nil, ErrInvalidScreenshot
	}
	return data, nil
}

func objectMetadata(object Object, contentType string) Object {
	if object.ContentType == "" {
		object.ContentType = contentType
	}
	if object.Size == 0 && object.Body != nil {
		object.Size = int64(len(object.Body))
	}
	if object.SHA256 == [32]byte{} && object.Body != nil {
		object.SHA256 = sha256.Sum256(object.Body)
	}
	return object
}

var _ ObjectStore = ObjectStorageAdapter{}
