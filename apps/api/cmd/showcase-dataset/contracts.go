package main

import "time"

const (
	showcaseDatasetID      = "showcase-v1"
	showcaseDatasetVersion = "1.0.0"
	showcaseProduct        = "chalk"
)

type manifest struct {
	SchemaVersion      int                `json:"schemaVersion"`
	DatasetID          string             `json:"datasetId"`
	DatasetVersion     string             `json:"datasetVersion"`
	Product            string             `json:"product"`
	AnchorDate         string             `json:"anchorDate"`
	OrganizationPolicy organizationPolicy `json:"organizationPolicy"`
	TargetedPacks      []targetedPack     `json:"targetedPacks"`
	AssetRecipes       []assetRecipe      `json:"assetRecipes"`
	Records            manifestRecords    `json:"records"`
}

type organizationPolicy struct {
	RequiresExplicitKey     bool `json:"requiresExplicitKey"`
	CreateNewOnly           bool `json:"createNewOnly"`
	RejectsExistingCustomer bool `json:"rejectsExistingCustomer"`
	ProductionConfirmation  bool `json:"productionConfirmationRequired"`
	RemovalConfirmation     bool `json:"removalConfirmationRequired"`
}

type targetedPack struct {
	PackKey        string   `json:"packKey"`
	Name           string   `json:"name"`
	TenantKey      string   `json:"tenantKey"`
	SpaceKey       string   `json:"spaceKey"`
	EntryCaseKey   string   `json:"entryCaseKey"`
	ExpectedResult string   `json:"expectedResult"`
	Runbook        []string `json:"runbook"`
}

type assetRecipe struct {
	AssetKey      string            `json:"assetKey"`
	Format        string            `json:"format"`
	MimeType      string            `json:"mimeType"`
	Locale        string            `json:"locale"`
	Category      string            `json:"category"`
	Title         string            `json:"title"`
	Body          string            `json:"body"`
	Relationships map[string]string `json:"relationships"`
	Source        map[string]any    `json:"source"`
}

type manifestRecords struct {
	Organizations []organization `json:"organizations"`
	Tenants       []tenant       `json:"tenants"`
	Spaces        []space        `json:"spaces"`
	Users         []user         `json:"users"`
	Agents        []agent        `json:"agents"`
	Episodes      []episode      `json:"episodes"`
	Artifacts     []artifact     `json:"artifacts"`
}

type organization struct {
	ExternalKey string `json:"externalKey"`
	DisplayName string `json:"displayName"`
	Kind        string `json:"kind"`
}

type tenant struct {
	ExternalKey     string `json:"externalKey"`
	OrganizationKey string `json:"organizationKey"`
	DisplayName     string `json:"displayName"`
	Kind            string `json:"kind"`
}

type space struct {
	ExternalKey     string `json:"externalKey"`
	OrganizationKey string `json:"organizationKey"`
	TenantKey       string `json:"tenantKey"`
	Name            string `json:"name"`
	Visibility      string `json:"visibility"`
}

type user struct {
	ExternalKey     string `json:"externalKey"`
	OrganizationKey string `json:"organizationKey"`
	TenantKey       string `json:"tenantKey"`
	DisplayNameEN   string `json:"displayNameEn"`
	DisplayNameAR   string `json:"displayNameAr"`
	Role            string `json:"role"`
	Locale          string `json:"locale"`
}

type agent struct {
	ExternalKey     string `json:"externalKey"`
	OrganizationKey string `json:"organizationKey"`
	TenantKey       string `json:"tenantKey"`
	Name            string `json:"name"`
	Permission      string `json:"permission"`
}

type episode struct {
	ExternalKey     string     `json:"externalKey"`
	OrganizationKey string     `json:"organizationKey"`
	TenantKey       string     `json:"tenantKey"`
	SpaceKey        string     `json:"spaceKey"`
	AgentKey        string     `json:"agentKey"`
	Title           string     `json:"title"`
	Flagship        bool       `json:"flagship"`
	ArtifactSource  string     `json:"artifactSource"`
	ParticipantKeys []string   `json:"participantKeys"`
	OccurredAt      time.Time  `json:"occurredAt"`
	Chat            []chatLine `json:"chat"`
	Reactions       []reaction `json:"reactions"`
	Outcome         string     `json:"outcome"`
}

