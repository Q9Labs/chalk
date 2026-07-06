package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"html"
	"io"
	"math"
	"net/http"
	"net/http/httptrace"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	apiconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const databaseURLEnv = "CHALK_DATABASE_URL"

type endpoint struct {
	Name             string
	Method           string
	Path             func() string
	Body             func() string
	Request          func(*runner) endpointRequest
	Public           bool
	ExpectedStatuses []int
}

type endpointRequest struct {
	Path string
	Body string
}

type sample struct {
	Endpoint  string
	Status    int
	Expected  bool
	Bytes     int64
	Total     time.Duration
	DNS       time.Duration
	Connect   time.Duration
	TLS       time.Duration
	Write     time.Duration
	FirstByte time.Duration
	Wait      time.Duration
	Read      time.Duration
	Body      string
	Error     string
}

type endpointSummary struct {
	Count       int
	Errors      int
	Bytes       int64
	Min         time.Duration
	Max         time.Duration
	Mean        time.Duration
	P50         time.Duration
	P95         time.Duration
	P99         time.Duration
	DNS         time.Duration
	Connect     time.Duration
	TLS         time.Duration
	Write       time.Duration
	Wait        time.Duration
	Read        time.Duration
	Server      time.Duration
	DB          time.Duration
	ServerOther time.Duration
	Statuses    map[int]int
	Durations   []time.Duration
}

type phaseSummary struct {
	Name         string
	StartedAt    time.Time
	EndedAt      time.Time
	Duration     time.Duration
	Concurrency  int
	Total        int
	Errors       int
	RPS          float64
	ByEndpoint   map[string]*endpointSummary
	ProcessStats []processSample
}

type processSample struct {
	At         time.Time
	RSSKB      int64
	VSZKB      int64
	CPUPercent float64
	FDs        int
}

type runner struct {
	authToken    string
	baseURL      string
	client       *http.Client
	sessionToken string
	tenants      []perfTenant
	counter      atomic.Uint64
	mutations    atomic.Uint64
}

type perfTenant struct {
	ID           string
	RoomID       string
	SessionID    string
	RecordingID  string
	TranscriptID string
	AuditLogID   string
}

func main() {
	server := flag.String("server", "", "path to the built API server binary")
	addr := flag.String("addr", "127.0.0.1:18080", "API listen address")
	report := flag.String("report", "", "optional markdown report path")
	htmlReport := flag.String("html-report", "", "optional HTML report path")
	logDir := flag.String("log-dir", "", "directory for raw local server logs")
	loadDuration := flag.Duration("load-duration", 20*time.Second, "steady load phase duration")
	loadConcurrency := flag.Int("load-concurrency", 32, "steady load phase concurrency")
	stressDuration := flag.Duration("stress-duration", 20*time.Second, "stress phase duration")
	stressConcurrency := flag.Int("stress-concurrency", 128, "stress phase concurrency")
	seedTenants := flag.Int("seed-tenants", 64, "tenant rows to seed before load")
	startupBudget := flag.Duration("startup-budget", 5*time.Second, "startup readiness budget")
	shutdownBudget := flag.Duration("shutdown-budget", 5*time.Second, "graceful shutdown budget")
	flag.Parse()

	if *server == "" {
		fail("missing -server")
	}
	if *logDir == "" {
		fail("missing -log-dir")
	}

	if err := os.MkdirAll(*logDir, 0o755); err != nil {
		fail("create log dir: %v", err)
	}

	result, err := run(context.Background(), config{
		server:            *server,
		addr:              *addr,
		report:            *report,
		htmlReport:        *htmlReport,
		logDir:            *logDir,
		loadDuration:      *loadDuration,
		loadConcurrency:   *loadConcurrency,
		stressDuration:    *stressDuration,
		stressConcurrency: *stressConcurrency,
		seedTenants:       *seedTenants,
		startupBudget:     *startupBudget,
		shutdownBudget:    *shutdownBudget,
	})
	if err != nil {
		fail("%v", err)
	}

	if result.reportPath != "" {
		fmt.Printf("Performance report: %s\n", result.reportPath)
	}
	if result.htmlPath != "" {
		fmt.Printf("HTML performance report: %s\n", result.htmlPath)
	}
	fmt.Printf("Server log: %s\n", result.serverLog)
}

type config struct {
	server            string
	addr              string
	report            string
	htmlReport        string
	logDir            string
	loadDuration      time.Duration
	loadConcurrency   int
	stressDuration    time.Duration
	stressConcurrency int
	seedTenants       int
	startupBudget     time.Duration
	shutdownBudget    time.Duration
}

type result struct {
	reportPath string
	htmlPath   string
	serverLog  string
}

func run(ctx context.Context, cfg config) (result, error) {
	serverLog := filepath.Join(cfg.logDir, "server.jsonl")
	logFile, err := os.Create(serverLog)
	if err != nil {
		return result{}, fmt.Errorf("create server log: %w", err)
	}
	defer logFile.Close()

	cmd := exec.CommandContext(ctx, cfg.server)
	authToken, err := randomBearerToken()
	if err != nil {
		return result{}, fmt.Errorf("create local system token: %w", err)
	}
	cmd.Env = append(os.Environ(),
		"CHALK_API_ADDR="+cfg.addr,
		"CHALK_API_ENV=local",
		"CHALK_API_LOCAL_SYSTEM_TOKEN="+authToken,
		"CHALK_API_OPERATION_LOGS=1",
		"CHALK_API_PROFILER=1",
		"CHALK_API_REQUEST_LOGS=all",
	)
	cmd.Stdout = logFile
	cmd.Stderr = logFile

	startedAt := time.Now()
	if err := cmd.Start(); err != nil {
		return result{}, fmt.Errorf("start API: %w", err)
	}

	baseURL := "http://" + cfg.addr
	startupHealth, startupReady, err := waitForStartup(ctx, baseURL, cfg.startupBudget)
	if err != nil {
		killProcess(cmd)
		return result{}, err
	}

	r := runner{
		authToken: authToken,
		baseURL:   baseURL,
		client: &http.Client{
			Timeout: 5 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        1024,
				MaxIdleConnsPerHost: 1024,
				MaxConnsPerHost:     0,
				IdleConnTimeout:     30 * time.Second,
			},
		},
	}

	if err := r.seed(ctx, cfg.seedTenants); err != nil {
		killProcess(cmd)
		return result{}, fmt.Errorf("seed tenants: %w", err)
	}

	load := r.runPhase(ctx, "load", cfg.loadDuration, cfg.loadConcurrency, cmd.Process.Pid)
	stress := r.runPhase(ctx, "stress", cfg.stressDuration, cfg.stressConcurrency, cmd.Process.Pid)

	shutdownStartedAt := time.Now()
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		killProcess(cmd)
		return result{}, fmt.Errorf("send SIGTERM: %w", err)
	}
	exited := make(chan error, 1)
	go func() {
		exited <- cmd.Wait()
	}()

	select {
	case err := <-exited:
		if err != nil {
			return result{}, fmt.Errorf("API exited with error: %w", err)
		}
	case <-time.After(cfg.shutdownBudget):
		killProcess(cmd)
		return result{}, fmt.Errorf("API did not exit within %s after SIGTERM", cfg.shutdownBudget)
	}
	shutdown := time.Since(shutdownStartedAt)
	if err := logFile.Sync(); err != nil {
		return result{}, fmt.Errorf("sync server log: %w", err)
	}

	serverTimings, err := readServerTimings(serverLog, load, stress)
	if err != nil {
		return result{}, fmt.Errorf("read server timings: %w", err)
	}
	applyServerTimings(&load, serverTimings["load"])
	applyServerTimings(&stress, serverTimings["stress"])

	input := reportInput{
		ServerLog:     serverLog,
		StartupHealth: startupHealth,
		StartupReady:  startupReady,
		StartupTotal:  time.Since(startedAt) - load.Duration - stress.Duration - shutdown,
		Shutdown:      shutdown,
		Load:          load,
		Stress:        stress,
		SeedTenants:   cfg.seedTenants,
	}

	reportPath := cfg.report
	if reportPath != "" {
		if err := writeReport(reportPath, input); err != nil {
			return result{}, fmt.Errorf("write report: %w", err)
		}
	}
	htmlPath := cfg.htmlReport
	if htmlPath != "" {
		if err := writeHTMLReport(htmlPath, input); err != nil {
			return result{}, fmt.Errorf("write HTML report: %w", err)
		}
	}

	return result{reportPath: reportPath, htmlPath: htmlPath, serverLog: serverLog}, nil
}

