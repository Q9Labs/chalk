package tenants

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/regions"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
)

var (
	ErrInvalidTenantID     = errors.New("invalid tenant id")
	ErrInvalidTenantName   = errors.New("invalid tenant name")
	ErrInvalidTenantRegion = errors.New("invalid tenant region")
	ErrInvalidTenantField  = errors.New("invalid tenant field")
	ErrTenantNotFound      = errors.New("tenant not found")
	ErrInvalidAccountID    = errors.New("invalid dashboard account id")
	ErrInvalidRequestKey   = errors.New("invalid tenant onboarding request key")
	ErrIdempotencyConflict = errors.New("tenant onboarding idempotency conflict")
)

const accountTenantInstrumentationScope = "github.com/q9labs/chalk/apps/api/internal/tenants"

const (
	defaultOnboardedTenantMediaPlane     = "cf_rtk"
	defaultOnboardedTenantProviderConfig = `{"enabled":true,"provider":"cf_rtk","mode":"chalk_managed"}`
)

var (
	onboardingRequestKeyPattern      = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)
	accountTenantTracer              = otel.Tracer(accountTenantInstrumentationScope)
	accountTenantOperationCounter, _ = otel.Meter(accountTenantInstrumentationScope).Int64Counter("chalk.api.tenant_access.operations", metric.WithUnit("{operation}"))
)

type Tenant struct {
	ID                       utilities.ID
	Name                     string
	DefaultRegion            *string
	DefaultMediaPlane        *string
	MediaPlaneProviderConfig json.RawMessage
	AIProviderConfig         json.RawMessage
	StorageProviderConfig    json.RawMessage
	LogoKey                  *string
	Website                  *string
	UpdatedAt                time.Time
	CreatedAt                time.Time
}

type TenantRepository interface {
	CreateTenant(ctx context.Context, input CreateTenantInput) (Tenant, error)
	GetTenant(ctx context.Context, id utilities.ID) (Tenant, error)
	ListTenants(ctx context.Context, page pagination.PageRequest) (TenantList, error)
	UpdateTenant(ctx context.Context, id utilities.ID, input UpdateTenantInput) (Tenant, error)
}

type Service struct {
	repository TenantRepository
}

type CreateTenantInput struct {
	ID                       utilities.ID
	Name                     string
	DefaultRegion            *string
	DefaultMediaPlane        *string
	MediaPlaneProviderConfig json.RawMessage
	AIProviderConfig         json.RawMessage
	StorageProviderConfig    json.RawMessage
	LogoKey                  *string
	Website                  *string
}

type UpdateTenantInput struct {
	Name                     utilities.OptionalString
	DefaultRegion            utilities.OptionalString
	DefaultMediaPlane        utilities.OptionalString
	MediaPlaneProviderConfig utilities.OptionalJSON
	AIProviderConfig         utilities.OptionalJSON
	StorageProviderConfig    utilities.OptionalJSON
	LogoKey                  utilities.OptionalString
	Website                  utilities.OptionalString
}

type TenantList struct {
	Tenants []Tenant
	Page    pagination.Page
}

type TenantAccess struct {
	ID        utilities.ID
	TenantID  utilities.ID
	AccountID utilities.ID
	Role      memberships.Role
	UpdatedAt time.Time
	CreatedAt time.Time
}

type AccountTenant struct {
	Tenant Tenant
	Access TenantAccess
}

type AccountTenantList struct {
	Tenants []AccountTenant
	Page    pagination.Page
}

type AccountTenantRepository interface {
	ListAccountTenants(context.Context, utilities.ID, pagination.PageRequest) (AccountTenantList, error)
	OnboardTenant(context.Context, OnboardTenantRecordInput) (OnboardTenantResult, error)
}

type AccountService struct {
	repository AccountTenantRepository
}

type OnboardTenantInput struct {
	AccountID     utilities.ID
	RequestKey    string
	Name          string
	DefaultRegion *string
}

type OnboardTenantRecordInput struct {
	AccountID          utilities.ID
	RequestKey         string
	RequestFingerprint [32]byte
	Tenant             CreateTenantInput
	AccessID           utilities.ID
}