type chatLine struct {
	AuthorKey string `json:"authorKey"`
	Locale    string `json:"locale"`
	Text      string `json:"text"`
}

type reaction struct {
	UserKey string `json:"userKey"`
	Kind    string `json:"kind"`
}

type artifact struct {
	ExternalKey     string `json:"externalKey"`
	OrganizationKey string `json:"organizationKey"`
	TenantKey       string `json:"tenantKey"`
	SpaceKey        string `json:"spaceKey"`
	EpisodeKey      string `json:"episodeKey"`
	TranscriptKey   string `json:"transcriptAssetKey"`
	WhiteboardKey   string `json:"whiteboardAssetKey"`
	RecordingKey    string `json:"recordingAssetKey"`
	CaptureRequired bool   `json:"captureRequired"`
}

type assetManifest struct {
	DatasetID      string      `json:"datasetId"`
	DatasetVersion string      `json:"datasetVersion"`
	Product        string      `json:"product"`
	AnchorDate     string      `json:"anchorDate"`
	Counts         assetCounts `json:"counts"`
	Assets         []asset     `json:"assets"`
}

type assetCounts struct {
	Total                 int `json:"total"`
	Built                 int `json:"built"`
	PendingProductCapture int `json:"pendingProductCapture"`
}

type asset struct {
	AssetKey      string            `json:"assetKey"`
	ContentHash   string            `json:"contentHash"`
	MimeType      string            `json:"mimeType"`
	DatasetID     string            `json:"datasetId"`
	Product       string            `json:"product"`
	Locale        string            `json:"locale"`
	Category      string            `json:"category"`
	Title         string            `json:"title"`
	Relationships map[string]string `json:"relationships"`
	Source        map[string]any    `json:"source"`
	Status        string            `json:"status"`
	LocalPath     string            `json:"localPath"`
	StorageKey    string            `json:"storageKey"`
	ExpectedPath  string            `json:"expectedCapturePath"`
	FileSize      int64             `json:"fileSize"`
	PageCount     int               `json:"pageCount"`
}

type checksums struct {
	DatasetID      string                     `json:"datasetId"`
	DatasetVersion string                     `json:"datasetVersion"`
	Algorithm      string                     `json:"algorithm"`
	Products       map[string]checksumProduct `json:"products"`
}

type checksumProduct struct {
	Manifest checksumEntry `json:"manifest"`
	Assets   checksumEntry `json:"assets"`
}

type checksumEntry struct {
	Path        string `json:"path"`
	ContentHash string `json:"contentHash"`
}

type dataset struct {
	Manifest         manifest
	Assets           assetManifest
	ManifestRaw      []byte
	AssetsRaw        []byte
	ManifestHash     [32]byte
	AssetsHash       [32]byte
	AssetByKey       map[string]asset
	TenantByKey      map[string]tenant
	SpaceByKey       map[string]space
	UserByKey        map[string]user
	AgentByKey       map[string]agent
	EpisodeByKey     map[string]episode
	ArtifactByEpKey  map[string]artifact
	PendingAssetKeys map[string]struct{}
}

type datasetIDs struct {
	OrganizationID string
	TenantIDs      map[string]string
	SpaceIDs       map[string]string
	UserIDs        map[string]string
	IdentityIDs    map[string]string
	AgentIDs       map[string]string
	EpisodeIDs     map[string]string
	ParticipantIDs map[string]string
	SceneIDs       map[string]string
	RecordingIDs   map[string]string
	TranscriptIDs  map[string]string
}

type report struct {
	Command         string         `json:"command"`
	DatasetID       string         `json:"datasetId"`
	DatasetVersion  string         `json:"datasetVersion"`
	Product         string         `json:"product"`
	Environment     string         `json:"environment"`
	OrganizationKey string         `json:"organizationKey"`
	OrganizationID  string         `json:"organizationId,omitempty"`
	ManifestHash    string         `json:"manifestHash"`
	AssetsHash      string         `json:"assetsHash"`
	Counts          map[string]int `json:"counts"`
	PendingAssets   []string       `json:"pendingAssets"`
	Packs           []targetedPack `json:"packs"`
	Status          string         `json:"status"`
	Message         string         `json:"message,omitempty"`
	Errors          []string       `json:"errors,omitempty"`
}