func (r *runner) seed(ctx context.Context, count int) error {
	if count < 1 {
		count = 1
	}

	databaseURL := strings.TrimSpace(os.Getenv(databaseURLEnv))
	if databaseURL == "" {
		databaseURL = apiconfig.DefaultDatabaseURL
	}

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect postgres: %w", err)
	}
	defer pool.Close()

	seed, err := createPerfSeed(ctx, pool, count)
	if err != nil {
		return err
	}

	r.sessionToken = seed.SessionToken
	r.tenants = seed.Tenants
	return nil
}

type perfSeed struct {
	SessionToken string
	Tenants      []perfTenant
}

func createPerfSeed(ctx context.Context, pool *pgxpool.Pool, count int) (perfSeed, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return perfSeed{}, fmt.Errorf("begin perf seed transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	runID := strconv.FormatInt(time.Now().UnixNano(), 10)
	userID, err := newIDString()
	if err != nil {
		return perfSeed{}, err
	}
	sessionID, err := newIDString()
	if err != nil {
		return perfSeed{}, err
	}
	sessionToken, err := randomToken(32)
	if err != nil {
		return perfSeed{}, err
	}

	_, err = tx.Exec(ctx, `
insert into users (id, name, email)
values ($1::uuid, $2, $3)
`, userID, "Perf Local User", "perf+"+runID+"@chalk.test")
	if err != nil {
		return perfSeed{}, fmt.Errorf("insert perf user: %w", err)
	}

	_, err = tx.Exec(ctx, `
insert into login_sessions (id, user_id, token_hash, user_agent, expires_at)
values ($1::uuid, $2::uuid, $3, $4, $5)
`, sessionID, userID, authentication.SessionTokenHash(sessionToken), "chalk-api-perf", time.Now().Add(time.Hour))
	if err != nil {
		return perfSeed{}, fmt.Errorf("insert perf session: %w", err)
	}

	tenants := make([]perfTenant, 0, count)
	for i := range count {
		tenant, err := createPerfTenantSeed(ctx, tx, runID, i, userID)
		if err != nil {
			return perfSeed{}, err
		}
		tenants = append(tenants, tenant)
	}

	if err := tx.Commit(ctx); err != nil {
		return perfSeed{}, fmt.Errorf("commit perf seed transaction: %w", err)
	}

	return perfSeed{SessionToken: sessionToken, Tenants: tenants}, nil
}

func createPerfTenantSeed(ctx context.Context, tx pgx.Tx, runID string, index int, userID string) (perfTenant, error) {
	tenantID, err := newIDString()
	if err != nil {
		return perfTenant{}, err
	}
	membershipID, err := newIDString()
	if err != nil {
		return perfTenant{}, err
	}
	roomID, err := newIDString()
	if err != nil {
		return perfTenant{}, err
	}
	sessionID, err := newIDString()
	if err != nil {
		return perfTenant{}, err
	}
	recordingID, err := newIDString()
	if err != nil {
		return perfTenant{}, err
	}
	transcriptID, err := newIDString()
	if err != nil {
		return perfTenant{}, err
	}
	auditLogID, err := newIDString()
	if err != nil {
		return perfTenant{}, err
	}

	_, err = tx.Exec(ctx, `
insert into tenants (id, name, default_region, default_media_plane, media_plane_provider_config, ai_provider_config, storage_provider_config)
values ($1::uuid, $2, 'us', 'cf_sfu', '{"source":"perf"}'::jsonb, '{"source":"perf"}'::jsonb, '{"source":"perf"}'::jsonb)
`, tenantID, fmt.Sprintf("Perf Tenant %s %d", runID, index))
	if err != nil {
		return perfTenant{}, fmt.Errorf("insert perf tenant: %w", err)
	}

	_, err = tx.Exec(ctx, `
insert into memberships (id, tenant_id, user_id, role)
values ($1::uuid, $2::uuid, $3::uuid, 'owner')
`, membershipID, tenantID, userID)
	if err != nil {
		return perfTenant{}, fmt.Errorf("insert perf membership: %w", err)
	}

	_, err = tx.Exec(ctx, `
insert into rooms (id, name, tenant_id, status, slug, media_plane, metadata, created_by_user_id)
values ($1::uuid, $2, $3::uuid, 'active', $4, 'cf_sfu', '{"source":"perf"}'::jsonb, $5::uuid)
`, roomID, fmt.Sprintf("Perf Room %d", index), tenantID, fmt.Sprintf("perf-%s-%d", runID, index), userID)
	if err != nil {
		return perfTenant{}, fmt.Errorf("insert perf room: %w", err)
	}

	_, err = tx.Exec(ctx, `
insert into room_sessions (id, status, metadata, room_id, tenant_id, created_by_user_id, started_at)
values ($1::uuid, 'active', '{"source":"perf"}'::jsonb, $2::uuid, $3::uuid, $4::uuid, $5)
`, sessionID, roomID, tenantID, userID, time.Now())
	if err != nil {
		return perfTenant{}, fmt.Errorf("insert perf room session: %w", err)
	}

	_, err = tx.Exec(ctx, `
insert into recordings (id, tenant_id, room_id, session_id, status, storage_provider, storage_key, metadata)
values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'completed', 'r2', null, '{"source":"perf"}'::jsonb)
`, recordingID, tenantID, roomID, sessionID)
	if err != nil {
		return perfTenant{}, fmt.Errorf("insert perf recording: %w", err)
	}

	_, err = tx.Exec(ctx, `
insert into transcriptions (id, tenant_id, recording_id, room_id, session_id, status, provider, model, languages, text, metadata, completed_at)
values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'completed', 'deepgram', 'nova-3', array['en'], 'perf transcript', '{"source":"perf"}'::jsonb, $6)
`, transcriptID, tenantID, recordingID, roomID, sessionID, time.Now())
	if err != nil {
		return perfTenant{}, fmt.Errorf("insert perf transcript: %w", err)
	}

	_, err = tx.Exec(ctx, `
insert into audit_logs (id, tenant_id, actor_user_id, actor_type, action, details, outcome, before, after)
values ($1::uuid, $2::uuid, $3::uuid, 'user', 'perf.seed', '{"source":"perf"}'::jsonb, 'success', '{}'::jsonb, '{}'::jsonb)
`, auditLogID, tenantID, userID)
	if err != nil {
		return perfTenant{}, fmt.Errorf("insert perf audit log: %w", err)
	}

	return perfTenant{
		ID:           tenantID,
		RoomID:       roomID,
		SessionID:    sessionID,
		RecordingID:  recordingID,
		TranscriptID: transcriptID,
		AuditLogID:   auditLogID,
	}, nil
}

func (r *runner) runPhase(ctx context.Context, name string, duration time.Duration, concurrency int, pid int) phaseSummary {
	samples := make(chan sample, concurrency*4)
	var wg sync.WaitGroup
	workload := r.workload()
	deadline := time.Now().Add(duration)

	statsCtx, statsCancel := context.WithCancel(context.Background())
	statsDone := make(chan []processSample, 1)
	go func() {
		statsDone <- sampleProcess(statsCtx, pid, time.Second)
	}()

	startedAt := time.Now()
	summaryDone := make(chan phaseSummary, 1)
	go func() {
		summaryDone <- summarizeSamples(samples)
	}()

	for worker := range concurrency {
		wg.Add(1)
		go func(offset int) {
			defer wg.Done()

			for {
				select {
				case <-ctx.Done():
					return
				default:
				}
				if time.Now().After(deadline) {
					return
				}

				index := int((r.counter.Add(1) + uint64(offset)) % uint64(len(workload)))
				requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				samples <- r.doSample(requestCtx, name, workload[index])
				cancel()
			}
		}(worker)
	}

	wg.Wait()
	close(samples)
	statsCancel()

	summary := <-summaryDone
	summary.Name = name
	summary.StartedAt = startedAt
	summary.Duration = time.Since(startedAt)
	summary.EndedAt = startedAt.Add(summary.Duration)
	summary.Concurrency = concurrency

	if summary.Duration > 0 {
		summary.RPS = float64(summary.Total) / summary.Duration.Seconds()
	}
	for _, endpoint := range summary.ByEndpoint {
		if endpoint.Count > 0 {
			endpoint.Mean /= time.Duration(endpoint.Count)
			endpoint.DNS /= time.Duration(endpoint.Count)
			endpoint.Connect /= time.Duration(endpoint.Count)
			endpoint.TLS /= time.Duration(endpoint.Count)
			endpoint.Write /= time.Duration(endpoint.Count)
			endpoint.Wait /= time.Duration(endpoint.Count)
			endpoint.Read /= time.Duration(endpoint.Count)
			sort.Slice(endpoint.Durations, func(i, j int) bool {
				return endpoint.Durations[i] < endpoint.Durations[j]
			})
			endpoint.P50 = percentile(endpoint.Durations, 50)
			endpoint.P95 = percentile(endpoint.Durations, 95)
			endpoint.P99 = percentile(endpoint.Durations, 99)
		}
	}

	summary.ProcessStats = <-statsDone
	return summary
}

func summarizeSamples(samples <-chan sample) phaseSummary {
	summary := phaseSummary{
		ByEndpoint: make(map[string]*endpointSummary),
	}

	for s := range samples {
		summary.Total++
		if sampleErrored(s) {
			summary.Errors++
		}

		endpoint := summary.ByEndpoint[s.Endpoint]
		if endpoint == nil {
			endpoint = &endpointSummary{
				Min:      s.Total,
				Statuses: make(map[int]int),
			}
			summary.ByEndpoint[s.Endpoint] = endpoint
		}

		endpoint.Count++
		endpoint.Bytes += s.Bytes
		endpoint.Statuses[s.Status]++
		if sampleErrored(s) {
			endpoint.Errors++
		}
		if s.Total < endpoint.Min {
			endpoint.Min = s.Total
		}
		if s.Total > endpoint.Max {
			endpoint.Max = s.Total
		}
		endpoint.Mean += s.Total
		endpoint.DNS += s.DNS
		endpoint.Connect += s.Connect
		endpoint.TLS += s.TLS
		endpoint.Write += s.Write
		endpoint.Wait += s.Wait
		endpoint.Read += s.Read
		endpoint.Durations = append(endpoint.Durations, s.Total)
	}

	return summary
}

func sampleErrored(s sample) bool {
	if s.Error != "" || s.Status == 0 {
		return true
	}
	return s.Status >= 500 && !s.Expected
}

func (r *runner) workload() []endpoint {
	writeStatuses := []int{http.StatusOK, http.StatusCreated, http.StatusTooManyRequests}
	return []endpoint{
		{Name: "GET /healthz", Method: http.MethodGet, Path: literal("/healthz"), Public: true},
		{Name: "GET /healthz", Method: http.MethodGet, Path: literal("/healthz"), Public: true},
		{Name: "GET /readyz", Method: http.MethodGet, Path: literal("/readyz"), Public: true},
		{Name: "GET /readyz", Method: http.MethodGet, Path: literal("/readyz"), Public: true},
		{Name: "GET /v1/me", Method: http.MethodGet, Path: literal("/v1/me"), ExpectedStatuses: []int{http.StatusOK, http.StatusTooManyRequests}},
		{Name: "GET /v1/regions", Method: http.MethodGet, Path: literal("/v1/regions")},
		{Name: "GET /v1/regions", Method: http.MethodGet, Path: literal("/v1/regions")},
		{Name: "GET /v1/tenants/{id}", Method: http.MethodGet, Path: r.tenantPath},
		{Name: "GET /v1/tenants/{id}", Method: http.MethodGet, Path: r.tenantPath},
		{Name: "PATCH /v1/tenants/{id}", Method: http.MethodPatch, Path: r.tenantPath, Body: r.patchTenantBody, ExpectedStatuses: writeStatuses},
		{Name: "POST /v1/tenants", Method: http.MethodPost, Path: literal("/v1/tenants"), Body: r.createTenantBody, ExpectedStatuses: writeStatuses},
		{Name: "GET /v1/tenants/{id}/rooms", Method: http.MethodGet, Path: r.roomListPath},
		{Name: "GET /v1/tenants/{id}/rooms/{room_id}", Method: http.MethodGet, Path: r.roomPath},
		{Name: "POST /v1/tenants/{id}/rooms", Method: http.MethodPost, Request: (*runner).createRoomRequest, ExpectedStatuses: writeStatuses},
		{Name: "PATCH /v1/tenants/{id}/rooms/{room_id}", Method: http.MethodPatch, Path: r.roomPath, Body: r.patchRoomBody, ExpectedStatuses: writeStatuses},
		{Name: "GET /v1/tenants/{id}/rooms/{room_id}/sessions", Method: http.MethodGet, Path: r.roomSessionListPath},
		{Name: "GET /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}", Method: http.MethodGet, Path: r.roomSessionPath},
		{Name: "POST /v1/tenants/{id}/rooms/{room_id}/sessions", Method: http.MethodPost, Request: (*runner).createRoomSessionRequest, ExpectedStatuses: writeStatuses},
		{Name: "PATCH /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}", Method: http.MethodPatch, Path: r.roomSessionPath, Body: r.patchRoomSessionBody, ExpectedStatuses: writeStatuses},
		{Name: "GET /v1/tenants/{id}/recordings", Method: http.MethodGet, Path: r.recordingListPath},
		{Name: "GET /v1/tenants/{id}/recordings/{recording_id}", Method: http.MethodGet, Path: r.recordingPath},
		{Name: "POST /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}/recordings", Method: http.MethodPost, Request: (*runner).createRecordingRequest, ExpectedStatuses: writeStatuses},
		{Name: "PATCH /v1/tenants/{id}/recordings/{recording_id}", Method: http.MethodPatch, Path: r.recordingPath, Body: r.patchRecordingBody, ExpectedStatuses: writeStatuses},
		{Name: "POST /v1/tenants/{id}/recordings/{recording_id}/download-url", Method: http.MethodPost, Path: r.recordingDownloadPath, Body: literal(`{"expires_in_seconds":300}`), ExpectedStatuses: []int{http.StatusOK, http.StatusBadRequest, http.StatusTooManyRequests, http.StatusServiceUnavailable}},
		{Name: "GET /v1/tenants/{id}/transcripts", Method: http.MethodGet, Path: r.transcriptListPath},
		{Name: "GET /v1/tenants/{id}/transcripts/{transcript_id}", Method: http.MethodGet, Path: r.transcriptPath},
		{Name: "POST /v1/tenants/{id}/recordings/{recording_id}/transcripts", Method: http.MethodPost, Request: (*runner).createTranscriptRequest, ExpectedStatuses: writeStatuses},
		{Name: "PATCH /v1/tenants/{id}/transcripts/{transcript_id}", Method: http.MethodPatch, Path: r.transcriptPath, Body: r.patchTranscriptBody, ExpectedStatuses: writeStatuses},
		{Name: "GET /v1/tenants/{id}/audit-logs", Method: http.MethodGet, Path: r.auditLogListPath},
		{Name: "GET /v1/tenants/{id}/audit-logs/{audit_log_id}", Method: http.MethodGet, Path: r.auditLogPath},
	}
}

func (r *runner) doSample(ctx context.Context, phase string, endpoint endpoint) sample {
	res, err := r.do(ctx, phase, endpoint)
	if err != nil {
		res.Error = err.Error()
	}
	return res
}

func (r *runner) do(ctx context.Context, _ string, endpoint endpoint) (sample, error) {
	request := endpoint.request(r)
	var body io.Reader
	if request.Body != "" {
		body = strings.NewReader(request.Body)
	}

	req, err := http.NewRequestWithContext(ctx, endpoint.Method, r.baseURL+request.Path, body)
	if err != nil {
		return sample{Endpoint: endpoint.Name}, err
	}
	if request.Body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if !endpoint.Public && r.authToken != "" {
		req.Header.Set("Authorization", "Bearer "+r.authToken)
	}
	var t clientTraceState
	trace := &httptrace.ClientTrace{
		DNSStart: func(httptrace.DNSStartInfo) {
			t.dnsStart = time.Now()
		},
		DNSDone: func(httptrace.DNSDoneInfo) {
			t.dnsDone = time.Now()
		},
		ConnectStart: func(network string, addr string) {
			t.connectStart = time.Now()
		},
		ConnectDone: func(network string, addr string, err error) {
			t.connectDone = time.Now()
		},
		TLSHandshakeStart: func() {
			t.tlsStart = time.Now()
		},
		TLSHandshakeDone: func(state tls.ConnectionState, err error) {
			t.tlsDone = time.Now()
		},
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			t.wroteRequest = time.Now()
		},
		GotFirstResponseByte: func() {
			t.firstByte = time.Now()
		},
	}

	startedAt := time.Now()
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
	response, err := r.client.Do(req)
	if err != nil {
		return sample{Endpoint: endpoint.Name, Total: time.Since(startedAt)}, err
	}
	defer response.Body.Close()

	data, readErr := io.ReadAll(response.Body)
	total := time.Since(startedAt)
	setupDone := latestTime(startedAt, t.dnsDone, t.connectDone, t.tlsDone)
	firstByte := elapsed(startedAt, t.firstByte)
	res := sample{
		Endpoint:  endpoint.Name,
		Status:    response.StatusCode,
		Expected:  endpoint.acceptsStatus(response.StatusCode),
		Bytes:     int64(len(data)),
		Total:     total,
		DNS:       elapsed(t.dnsStart, t.dnsDone),
		Connect:   elapsed(t.connectStart, t.connectDone),
		TLS:       elapsed(t.tlsStart, t.tlsDone),
		Write:     elapsed(setupDone, t.wroteRequest),
		FirstByte: firstByte,
		Wait:      elapsed(t.wroteRequest, t.firstByte),
		Read:      total - firstByte,
		Body:      string(data),
	}
	if readErr != nil {
		return res, readErr
	}

	if !endpoint.acceptsStatus(response.StatusCode) {
		return res, fmt.Errorf("HTTP %d", response.StatusCode)
	}

	return res, nil
}

