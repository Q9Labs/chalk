package httpapi

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

func TestAccessGrantRefreshHTTP(t *testing.T) {
	for _, tc := range []struct {
		name        string
		age         time.Duration
		change      string
		status      int
		code        string
		replacement bool
	}{
		{name: "current token resumes", status: 201},
		{name: "expired token replaces", age: 6 * time.Minute, status: 201, replacement: true},
		{name: "long expired token replaces", age: 24 * time.Hour, status: 201, replacement: true},
		{name: "explicit replacement", change: "replace", status: 201, replacement: true},
		{name: "bad signature", change: "signature", status: 401, code: "media_token.invalid_signature"},
		{name: "expired bad signature", age: time.Hour, change: "signature", status: 401, code: "media_token.invalid_signature"},
		{name: "wrong participant", change: "participant", status: 403, code: "media_token.subject_mismatch"},
		{name: "expired wrong participant", age: time.Hour, change: "participant", status: 403, code: "media_token.subject_mismatch"},
		{name: "expired wrong tenant", age: time.Hour, change: "tenant", status: 403, code: "media_token.subject_mismatch"},
		{name: "expired wrong space", age: time.Hour, change: "space", status: 403, code: "media_token.subject_mismatch"},
		{name: "expired wrong episode", age: time.Hour, change: "episode", status: 403, code: "media_token.subject_mismatch"},
		{name: "request generation differs", change: "request_generation", status: 409, code: "participant.generation_mismatch"},
		{name: "expired request generation differs", age: time.Hour, change: "request_generation", status: 409, code: "participant.generation_mismatch"},
		{name: "stale generation", change: "generation", status: 409, code: "participant.generation_mismatch"},
		{name: "expired stale generation", age: time.Hour, change: "generation", status: 409, code: "participant.generation_mismatch"},
		{name: "inactive unchanged", change: "inactive", status: 403, code: "access.forbidden"},
		{name: "expired inactive unchanged", age: time.Hour, change: "inactive", status: 403, code: "access.forbidden"},
		{name: "missing token", change: "missing", status: 400, code: "media_token.required"},
		{name: "malformed token", change: "malformed", status: 400, code: "media_token.malformed"},
		{name: "invalid header", change: "header", status: 400, code: "media_token.invalid_header"},
		{name: "unknown key", change: "key", status: 401, code: "media_token.unknown_key"},
		{name: "wrong issuer", age: time.Hour, change: "issuer", status: 401, code: "media_token.invalid_issuer"},
		{name: "wrong audience", age: time.Hour, change: "audience", status: 401, code: "media_token.invalid_audience"},
		{name: "invalid time claims", change: "time", status: 400, code: "media_token.invalid_time_claims"},
		{name: "not yet valid", age: -time.Minute, status: 401, code: "media_token.not_yet_valid"},
		{name: "excessive lifetime", change: "lifetime", status: 400, code: "media_token.lifetime_exceeded"},
		{name: "expired invalid subject", age: time.Hour, change: "subject", status: 400, code: "media_token.invalid_subject"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
			subject := participantMediaSubject(t)
			subject.CloudflareConnectionID = "original"
			public, private, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			tokenSubject := subject
			other := participantMediaSubject(t).SpaceID
			// The fixture IDs are distinct; use the participant ID for the space case.
			switch tc.change {
			case "participant":
				tokenSubject.ParticipantID = other
			case "tenant":
				tokenSubject.TenantID = other
			case "space":
				tokenSubject.SpaceID = subject.ParticipantID
			case "episode":
				tokenSubject.EpisodeID = other
			}
			issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "chalk", KeyID: "key", PrivateKey: private, Now: func() time.Time { return now.Add(-tc.age) }})
			if err != nil {
				t.Fatal(err)
			}
			token, err := issuer.Issue(context.Background(), tokenSubject)
			if err != nil {
				t.Fatal(err)
			}
			switch tc.change {
			case "signature":
				parts := strings.Split(token.Token, ".")
				signature, err := base64.RawURLEncoding.DecodeString(parts[2])
				if err != nil {
					t.Fatal(err)
				}
				signature[0] ^= 1
				parts[2] = base64.RawURLEncoding.EncodeToString(signature)
				token.Token = strings.Join(parts, ".")
			case "missing":
				token.Token = ""
			case "malformed":
				token.Token = "not-a-token"
			}
			if tc.change == "header" || tc.change == "key" || tc.change == "issuer" || tc.change == "audience" || tc.change == "time" || tc.change == "lifetime" || tc.change == "subject" {
				parts := strings.Split(token.Token, ".")
				part := 1
				if tc.change == "header" || tc.change == "key" {
					part = 0
				}
				raw, err := base64.RawURLEncoding.DecodeString(parts[part])
				if err != nil {
					t.Fatal(err)
				}
				var claims map[string]any
				if err := json.Unmarshal(raw, &claims); err != nil {
					t.Fatal(err)
				}
				switch tc.change {
				case "header":
					claims["alg"] = "none"
				case "key":
					claims["kid"] = "unknown"
				case "issuer":
					claims["iss"] = "wrong"
				case "audience":
					claims["aud"] = "wrong"
				case "time":
					claims["iat"] = 0
				case "lifetime":
					claims["exp"] = now.Add(10 * time.Minute).Unix()
				case "subject":
					claims["participant_generation"] = 0
				}
				raw, err = json.Marshal(claims)
				if err != nil {
					t.Fatal(err)
				}
				parts[part] = base64.RawURLEncoding.EncodeToString(raw)
				parts[2] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, []byte(parts[0]+"."+parts[1])))
				token.Token = strings.Join(parts, ".")
			}
			verifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{Issuer: "chalk", VerificationKeys: map[string]ed25519.PublicKey{"key": public}, Now: func() time.Time { return now }})
			if err != nil {
				t.Fatal(err)
			}
			repo := &refreshGrantRepository{current: synctokens.Input{TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID, ParticipantGeneration: subject.ParticipantGeneration}, connection: "original"}
			if tc.change == "generation" {
				repo.current.ParticipantGeneration++
			}
			if tc.change == "inactive" {
				repo.inactive = true
			}
			freshIssuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "chalk", KeyID: "key", PrivateKey: private, Now: func() time.Time { return now }})
			if err != nil {
				t.Fatal(err)
			}
			fixture := &refreshGrantPlane{issuer: freshIssuer}
			active := accessgrants.NewActiveAuthorizer(repo)
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
			observed := observability.InstrumentParticipantMediaVerifier(verifier, observability.NewLaunchTelemetry(logger))
			endpoint := issueAccessGrantEndpoint(fixture, fixture, observed, active, active, fixture, fixture, fixture, fixture)
			router := chi.NewRouter()
			endpoint.Mount(router, RateLimitOptions{})
			generation := subject.ParticipantGeneration
			if tc.change == "request_generation" {
				generation++
			}
			body, err := json.Marshal(issueAccessGrantBody{ParticipantGeneration: generation, CurrentMediaToken: token.Token, ReplaceMediaConnection: tc.change == "replace"})
			if err != nil {
				t.Fatal(err)
			}
			path := fmt.Sprintf("/tenants/%s/spaces/%s/episodes/%s/participants/%s/access-grant", subject.TenantID, subject.SpaceID, subject.EpisodeID, subject.ParticipantID)
			request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
			request.Header.Set("Content-Type", "application/json")
			request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), authentication.Principal{Kind: authentication.PrincipalUser, UserID: subject.ParticipantID}))
			response := httptest.NewRecorder()
			logged := observability.RequestMiddleware(logger)(router)
			logged.ServeHTTP(response, request)
			if response.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, tc.status, response.Body.String())
			}
			if tc.code != "" {
				var result struct {
					Error struct {
						Code    string `json:"code"`
						Message string `json:"message"`
					} `json:"error"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if result.Error.Code != tc.code {
					t.Fatalf("code=%q want=%q", result.Error.Code, tc.code)
				}
				if !strings.Contains(logs.String(), `"event":"access_grant.rejected"`) || !strings.Contains(logs.String(), `"code":"`+tc.code+`"`) {
					t.Fatalf("missing rejection reason: %s", logs.String())
				}
				if strings.Contains(logs.String(), token.Token) && token.Token != "" {
					t.Fatal("token leaked to logs")
				}
				if tc.change == "inactive" && result.Error.Message != "Access denied" {
					t.Fatalf("inactive response changed: %s", response.Body.String())
				}
				if fixture.created != 0 || fixture.resumed != 0 || repo.connection != "original" {
					t.Fatal("rejected request touched media")
				}
				return
			}
			if tc.change != "replace" && (!strings.Contains(logs.String(), `"outcome":"accepted"`) || strings.Contains(logs.String(), `"outcome":"rejected"`)) {
				t.Fatalf("successful grant recorded rejected authentication: %s", logs.String())
			}
			wantConnection := "original"
			if tc.replacement {
				wantConnection = "replacement"
			}
			if repo.connection != wantConnection || fixture.created != boolCount(tc.replacement) || fixture.resumed != boolCount(!tc.replacement) {
				t.Fatalf("connection=%s created=%d resumed=%d", repo.connection, fixture.created, fixture.resumed)
			}
			var grant accessGrantResponse
			if err := json.Unmarshal(response.Body.Bytes(), &grant); err != nil {
				t.Fatal(err)
			}
			issued, err := verifier.Verify(context.Background(), grant.Media.Token)
			if err != nil || issued.CloudflareConnectionID != wantConnection {
				t.Fatalf("issued subject=%+v err=%v", issued, err)
			}
			if tc.replacement && tc.change != "replace" {
				logs.Reset()
				if _, err := observed.Verify(context.Background(), token.Token); !errors.Is(err, accessgrants.ErrExpired) {
					t.Fatalf("strict authentication accepted expired token: %v", err)
				}
				if !strings.Contains(logs.String(), `"outcome":"rejected"`) {
					t.Fatalf("strict expiry was not recorded as rejected: %s", logs.String())
				}
			}
		})
	}
}

func boolCount(value bool) int {
	if value {
		return 1
	}
	return 0
}

type refreshGrantRepository struct {
	current    synctokens.Input
	inactive   bool
	connection string
}

func (r *refreshGrantRepository) GetSyncTokenSubject(context.Context, synctokens.SubjectKey) (synctokens.Input, error) {
	if r.inactive {
		return synctokens.Input{}, synctokens.ErrSubjectNotFound
	}
	return r.current, nil
}
func (r *refreshGrantRepository) SetParticipantMediaConnection(_ context.Context, _ synctokens.SubjectKey, _ int64, connection string) error {
	r.connection = connection
	return nil
}

type refreshGrantPlane struct {
	replacementGrantFixture
	created int
	resumed int
	issuer  accessgrants.Issuer
}

func (f *refreshGrantPlane) CreateJoin(ctx context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	f.created++
	return f.replacementGrantFixture.CreateJoin(ctx, input)
}
func (f *refreshGrantPlane) ResumeJoin(_ context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	f.resumed++
	return mediaplane.Join{Provider: mediaplane.ProviderCloudflareSFU, ClientPayload: map[string]any{"connectionId": input.ConnectionRef}}, nil
}
func (f *refreshGrantPlane) Resolve(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error) {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, f)
	return &service, nil
}
func (f *refreshGrantPlane) Issue(_ context.Context, subject accessgrants.Subject) (accessgrants.MediaCredential, error) {
	return f.issuer.Issue(context.Background(), subject)
}

func TestParticipantMediaStaleGenerationStillForbidden(t *testing.T) {
	subject := participantMediaSubject(t)
	repo := &refreshGrantRepository{current: synctokens.Input{ParticipantGeneration: subject.ParticipantGeneration + 1}}
	verifier := &participantMediaVerifierStub{subject: subject}
	called := false
	handler := requireParticipantMedia(verifier, accessgrants.NewActiveAuthorizer(repo))(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	request := httptest.NewRequest(http.MethodGet, "/media", nil)
	request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 403 || called {
		t.Fatalf("status=%d reached media=%v", response.Code, called)
	}
}