type OnboardTenantResult struct {
	AccountTenant AccountTenant
	Replayed      bool
}

func NewService(repository TenantRepository) Service {
	return Service{repository: repository}
}

func NewAccountService(repository AccountTenantRepository) AccountService {
	return AccountService{repository: repository}
}

func (s AccountService) ListAccountTenants(ctx context.Context, accountID utilities.ID, page pagination.PageRequest) (result AccountTenantList, resultErr error) {
	ctx, finish := startAccountTenantOperation(ctx, "list")
	defer func() { finish(resultErr, false) }()
	if accountID.IsZero() {
		return AccountTenantList{}, ErrInvalidAccountID
	}
	return s.repository.ListAccountTenants(ctx, accountID, page)
}

func (s AccountService) OnboardTenant(ctx context.Context, input OnboardTenantInput) (result OnboardTenantResult, resultErr error) {
	ctx, finish := startAccountTenantOperation(ctx, "onboard")
	defer func() { finish(resultErr, result.Replayed) }()
	if input.AccountID.IsZero() {
		return OnboardTenantResult{}, ErrInvalidAccountID
	}
	if !onboardingRequestKeyPattern.MatchString(input.RequestKey) {
		return OnboardTenantResult{}, ErrInvalidRequestKey
	}

	tenantID, err := utilities.NewID()
	if err != nil {
		return OnboardTenantResult{}, fmt.Errorf("generate tenant id: %w", err)
	}
	accessID, err := utilities.NewID()
	if err != nil {
		return OnboardTenantResult{}, fmt.Errorf("generate tenant access id: %w", err)
	}
	defaultMediaPlane := defaultOnboardedTenantMediaPlane
	tenantInput := CreateTenantInput{
		ID:                       tenantID,
		Name:                     input.Name,
		DefaultRegion:            input.DefaultRegion,
		DefaultMediaPlane:        &defaultMediaPlane,
		MediaPlaneProviderConfig: json.RawMessage(defaultOnboardedTenantProviderConfig),
	}
	if err := prepareCreateTenantInput(&tenantInput); err != nil {
		return OnboardTenantResult{}, err
	}
	fingerprintPayload, err := json.Marshal(struct {
		Name          string  `json:"name"`
		DefaultRegion *string `json:"default_region"`
	}{Name: tenantInput.Name, DefaultRegion: tenantInput.DefaultRegion})
	if err != nil {
		return OnboardTenantResult{}, fmt.Errorf("fingerprint tenant onboarding: %w", err)
	}

	return s.repository.OnboardTenant(ctx, OnboardTenantRecordInput{
		AccountID: input.AccountID, RequestKey: input.RequestKey,
		RequestFingerprint: sha256.Sum256(fingerprintPayload), Tenant: tenantInput, AccessID: accessID,
	})
}

func startAccountTenantOperation(ctx context.Context, operation string) (context.Context, func(error, bool)) {
	startedAt := time.Now()
	ctx, span := accountTenantTracer.Start(ctx, "tenant_access."+operation)
	return ctx, func(err error, replayed bool) {
		outcome := "succeeded"
		logLevel := slog.LevelInfo
		if err != nil {
			outcome = "failed"
			logLevel = slog.LevelError
			if errors.Is(err, ErrInvalidAccountID) || errors.Is(err, ErrInvalidRequestKey) || errors.Is(err, ErrIdempotencyConflict) || errors.Is(err, ErrInvalidTenantName) || errors.Is(err, ErrInvalidTenantRegion) {
				outcome = "rejected"
				logLevel = slog.LevelWarn
			}
			span.SetStatus(codes.Error, outcome)
		}
		attrs := []attribute.KeyValue{attribute.String("operation", operation), attribute.String("outcome", outcome), attribute.Bool("replayed", replayed)}
		span.SetAttributes(attrs...)
		accountTenantOperationCounter.Add(ctx, 1, metric.WithAttributes(attrs...))
		slog.Default().Log(ctx, logLevel, "tenant access operation", "event", "tenant_access.operation", "operation", operation, "outcome", outcome, "replayed", replayed, "duration_ms", float64(time.Since(startedAt).Microseconds())/1000)
		span.End()
	}
}