func (e endpoint) request(r *runner) endpointRequest {
	if e.Request != nil {
		return e.Request(r)
	}

	request := endpointRequest{}
	if e.Path != nil {
		request.Path = e.Path()
	}
	if e.Body != nil {
		request.Body = e.Body()
	}
	return request
}

func (e endpoint) acceptsStatus(status int) bool {
	if len(e.ExpectedStatuses) == 0 {
		return status >= 200 && status < 400
	}

	for _, expected := range e.ExpectedStatuses {
		if status == expected {
			return true
		}
	}
	return false
}

type clientTraceState struct {
	dnsStart     time.Time
	dnsDone      time.Time
	connectStart time.Time
	connectDone  time.Time
	tlsStart     time.Time
	tlsDone      time.Time
	wroteRequest time.Time
	firstByte    time.Time
}

func waitForStartup(ctx context.Context, baseURL string, budget time.Duration) (time.Duration, time.Duration, error) {
	startedAt := time.Now()
	health, err := waitForStatus(ctx, baseURL+"/healthz", http.StatusOK, budget)
	if err != nil {
		return 0, 0, err
	}

	remaining := budget - time.Since(startedAt)
	if remaining <= 0 {
		remaining = time.Millisecond
	}
	ready, err := waitForStatus(ctx, baseURL+"/readyz", http.StatusOK, remaining)
	if err != nil {
		return health, 0, err
	}

	return health, ready, nil
}

