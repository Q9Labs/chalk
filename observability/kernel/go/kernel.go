// Package obs is the observability kernel: five calls (Op, Transition, Decision, Surface, Fact) that write one
// registry-checked record each through slog. In closed mode (tests, or CHALK_OBS_MODE=closed) a violation panics;
// in open mode (production) it is counted and the record still goes out. See observability/registry/README.md.
package obs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

// Mode says what a registry violation does.
type Mode int

const (
	// ModeAuto is closed under go test or CHALK_OBS_MODE=closed, and open otherwise.
	ModeAuto Mode = iota
	// ModeOpen counts violations and still emits the record.
	ModeOpen
	// ModeClosed panics on a violation.
	ModeClosed
)

// Config is the process's envelope and output. Configure it once at startup.
type Config struct {
	// Logger receives every record. Nil means slog.Default() at the time of each record.
	Logger *slog.Logger
	Mode   Mode
	// Module, Env and Platform must be registry values. ReleaseSHA is the build's commit.
	Module, Env, Platform, ReleaseSHA string
	// SourceID owns seq. Empty means a random instance id.
	SourceID string
	// Trail adds the ID trail known from the context, such as the Episode and Participant.
	Trail func(context.Context) []slog.Attr
}

type state struct {
	config    Config
	closed    bool
	sourceID  string
	flagsHash string
}

var (
	current        atomic.Pointer[state]
	seq            atomic.Int64
	violations     atomic.Int64
	exportFailures atomic.Int64
)

func init() { Configure(Config{}) }

// Configure replaces the process configuration.
func Configure(config Config) {
	closed := config.Mode == ModeClosed || (config.Mode == ModeAuto && (testing.Testing() || os.Getenv("CHALK_OBS_MODE") == "closed"))
	sourceID := config.SourceID
	if sourceID == "" {
		sourceID = newID()
	}
	previous := current.Load()
	next := &state{config: config, closed: closed, sourceID: sourceID}
	if previous != nil {
		next.flagsHash = previous.flagsHash
	}
	current.Store(next)
}

// Stats reports what open mode counted instead of panicking.
func Stats() (violationCount, exportFailureCount int64) {
	return violations.Load(), exportFailures.Load()
}

// F is an attribute for a registry field.
func F(field string, value any) slog.Attr { return slog.Any(field, value) }

// Scope is what an op's function can say about its own outcome.
type Scope struct {
	opID     string
	expected string
	attrs    []slog.Attr
}

// OpID is the op's id, linked as parent_op_id by ops started from its context.
func (s *Scope) OpID() string { return s.opID }

// Expected ends the op as expected(code) when it returns nil.
func (s *Scope) Expected(code string) { s.expected = code }

// Set adds event fields learned while the op ran.
func (s *Scope) Set(attrs ...slog.Attr) { s.attrs = append(s.attrs, attrs...) }

type opKey struct{}

// Op runs fn and records exactly one terminal outcome: ok, expected(code) or error(code). An error that is not
// Classified becomes error(unclassified), a cancelled context becomes expected(cancelled), and a panic is recorded
// as error(unclassified) before it continues.
func Op(ctx context.Context, name string, fn func(context.Context, *Scope) error, attrs ...slog.Attr) (err error) {
	st := current.Load()
	scope := &Scope{opID: newID()}
	parent, _ := ctx.Value(opKey{}).(string)
	started := time.Now()
	outcome, code := "ok", ""
	defer func() {
		recovered := recover()
		if recovered != nil {
			outcome, code = "error", ReasonUnclassified
		}
		all := append(slices.Clone(attrs), scope.attrs...)
		problems := eventProblems(name, "op", all)
		if problem := reasonProblem(code, outcome); problem != "" {
			problems = append(problems, name+": "+problem)
		}
		violate(st, problems)
		own := []slog.Attr{slog.String(FieldOutcome, outcome), slog.Int64(FieldDurationMs, time.Since(started).Milliseconds()), slog.String(FieldOpID, scope.opID)}
		if code != "" {
			own = append(own, slog.String(FieldReasonCode, code))
		}
		if parent != "" {
			own = append(own, slog.String(FieldParentOpID, parent))
		}
		send(ctx, st, "op", name, all, own, outcome == "error")
		if recovered != nil {
			panic(recovered)
		}
	}()
	err = fn(context.WithValue(ctx, opKey{}, scope.opID), scope)
	var classified *Classified
	switch {
	case err == nil && scope.expected != "":
		outcome, code = "expected", scope.expected
	case err == nil:
	case errors.As(err, &classified):
		outcome, code = classified.Outcome, classified.Code
		if classified.Err != nil {
			err = classified.Err
		}
	case errors.Is(err, context.Canceled):
		outcome, code = "expected", ReasonCancelled
	default:
		outcome, code = "error", ReasonUnclassified
	}
	return err
}

// Move is one state change of a registry machine.
type Move struct {
	Machine, From, To, Trigger string
	// Reason is an optional registry reason code, such as why a connection failed.
	Reason string
	// Duration is how long the previous state lasted, when the owner knows it.
	Duration time.Duration
}