func (s Service) CreateTenant(ctx context.Context, input CreateTenantInput) (Tenant, error) {
	id, err := utilities.NewID()
	if err != nil {
		return Tenant{}, err
	}

	input.ID = id
	if err := prepareCreateTenantInput(&input); err != nil {
		return Tenant{}, err
	}

	return s.repository.CreateTenant(ctx, input)
}

func (s Service) GetTenant(ctx context.Context, id utilities.ID) (Tenant, error) {
	if id.IsZero() {
		return Tenant{}, ErrInvalidTenantID
	}

	return s.repository.GetTenant(ctx, id)
}

func (s Service) ListTenants(ctx context.Context, page pagination.PageRequest) (TenantList, error) {
	return s.repository.ListTenants(ctx, page)
}

func (s Service) UpdateTenant(ctx context.Context, id utilities.ID, input UpdateTenantInput) (Tenant, error) {
	if id.IsZero() {
		return Tenant{}, ErrInvalidTenantID
	}
	if err := prepareUpdateTenantInput(&input); err != nil {
		return Tenant{}, err
	}

	return s.repository.UpdateTenant(ctx, id, input)
}

func (Service) AvailableRegions(ctx context.Context) ([]regions.Region, error) {
	return regions.Available(), nil
}

func prepareCreateTenantInput(input *CreateTenantInput) error {
	name, err := utilities.RequiredString(input.Name)
	if err != nil {
		return ErrInvalidTenantName
	}
	input.Name = name

	defaultRegion, err := utilities.NullableString(input.DefaultRegion)
	if err != nil {
		return ErrInvalidTenantRegion
	}
	if defaultRegion != nil && !regions.Contains(*defaultRegion) {
		return ErrInvalidTenantRegion
	}
	input.DefaultRegion = defaultRegion

	if err := prepareCreateNullableFields(input); err != nil {
		return err
	}

	return nil
}

func prepareCreateNullableFields(input *CreateTenantInput) error {
	var err error

	input.DefaultMediaPlane, err = utilities.NullableString(input.DefaultMediaPlane)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.MediaPlaneProviderConfig, err = utilities.JSON(input.MediaPlaneProviderConfig)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.AIProviderConfig, err = utilities.JSON(input.AIProviderConfig)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.StorageProviderConfig, err = utilities.JSON(input.StorageProviderConfig)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.LogoKey, err = utilities.NullableString(input.LogoKey)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.Website, err = utilities.NullableString(input.Website)
	if err != nil {
		return ErrInvalidTenantField
	}

	return nil
}

func prepareUpdateTenantInput(input *UpdateTenantInput) error {
	if input.Name.Set {
		if input.Name.Value == nil {
			return ErrInvalidTenantName
		}

		name, err := utilities.RequiredString(*input.Name.Value)
		if err != nil {
			return ErrInvalidTenantName
		}
		input.Name.Value = &name
	}

	defaultRegion, err := utilities.OptionalNullableString(input.DefaultRegion)
	if err != nil {
		return ErrInvalidTenantRegion
	}
	if defaultRegion.Set && defaultRegion.Value != nil && !regions.Contains(*defaultRegion.Value) {
		return ErrInvalidTenantRegion
	}
	input.DefaultRegion = defaultRegion

	if err := prepareUpdateNullableFields(input); err != nil {
		return err
	}

	return nil
}

func prepareUpdateNullableFields(input *UpdateTenantInput) error {
	var err error

	input.DefaultMediaPlane, err = utilities.OptionalNullableString(input.DefaultMediaPlane)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.MediaPlaneProviderConfig, err = utilities.OptionalNullableJSON(input.MediaPlaneProviderConfig)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.AIProviderConfig, err = utilities.OptionalNullableJSON(input.AIProviderConfig)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.StorageProviderConfig, err = utilities.OptionalNullableJSON(input.StorageProviderConfig)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.LogoKey, err = utilities.OptionalNullableString(input.LogoKey)
	if err != nil {
		return ErrInvalidTenantField
	}

	input.Website, err = utilities.OptionalNullableString(input.Website)
	if err != nil {
		return ErrInvalidTenantField
	}

	return nil
}