func waitForStatus(ctx context.Context, url string, want int, budget time.Duration) (time.Duration, error) {
	startedAt := time.Now()
	deadline := time.Now().Add(budget)
	client := http.Client{Timeout: 250 * time.Millisecond}
	var last string

	for time.Now().Before(deadline) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return 0, err
		}
		res, err := client.Do(req)
		if err == nil {
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
			if res.StatusCode == want {
				return time.Since(startedAt), nil
			}
			last = res.Status
		} else {
			last = err.Error()
		}
		time.Sleep(25 * time.Millisecond)
	}

	return 0, fmt.Errorf("%s did not return %d within %s; last result: %s", url, want, budget, last)
}

func sampleProcess(ctx context.Context, pid int, interval time.Duration) []processSample {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var samples []processSample
	for {
		samples = append(samples, readProcess(pid))

		select {
		case <-ctx.Done():
			return samples
		case <-ticker.C:
		}
	}
}

func readProcess(pid int) processSample {
	sample := processSample{At: time.Now(), FDs: -1}
	output, err := exec.Command("ps", "-o", "rss=", "-o", "vsz=", "-o", "pcpu=", "-p", strconv.Itoa(pid)).Output()
	if err == nil {
		fields := strings.Fields(string(output))
		if len(fields) >= 3 {
			sample.RSSKB = parseInt64(fields[0])
			sample.VSZKB = parseInt64(fields[1])
			sample.CPUPercent = parseFloat64(fields[2])
		}
	}

	output, err = exec.Command("lsof", "-p", strconv.Itoa(pid)).Output()
	if err == nil {
		lines := bytes.Count(output, []byte{'\n'})
		if lines > 0 {
			sample.FDs = lines - 1
		}
	}

	return sample
}