// Transition records a state change, checked against the machine's declared edges and triggers.
func Transition(ctx context.Context, move Move, attrs ...slog.Attr) {
	st := current.Load()
	spec, ok := registryMachines[move.Machine]
	problems := fieldProblems(move.Machine, attrs, nil)
	if !ok {
		problems = append(problems, "unknown machine "+move.Machine)
	} else {
		if !slices.Contains(spec.edges, [2]string{move.From, move.To}) {
			problems = append(problems, fmt.Sprintf("%s: %s -> %s is not a declared edge", move.Machine, move.From, move.To))
		}
		if !slices.Contains(spec.triggers, move.Trigger) {
			problems = append(problems, fmt.Sprintf("%s: unknown trigger %s", move.Machine, move.Trigger))
		}
	}
	if problem := reasonProblem(move.Reason, ""); problem != "" {
		problems = append(problems, move.Machine+": "+problem)
	}
	violate(st, problems)
	own := []slog.Attr{slog.String(FieldMachine, move.Machine), slog.String(FieldFromState, move.From), slog.String(FieldToState, move.To), slog.String(FieldTrigger, move.Trigger)}
	if move.Reason != "" {
		own = append(own, slog.String(FieldReasonCode, move.Reason))
	}
	if move.Duration > 0 {
		own = append(own, slog.Int64(FieldDurationMs, move.Duration.Milliseconds()))
	}
	send(ctx, st, "transition", move.Machine, attrs, own, false)
}

// Decision records an authoritative server decision and returns its decision_id. Call it after the decision commits.
func Decision(ctx context.Context, name, decision, reason string, attrs ...slog.Attr) string {
	st := current.Load()
	problems := eventProblems(name, "decision", attrs)
	if spec, ok := registryEvents[name]; ok && !slices.Contains(spec.decisions, decision) {
		problems = append(problems, fmt.Sprintf("%s: unknown decision %s", name, decision))
	}
	if problem := reasonProblem(reason, ""); problem != "" {
		problems = append(problems, name+": "+problem)
	}
	violate(st, problems)
	id := newID()
	own := []slog.Attr{slog.String(FieldDecision, decision), slog.String(FieldDecisionID, id)}
	if reason != "" {
		own = append(own, slog.String(FieldReasonCode, reason))
	}
	send(ctx, st, "decision", name, attrs, own, false)
	return id
}

// Surface records that a user-visible surface was shown, and returns the call that records its dismissal once.
func Surface(ctx context.Context, name string, attrs ...slog.Attr) (dismiss func()) {
	st := current.Load()
	violate(st, eventProblems(name, "surface", attrs))
	shown := time.Now()
	send(ctx, st, "surface", name, attrs, []slog.Attr{slog.String(FieldSurfaceState, "shown")}, false)
	var done atomic.Bool
	return func() {
		if done.Swap(true) {
			return
		}
		send(ctx, current.Load(), "surface", name, attrs, []slog.Attr{slog.String(FieldSurfaceState, "dismissed"), slog.Int64(FieldShownMs, time.Since(shown).Milliseconds())}, false)
	}
}

// Fact records a measurement or an observation.
func Fact(ctx context.Context, name string, attrs ...slog.Attr) {
	st := current.Load()
	violate(st, eventProblems(name, "fact", attrs))
	send(ctx, st, "fact", name, attrs, nil, false)
}

func violate(st *state, problems []string) {
	if len(problems) == 0 {
		return
	}
	if st.closed {
		panic(&Violation{Problems: problems})
	}
	violations.Add(int64(len(problems)))
}

func send(ctx context.Context, st *state, kind, name string, attrs, own []slog.Attr, failed bool) {
	config := st.config
	record := make([]slog.Attr, 0, len(attrs)+len(own)+16)
	if config.Trail != nil {
		record = append(record, config.Trail(ctx)...)
	}
	record = append(record, attrs...)
	record = append(record,
		slog.String(FieldEventID, newID()),
		slog.Int64(FieldSeq, seq.Add(1)),
		slog.String(FieldSourceID, st.sourceID),
		slog.String(FieldSchemaVer, SchemaVer),
		slog.String(FieldModule, config.Module),
		slog.String(FieldEnv, config.Env),
		slog.String(FieldClockState, "server"),
		slog.Int64(FieldEstServerMs, time.Now().UnixMilli()),
	)
	for _, optional := range [][2]string{{FieldPlatform, config.Platform}, {FieldReleaseSHA, config.ReleaseSHA}, {FieldFlagsHash, st.flagsHash}} {
		if optional[1] != "" {
			record = append(record, slog.String(optional[0], optional[1]))
		}
	}
	record = append(record, own...)
	record = append(record, slog.String(FieldKind, kind), slog.String(FieldName, name))
	if !slices.Contains(registryModules, config.Module) || !slices.Contains(registryEnvironments, config.Env) {
		violate(st, []string{fmt.Sprintf("obs.Configure needs a registry module and env, not %q and %q", config.Module, config.Env)})
	}
	logger := config.Logger
	if logger == nil {
		logger = slog.Default()
	}
	level := slog.LevelInfo
	if failed {
		level = slog.LevelError
	}
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				if st.closed {
					panic(recovered)
				}
				exportFailures.Add(1)
			}
		}()
		logger.LogAttrs(ctx, level, name, record...)
	}()
}
