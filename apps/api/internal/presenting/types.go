package presenting

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	MaxPages             = 300
	PageEdgePixels       = 1600
	ThumbnailEdgePixels  = 240
	ZoomEdgePixels       = 3200
	RenderJobPageRange   = 25
	RenderLeaseDuration  = 4 * time.Minute
	RenderAttemptLimit   = 4
	PageURLLifetime      = 2 * time.Minute
	renderJobContentType = "image/webp"
)

var (
	ErrInvalidInput      = errors.New("invalid presenting input")
	ErrPermissionDenied  = errors.New("presenting permission denied")
	ErrUnsupportedType   = errors.New("presenting attachment type unsupported")
	ErrDocumentNotFound  = errors.New("presenting document not found")
	ErrPageNotFound      = errors.New("presenting document page not found")
	ErrDocumentNotReady  = errors.New("presenting document is not ready")
	ErrZoomNotReady      = errors.New("presenting zoom render is not ready")
	ErrRenderUnavailable = errors.New("presenting renderer unavailable")
	ErrLeaseLost         = errors.New("presenting render lease lost")
	ErrNoRenderJob       = errors.New("no presenting render job available")
)

type Subject = synctokens.Subject

type Failure struct {
	Code    string
	Message string
}

type Document struct {
	TenantID     utilities.ID
	SpaceID      utilities.ID
	EpisodeID    utilities.ID
	DocumentID   utilities.ID
	AttachmentID utilities.ID
	FileName     string
	MIMEType     string
	ByteLength   int64
	SourceKey    string
	SourceSHA256 [32]byte
	Status       string
	Failure      *Failure
	PageCount    int
	Created      bool
}

type Page struct {
	DocumentID   utilities.ID
	Page         int
	Width        int
	Height       int
	Status       string
	ZoomReady    bool
	ImageURL     string
	ThumbnailURL string
	ExpiresAt    time.Time
}

type PageSpec struct {
	Page   int
	Width  int
	Height int
}

type RenderLease struct {
	TenantID    utilities.ID
	SpaceID     utilities.ID
	DocumentID  utilities.ID
	JobID       utilities.ID
	Attempt     int
	LeaseToken  utilities.ID
	LeaseOwner  string
	LeaseExpiry time.Time
	Page        int
}

type RenderJob struct {
	RenderLease
	Kind      string
	PageStart int
	PageEnd   int
}

type RenderAssignment struct {
	Job      RenderJob
	Document Document
}

type InventoryReport struct {
	Lease     RenderLease
	PageCount int
	Pages     []PageSpec
	PageOne   PageSpec
}

type RenderFailure struct {
	Code    string
	Message string
}

type InvokeInput struct {
	JobID       utilities.ID
	Synchronous bool
	JourneyID   utilities.ID
	Traceparent string
	Tracestate  string
}

type RendererInvoker interface {
	Invoke(context.Context, InvokeInput) error
}

type Repository interface {
	CreateDocument(context.Context, Subject, utilities.ID, utilities.ID) (Document, error)
	CreateRenderJob(context.Context, RenderJob) error
	AuthorizedDocument(context.Context, Subject, utilities.ID) (Document, error)
	ListPages(context.Context, Document) ([]Page, error)
	AuthorizedPage(context.Context, Subject, utilities.ID, int) (Document, Page, error)
	ClaimRenderJob(context.Context, utilities.ID, time.Time, time.Time, utilities.ID, string) (RenderAssignment, error)
	HeartbeatRenderJob(context.Context, RenderLease, time.Time) error
	CompleteInventory(context.Context, InventoryReport, int) ([]RenderJob, error)
	MarkPageReady(context.Context, RenderLease, int) error
	CompleteRenderJob(context.Context, RenderLease) error
	FailRenderJob(context.Context, RenderLease, RenderFailure) error
	CompleteZoom(context.Context, RenderLease) error
	EnsureZoomJob(context.Context, Document, int, time.Time) (RenderJob, bool, error)
	ListExpiredDocuments(context.Context, time.Time, time.Time, int) ([]Document, error)
	DeleteDocument(context.Context, Document) error
}

type ObjectStore interface {
	CreateDownloadURL(context.Context, objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error)
	CreateUploadURL(context.Context, objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error)
	DeleteObject(context.Context, string) error
}

type Service struct {
	repository Repository
	objects    ObjectStore
	invoker    RendererInvoker
	now        func() time.Time
}

func NewService(repository Repository, objects ObjectStore, invoker RendererInvoker) Service {
	return Service{repository: repository, objects: objects, invoker: invoker, now: time.Now}
}