type serverTiming struct {
	Count  int
	Server time.Duration
	DB     time.Duration
}

type phaseWindow struct {
	Name  string
	Start time.Time
	End   time.Time
}

type serverLogEvent struct {
	Event      string  `json:"event"`
	Time       string  `json:"time"`
	Method     string  `json:"method"`
	Route      string  `json:"route"`
	Path       string  `json:"path"`
	DurationMS float64 `json:"duration_ms"`
}

func readServerTimings(path string, phases ...phaseSummary) (map[string]map[string]serverTiming, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	windows := make([]phaseWindow, 0, len(phases))
	for _, phase := range phases {
		if phase.Name == "" || phase.StartedAt.IsZero() || phase.EndedAt.IsZero() {
			continue
		}
		windows = append(windows, phaseWindow{
			Name:  phase.Name,
			Start: phase.StartedAt,
			End:   phase.EndedAt,
		})
	}

	timings := make(map[string]map[string]serverTiming)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 || line[0] != '{' {
			continue
		}

		var event serverLogEvent
		if err := json.Unmarshal(line, &event); err != nil {
			continue
		}
		if event.Event != "http.request" {
			continue
		}

		phaseName := eventPhase(event.Time, windows)
		if phaseName == "" {
			continue
		}

		phase := timings[phaseName]
		if phase == nil {
			phase = make(map[string]serverTiming)
			timings[phaseName] = phase
		}

		endpoint := endpointName(event.Method, event.Route, event.Path)
		timing := phase[endpoint]
		timing.Count++
		timing.Server += milliseconds(event.DurationMS)
		phase[endpoint] = timing
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	return timings, nil
}

func eventPhase(value string, windows []phaseWindow) string {
	if value == "" {
		return ""
	}

	eventTime, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return ""
	}

	for _, window := range windows {
		if (eventTime.Equal(window.Start) || eventTime.After(window.Start)) && eventTime.Before(window.End) {
			return window.Name
		}
	}
	return ""
}

func applyServerTimings(phase *phaseSummary, timings map[string]serverTiming) {
	for name, summary := range phase.ByEndpoint {
		timing := timings[name]
		if timing.Count == 0 {
			continue
		}

		summary.Server = timing.Server / time.Duration(timing.Count)
		summary.DB = timing.DB / time.Duration(timing.Count)
		summary.ServerOther = summary.Server - summary.DB
		if summary.ServerOther < 0 {
			summary.ServerOther = 0
		}
	}
}

func endpointName(method string, route string, path string) string {
	target := route
	if target == "" || target == "unmatched" {
		target = path
	}
	target = strings.ReplaceAll(target, "{tenant_id}", "{id}")
	return method + " " + target
}

func milliseconds(value float64) time.Duration {
	return time.Duration(value * float64(time.Millisecond))
}

type reportInput struct {
	ServerLog     string
	StartupHealth time.Duration
	StartupReady  time.Duration
	StartupTotal  time.Duration
	Shutdown      time.Duration
	Load          phaseSummary
	Stress        phaseSummary
	SeedTenants   int
}

func writeReport(path string, input reportInput) error {
	var b strings.Builder
	b.WriteString("# Chalk API Local Performance Report\n\n")
	b.WriteString(fmt.Sprintf("Generated: %s\n\n", time.Now().UTC().Format(time.RFC3339)))
	b.WriteString("## Scope\n\n")
	b.WriteString(fmt.Sprintf("- Seed tenants: %d\n", input.SeedTenants))
	b.WriteString("- Endpoints exercised: `/healthz`, `/readyz`, `/v1/me`, tenants, regions, rooms, room sessions, recordings, recording download URL edge, transcripts, and audit logs.\n")
	b.WriteString("- Protected `/v1` requests use a perf-only bearer session seeded directly into the configured local Postgres database.\n")
	b.WriteString("- Server log: local raw JSONL under `.private/`, not intended for commit.\n\n")
	b.WriteString("## Lifecycle\n\n")
	b.WriteString("| Measurement | Duration |\n")
	b.WriteString("| --- | ---: |\n")
	b.WriteString(fmt.Sprintf("| Startup to /healthz | %s |\n", roundDuration(input.StartupHealth)))
	b.WriteString(fmt.Sprintf("| Startup to /readyz | %s |\n", roundDuration(input.StartupReady)))
	b.WriteString(fmt.Sprintf("| Graceful shutdown after SIGTERM | %s |\n\n", roundDuration(input.Shutdown)))
	writePhase(&b, input.Load)
	writePhase(&b, input.Stress)
	b.WriteString("## Timing Shape\n\n")
	b.WriteString("With `CHALK_API_OPERATION_LOGS=1`, server logs contain `http.request` events and Postgres adapter `db.query` operation events. Client-side timings come from Go `httptrace`: connect, write, first byte, total response read. Local HTTP has no TLS timing. DB operation logs are intentionally not request-correlated.\n\n")
	b.WriteString("## Teardown\n\n")
	b.WriteString("The reusable observability layer is opt-in. To disable it, leave `CHALK_API_OPERATION_LOGS`, `CHALK_API_PROFILER`, and `CHALK_API_REQUEST_LOGS` unset. To strip it from the codebase later, remove `internal/observability`, the observability fields in config, the generic router middleware/profiler options, and `cmd/perf` plus `scripts/perf-local.sh`.\n")

	return os.WriteFile(path, []byte(b.String()), 0o644)
}

func writePhase(b *strings.Builder, phase phaseSummary) {
	b.WriteString(fmt.Sprintf("## %s Phase\n\n", phaseTitle(phase.Name)))
	b.WriteString(fmt.Sprintf("- Duration: %s\n", roundDuration(phase.Duration)))
	b.WriteString(fmt.Sprintf("- Concurrency: %d\n", phase.Concurrency))
	b.WriteString(fmt.Sprintf("- Requests: %d\n", phase.Total))
	b.WriteString(fmt.Sprintf("- Errors: %d\n", phase.Errors))
	b.WriteString(fmt.Sprintf("- Throughput: %.1f req/s\n\n", phase.RPS))

	if len(phase.ProcessStats) > 0 {
		rssMax, rssMean, cpuMax, cpuMean, fdMax := processStats(phase.ProcessStats)
		b.WriteString("| Process metric | Value |\n")
		b.WriteString("| --- | ---: |\n")
		b.WriteString(fmt.Sprintf("| RSS max | %.1f MiB |\n", float64(rssMax)/1024))
		b.WriteString(fmt.Sprintf("| RSS mean | %.1f MiB |\n", float64(rssMean)/1024))
		b.WriteString(fmt.Sprintf("| CPU max | %.1f%% |\n", cpuMax))
		b.WriteString(fmt.Sprintf("| CPU mean | %.1f%% |\n", cpuMean))
		if fdMax >= 0 {
			b.WriteString(fmt.Sprintf("| File descriptors max | %d |\n", fdMax))
		}
		b.WriteString("\n")
	}

	b.WriteString("| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |\n")
	b.WriteString("| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n")
	names := make([]string, 0, len(phase.ByEndpoint))
	for name := range phase.ByEndpoint {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		s := phase.ByEndpoint[name]
		b.WriteString(fmt.Sprintf("| `%s` | %d | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n",
			name,
			s.Count,
			s.Errors,
			formatStatuses(s.Statuses),
			roundDuration(s.Mean),
			roundDuration(s.DNS),
			roundDuration(s.Connect),
			roundDuration(s.TLS),
			roundDuration(s.Write),
			roundDuration(s.Wait),
			roundDuration(s.Read),
			roundDuration(s.Server),
			roundDuration(s.DB),
			roundDuration(s.P95),
			roundDuration(s.P99),
			roundDuration(s.Max),
		))
	}
	b.WriteString("\n")
}

func writeHTMLReport(path string, input reportInput) error {
	data, err := json.Marshal(newHTMLProfile(input))
	if err != nil {
		return err
	}

	var b strings.Builder
	b.WriteString("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
	b.WriteString("<title>Chalk API Latency Profile</title>")
	b.WriteString("<style>")
	b.WriteString(`:root{color-scheme:light;--ink:#172026;--muted:#60717b;--line:#d8e0e5;--bg:#f7f9fb;--panel:#fff;--dns:#4c9f70;--connect:#2577b1;--tls:#7c6fdb;--write:#c98b21;--wait:#d95040;--read:#3aa6a6;--server:#1d4f73;--db:#8b3f5a;--other:#aab8c2}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1180px;margin:0 auto;padding:32px 24px 48px}h1{font-size:30px;line-height:1.1;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}button,select{font:inherit}.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:24px 0}.metric{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px}.metric b{display:block;font-size:20px}.viewer{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:18px}.controls{display:flex;flex-wrap:wrap;align-items:center;gap:12px;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:18px}.phase-toggle{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}.phase-toggle button{border:0;background:#f1f5f8;color:var(--muted);padding:8px 14px;cursor:pointer}.phase-toggle button.active{background:var(--ink);color:white}select{min-width:min(100%,320px);border:1px solid var(--line);border-radius:8px;background:white;color:var(--ink);padding:8px 10px}.profile-head{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;justify-content:space-between;margin-bottom:14px}.profile-head h2{font:600 22px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:0}.meta{color:var(--muted)}.hero{display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:18px;align-items:start}.label-row{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin:6px 0}.timeline{height:54px;display:flex;overflow:hidden;border-radius:7px;background:#e8edf1;box-shadow:inset 0 0 0 1px rgba(0,0,0,.06)}.seg{display:flex;align-items:center;justify-content:center;min-width:0;color:white;font-size:12px;font-weight:650;white-space:nowrap;overflow:hidden}.dns{background:var(--dns)}.connect{background:var(--connect)}.tls{background:var(--tls)}.write{background:var(--write)}.wait{background:var(--wait)}.read{background:var(--read)}.seg span{padding:0 6px;text-shadow:0 1px 1px rgba(0,0,0,.25)}.stat-card{background:#f8fafb;border:1px solid var(--line);border-radius:8px;padding:12px}.stat-card .big{font-size:30px;font-weight:700;line-height:1}.stat-card .sub{color:var(--muted);margin-top:4px}.breakdown{display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:18px;margin-top:20px}.serverbar{height:28px;display:flex;border-radius:6px;overflow:hidden;background:#dfe7ec}.db{background:var(--db);color:white}.server-other{background:var(--server);color:white}.legend{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}.legend span{display:inline-flex;align-items:center;gap:6px;color:var(--muted)}.swatch{width:12px;height:12px;border-radius:2px}.details{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:18px}.detail{border:1px solid var(--line);border-radius:8px;padding:10px;background:#fbfcfd}.detail b{display:block}.detail span{color:var(--muted);font-size:12px}.note,.foot{margin-top:18px;color:var(--muted);font-size:13px}@media(max-width:860px){.summary,.hero,.breakdown,.details{grid-template-columns:1fr}.controls{align-items:stretch}.phase-toggle,select{width:100%}.phase-toggle button{flex:1}.profile-head h2{font-size:18px}}`)
	b.WriteString("</style></head><body><main>")
	b.WriteString("<h1>Chalk API Latency Profile</h1>")
	b.WriteString("<p>Generated ")
	b.WriteString(html.EscapeString(time.Now().UTC().Format(time.RFC3339)))
	b.WriteString(". Pick one endpoint to inspect its client waterfall and server-side breakdown.</p>")
	writeHTMLSummary(&b, input)
	writeHTMLLegend(&b)
	b.WriteString(`<section class="viewer"><div class="controls"><div class="phase-toggle" id="phase-toggle"></div><select id="endpoint-select" aria-label="Endpoint"></select></div><div id="profile"></div></section>`)
	b.WriteString("<p class=\"foot\">Raw server log: ")
	b.WriteString(html.EscapeString(input.ServerLog))
	b.WriteString(". Local HTTP has no TLS layer, and keep-alive means DNS/connect mostly disappear after connection warmup. The wait segment is client-observed time from request write to first response byte; the server bar is independently observed from server request logs bucketed into each test phase by timestamp.</p>")
	b.WriteString("<script id=\"profile-data\" type=\"application/json\">")
	b.WriteString(strings.ReplaceAll(string(data), "</", "<\\/"))
	b.WriteString("</script><script>")
	b.WriteString(`const profileData=JSON.parse(document.getElementById("profile-data").textContent);const colors={dns:"DNS",connect:"TCP connect",tls:"TLS",write:"request write",wait:"wait to first byte",read:"response read"};let phase="stress";let endpoint="";const phaseToggle=document.getElementById("phase-toggle");const endpointSelect=document.getElementById("endpoint-select");const profile=document.getElementById("profile");function fmt(ms){if(ms===0)return"0.000ms";if(ms<1)return ms.toFixed(3)+"ms";if(ms<10)return ms.toFixed(2).replace(/0$/,"").replace(/\.0$/,"")+"ms";return ms.toFixed(1).replace(/\.0$/,"")+"ms"}function pct(value,total){return total>0?value/total*100:0}function esc(value){return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}function phases(){return Object.keys(profileData.phases)}function endpoints(){return profileData.phases[phase].endpoints}function current(){return endpoints().find(e=>e.name===endpoint)||endpoints()[0]}function renderPhaseToggle(){phaseToggle.innerHTML=phases().map(p=>` + "`" + `<button type="button" class="${p===phase?"active":""}" data-phase="${p}">${p[0].toUpperCase()+p.slice(1)}</button>` + "`" + `).join("");phaseToggle.querySelectorAll("button").forEach(btn=>btn.addEventListener("click",()=>{phase=btn.dataset.phase;endpoint=endpoints()[0].name;render()}))}function renderEndpointSelect(){endpointSelect.innerHTML=endpoints().map(e=>` + "`" + `<option value="${esc(e.name)}"${e.name===endpoint?" selected":""}>${esc(e.name)}</option>` + "`" + `).join("");endpointSelect.onchange=()=>{endpoint=endpointSelect.value;renderProfile()}}function segment(name,value,total){const width=pct(value,total);if(width<=0)return"";const label=width>9?` + "`" + `<span>${colors[name]} ${fmt(value)}</span>` + "`" + `:"";return` + "`" + `<div class="seg ${name}" style="width:${width.toFixed(3)}%">${label}</div>` + "`" + `}function serverSegment(cls,label,value,total){const width=pct(value,total);if(width<=0)return"";const inner=width>11?` + "`" + `<span>${label} ${fmt(value)}</span>` + "`" + `:"";return` + "`" + `<div class="${cls}" style="width:${width.toFixed(3)}%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:650">${inner}</div>` + "`" + `}function renderProfile(){const e=current();const clientTotal=e.dns+e.connect+e.tls+e.write+e.wait+e.read||e.client_mean;const serverTotal=e.server||e.db+e.server_other;profile.innerHTML=` + "`" + `<div class="profile-head"><h2>${esc(e.name)}</h2><div class="meta">${e.count.toLocaleString()} requests · ${e.errors} errors · statuses ${esc(e.statuses)}</div></div><div class="hero"><div><div class="label-row"><span>client request waterfall</span><span>${fmt(e.client_mean)} mean · p95 ${fmt(e.p95)} · p99 ${fmt(e.p99)}</span></div><div class="timeline">${segment("dns",e.dns,clientTotal)}${segment("connect",e.connect,clientTotal)}${segment("tls",e.tls,clientTotal)}${segment("write",e.write,clientTotal)}${segment("wait",e.wait,clientTotal)}${segment("read",e.read,clientTotal)}</div></div><aside class="stat-card"><div class="big">${fmt(e.client_mean)}</div><div class="sub">client mean latency</div></aside></div><div class="breakdown"><div><div class="label-row"><span>server observed timing</span><span>${fmt(e.server)} server</span></div><div class="serverbar">${serverSegment("server-other","server",e.server,serverTotal)}</div></div><aside class="stat-card"><div class="big">${e.rps.toLocaleString(undefined,{maximumFractionDigits:1})}</div><div class="sub">phase req/s</div></aside></div><div class="details"><div class="detail"><b>${fmt(e.write)}</b><span>request write</span></div><div class="detail"><b>${fmt(e.wait)}</b><span>wait to first byte</span></div><div class="detail"><b>${fmt(e.read)}</b><span>response read</span></div><div class="detail"><b>${fmt(e.max)}</b><span>max observed</span></div></div><p class="note">This is a latency profile, not a packet capture. Client timing comes from Go httptrace. Server timing comes from API request logs bucketed by test phase. DB operation logs are available in the raw server log but are not request-correlated.</p>` + "`" + `}function render(){renderPhaseToggle();if(!endpoint)endpoint=endpoints()[0].name;renderEndpointSelect();renderProfile()}render();`)
	b.WriteString("</script>")
	b.WriteString("</main></body></html>")

	return os.WriteFile(path, []byte(b.String()), 0o644)
}

type htmlProfile struct {
	Phases map[string]htmlPhase `json:"phases"`
}

type htmlPhase struct {
	Requests  int                   `json:"requests"`
	Errors    int                   `json:"errors"`
	RPS       float64               `json:"rps"`
	Endpoints []htmlEndpointProfile `json:"endpoints"`
}

type htmlEndpointProfile struct {
	Name        string  `json:"name"`
	Count       int     `json:"count"`
	Errors      int     `json:"errors"`
	RPS         float64 `json:"rps"`
	Statuses    string  `json:"statuses"`
	ClientMean  float64 `json:"client_mean"`
	DNS         float64 `json:"dns"`
	Connect     float64 `json:"connect"`
	TLS         float64 `json:"tls"`
	Write       float64 `json:"write"`
	Wait        float64 `json:"wait"`
	Read        float64 `json:"read"`
	Server      float64 `json:"server"`
	DB          float64 `json:"db"`
	ServerOther float64 `json:"server_other"`
	P95         float64 `json:"p95"`
	P99         float64 `json:"p99"`
	Max         float64 `json:"max"`
}

func newHTMLProfile(input reportInput) htmlProfile {
	return htmlProfile{
		Phases: map[string]htmlPhase{
			"load":   newHTMLPhase(input.Load),
			"stress": newHTMLPhase(input.Stress),
		},
	}
}

func newHTMLPhase(phase phaseSummary) htmlPhase {
	names := make([]string, 0, len(phase.ByEndpoint))
	for name := range phase.ByEndpoint {
		names = append(names, name)
	}
	sort.Strings(names)

	endpoints := make([]htmlEndpointProfile, 0, len(names))
	for _, name := range names {
		s := phase.ByEndpoint[name]
		endpoints = append(endpoints, htmlEndpointProfile{
			Name:        name,
			Count:       s.Count,
			Errors:      s.Errors,
			RPS:         phase.RPS,
			Statuses:    formatStatuses(s.Statuses),
			ClientMean:  durationMS(s.Mean),
			DNS:         durationMS(s.DNS),
			Connect:     durationMS(s.Connect),
			TLS:         durationMS(s.TLS),
			Write:       durationMS(s.Write),
			Wait:        durationMS(s.Wait),
			Read:        durationMS(s.Read),
			Server:      durationMS(s.Server),
			DB:          durationMS(s.DB),
			ServerOther: durationMS(s.ServerOther),
			P95:         durationMS(s.P95),
			P99:         durationMS(s.P99),
			Max:         durationMS(s.Max),
		})
	}

	return htmlPhase{
		Requests:  phase.Total,
		Errors:    phase.Errors,
		RPS:       phase.RPS,
		Endpoints: endpoints,
	}
}

func durationMS(value time.Duration) float64 {
	return float64(value) / float64(time.Millisecond)
}

func writeHTMLSummary(b *strings.Builder, input reportInput) {
	b.WriteString("<section class=\"summary\">")
	writeHTMLMetric(b, "Startup /healthz", roundDuration(input.StartupHealth))
	writeHTMLMetric(b, "Startup /readyz", roundDuration(input.StartupReady))
	writeHTMLMetric(b, "Shutdown", roundDuration(input.Shutdown))
	writeHTMLMetric(b, "Seed tenants", strconv.Itoa(input.SeedTenants))
	b.WriteString("</section>")
}

func writeHTMLMetric(b *strings.Builder, label string, value string) {
	b.WriteString("<div class=\"metric\"><span>")
	b.WriteString(html.EscapeString(label))
	b.WriteString("</span><b>")
	b.WriteString(html.EscapeString(value))
	b.WriteString("</b></div>")
}

func writeHTMLLegend(b *strings.Builder) {
	b.WriteString("<div class=\"legend\">")
	for _, item := range []struct {
		Class string
		Label string
	}{
		{"dns", "DNS"},
		{"connect", "TCP connect"},
		{"tls", "TLS"},
		{"write", "request write"},
		{"wait", "wait to first byte"},
		{"read", "response read"},
		{"server", "server observed"},
		{"db", "DB query"},
	} {
		b.WriteString("<span><i class=\"swatch ")
		b.WriteString(item.Class)
		b.WriteString("\"></i>")
		b.WriteString(html.EscapeString(item.Label))
		b.WriteString("</span>")
	}
	b.WriteString("</div>")
}

func phaseTitle(value string) string {
	if value == "" {
		return value
	}

	return strings.ToUpper(value[:1]) + value[1:]
}

func processStats(samples []processSample) (rssMax int64, rssMean int64, cpuMax float64, cpuMean float64, fdMax int) {
	fdMax = -1
	var rssTotal int64
	var cpuTotal float64
	for _, sample := range samples {
		rssTotal += sample.RSSKB
		cpuTotal += sample.CPUPercent
		if sample.RSSKB > rssMax {
			rssMax = sample.RSSKB
		}
		if sample.CPUPercent > cpuMax {
			cpuMax = sample.CPUPercent
		}
		if sample.FDs > fdMax {
			fdMax = sample.FDs
		}
	}
	if len(samples) > 0 {
		rssMean = rssTotal / int64(len(samples))
		cpuMean = cpuTotal / float64(len(samples))
	}
	return rssMax, rssMean, cpuMax, cpuMean, fdMax
}

func formatStatuses(statuses map[int]int) string {
	keys := make([]int, 0, len(statuses))
	for status := range statuses {
		keys = append(keys, status)
	}
	sort.Ints(keys)

	parts := make([]string, 0, len(keys))
	for _, status := range keys {
		parts = append(parts, fmt.Sprintf("%d:%d", status, statuses[status]))
	}
	return strings.Join(parts, " ")
}

func percentile(values []time.Duration, percentile float64) time.Duration {
	if len(values) == 0 {
		return 0
	}

	index := int(math.Ceil((percentile/100)*float64(len(values)))) - 1
	if index < 0 {
		index = 0
	}
	if index >= len(values) {
		index = len(values) - 1
	}
	return values[index]
}

func literal(value string) func() string {
	return func() string {
		return value
	}
}

func (r *runner) tenant() perfTenant {
	if len(r.tenants) == 0 {
		return perfTenant{}
	}
	return r.tenants[int(r.counter.Load())%len(r.tenants)]
}

func (r *runner) tenantPath() string {
	return "/v1/tenants/" + r.tenant().ID
}

func (r *runner) roomListPath() string {
	return fmt.Sprintf("/v1/tenants/%s/rooms?page_size=20", r.tenant().ID)
}

func (r *runner) roomPath() string {
	tenant := r.tenant()
	return fmt.Sprintf("/v1/tenants/%s/rooms/%s", tenant.ID, tenant.RoomID)
}

func (r *runner) roomSessionListPath() string {
	tenant := r.tenant()
	return fmt.Sprintf("/v1/tenants/%s/rooms/%s/sessions?page_size=20", tenant.ID, tenant.RoomID)
}

func (r *runner) roomSessionPath() string {
	tenant := r.tenant()
	return fmt.Sprintf("/v1/tenants/%s/rooms/%s/sessions/%s", tenant.ID, tenant.RoomID, tenant.SessionID)
}

func (r *runner) recordingListPath() string {
	tenant := r.tenant()
	return fmt.Sprintf("/v1/tenants/%s/recordings?session_id=%s&page_size=20", tenant.ID, tenant.SessionID)
}

func (r *runner) recordingPath() string {
	tenant := r.tenant()
	return fmt.Sprintf("/v1/tenants/%s/recordings/%s", tenant.ID, tenant.RecordingID)
}

func (r *runner) recordingDownloadPath() string {
	tenant := r.tenant()
	return fmt.Sprintf("/v1/tenants/%s/recordings/%s/download-url", tenant.ID, tenant.RecordingID)
}

func (r *runner) transcriptListPath() string {
	tenant := r.tenant()
	return fmt.Sprintf("/v1/tenants/%s/transcripts?recording_id=%s&page_size=20", tenant.ID, tenant.RecordingID)
}

func (r *runner) transcriptPath() string {
	tenant := r.tenant()
	return fmt.Sprintf("/v1/tenants/%s/transcripts/%s", tenant.ID, tenant.TranscriptID)
}

func (r *runner) auditLogListPath() string {
	return fmt.Sprintf("/v1/tenants/%s/audit-logs?page_size=20", r.tenant().ID)
}

func (r *runner) auditLogPath() string {
	tenant := r.tenant()
	return fmt.Sprintf("/v1/tenants/%s/audit-logs/%s", tenant.ID, tenant.AuditLogID)
}

func (r *runner) createRoomRequest() endpointRequest {
	tenant := r.tenant()
	iteration := r.iteration()
	return endpointRequest{
		Path: fmt.Sprintf("/v1/tenants/%s/rooms", tenant.ID),
		Body: fmt.Sprintf(
			`{"name":"Perf Created Room %d","status":"active","slug":"perf-created-%d","media_plane":"cf_sfu","metadata":{"source":"perf","iteration":%d}}`,
			iteration,
			iteration,
			iteration,
		),
	}
}

func (r *runner) createRoomSessionRequest() endpointRequest {
	tenant := r.tenant()
	iteration := r.iteration()
	return endpointRequest{
		Path: fmt.Sprintf("/v1/tenants/%s/rooms/%s/sessions", tenant.ID, tenant.RoomID),
		Body: fmt.Sprintf(`{"status":"active","metadata":{"source":"perf","iteration":%d}}`, iteration),
	}
}

func (r *runner) createRecordingRequest() endpointRequest {
	tenant := r.tenant()
	iteration := r.iteration()
	return endpointRequest{
		Path: fmt.Sprintf("/v1/tenants/%s/rooms/%s/sessions/%s/recordings", tenant.ID, tenant.RoomID, tenant.SessionID),
		Body: fmt.Sprintf(`{"status":"completed","storage_provider":"r2","metadata":{"source":"perf","iteration":%d}}`, iteration),
	}
}

func (r *runner) createTranscriptRequest() endpointRequest {
	tenant := r.tenant()
	iteration := r.iteration()
	return endpointRequest{
		Path: fmt.Sprintf("/v1/tenants/%s/recordings/%s/transcripts", tenant.ID, tenant.RecordingID),
		Body: fmt.Sprintf(
			`{"room_id":"%s","session_id":"%s","status":"completed","provider":"deepgram","model":"nova-3","languages":["en"],"text":"perf transcript %d","metadata":{"source":"perf","iteration":%d}}`,
			tenant.RoomID,
			tenant.SessionID,
			iteration,
			iteration,
		),
	}
}

func (r *runner) patchTenantBody() string {
	return fmt.Sprintf(`{"website":"https://perf-%d.chalk.test"}`, r.iteration())
}

func (r *runner) createTenantBody() string {
	return fmt.Sprintf(`{"name":"Perf Create %d","default_region":"us"}`, r.iteration())
}

func (r *runner) patchRoomBody() string {
	return fmt.Sprintf(`{"status":"active","metadata":{"source":"perf","iteration":%d}}`, r.iteration())
}

func (r *runner) patchRoomSessionBody() string {
	return fmt.Sprintf(`{"status":"active","metadata":{"source":"perf","iteration":%d}}`, r.iteration())
}

func (r *runner) patchRecordingBody() string {
	return fmt.Sprintf(`{"status":"completed","metadata":{"source":"perf","iteration":%d}}`, r.iteration())
}

func (r *runner) patchTranscriptBody() string {
	iteration := r.iteration()
	return fmt.Sprintf(`{"status":"completed","text":"perf update %d","metadata":{"source":"perf","iteration":%d}}`, iteration, iteration)
}

func (r *runner) iteration() uint64 {
	return r.mutations.Add(1)
}

func newIDString() (string, error) {
	id, err := utilities.NewID()
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

func randomToken(byteCount int) (string, error) {
	data := make([]byte, byteCount)
	if _, err := rand.Read(data); err != nil {
		return "", fmt.Errorf("generate session token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func randomBearerToken() (string, error) {
	var data [32]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}

	return base64.RawURLEncoding.EncodeToString(data[:]), nil
}

func elapsed(start time.Time, end time.Time) time.Duration {
	if start.IsZero() || end.IsZero() || end.Before(start) {
		return 0
	}
	return end.Sub(start)
}

func latestTime(values ...time.Time) time.Time {
	var latest time.Time
	for _, value := range values {
		if value.After(latest) {
			latest = value
		}
	}
	return latest
}

func roundDuration(value time.Duration) string {
	if value < time.Millisecond {
		return fmt.Sprintf("%.3fms", float64(value.Microseconds())/1000)
	}
	return value.Round(time.Millisecond).String()
}

func parseInt64(value string) int64 {
	parsed, _ := strconv.ParseInt(value, 10, 64)
	return parsed
}

func parseFloat64(value string) float64 {
	parsed, _ := strconv.ParseFloat(value, 64)
	return parsed
}

func killProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
