// Package sandbox runs untrusted programs in fresh, capability-limited WASM instances.
package sandbox

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/evanw/esbuild/pkg/api"
	"github.com/tetratelabs/wazero"
	wazeroapi "github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

const (
	MaxCodeBytes      = 32 << 10
	MaxOutputBytes    = 48 << 10
	MaxCalls          = 32
	MaxConsoleEntries = 128
	MaxWallTime       = 5 * time.Second
)

//go:embed engine/quickjs.wasm
var engine []byte

// Cache compiled machine code only; never reuse a guest instance or JS heap.
var compilationCache = wazero.NewCompilationCache()

type Failure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Result struct {
	Console  []json.RawMessage `json:"console"`
	Value    json.RawMessage   `json:"value"`
	APICalls int               `json:"api_calls"`
	Error    *Failure          `json:"error,omitempty"`
}

// Execute grants only serialized operation calls and bounded output. The caller
// supplies a request-scoped, tenant-bound dispatcher; no Go objects enter JS.
func Execute(parent context.Context, code string, names []string, call func(context.Context, string, json.RawMessage) json.RawMessage) Result {
	result := Result{Console: []json.RawMessage{}, Value: json.RawMessage("null")}
	ctx, cancel := context.WithTimeout(parent, MaxWallTime)
	defer cancel()
	fail := func(code, message string) {
		if result.Error == nil {
			result.Error = &Failure{code, message}
		}
		cancel()
	}
	if len(code) > MaxCodeBytes {
		fail("code.source_limit", "Program exceeds 32 KiB")
		return result
	}
	// Transform only: no bundling, imports, plugins, filesystem reads, or source maps.
	transformed := api.Transform("async function __chalk_program() {\n"+code+"\n}", api.TransformOptions{Loader: api.LoaderTS, Target: api.ES2022, LegalComments: api.LegalCommentsNone, LogLevel: api.LogLevelSilent})
	if len(transformed.Errors) != 0 {
		fail("code.invalid_code", "Invalid TypeScript function body")
		return result
	}
	runtime := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfig().WithMemoryLimitPages(512).WithCloseOnContextDone(true).WithCompilationCache(compilationCache))
	defer runtime.Close(context.Background())
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, runtime); err != nil {
		fail("code.runtime_failed", "Sandbox initialization failed")
		return result
	}
	outputBytes := 0
	finished := false
	_, err := runtime.NewHostModuleBuilder("chalk").
		NewFunctionBuilder().WithFunc(func(ctx context.Context, module wazeroapi.Module, ptr, size, dest, capacity uint32) int32 {
		if ctx.Err() != nil {
			return -1
		}
		if result.APICalls >= MaxCalls {
			fail("code.api_call_limit", "Execution exceeds 32 API calls; completed mutations are not rolled back")
			return -1
		}
		result.APICalls++
		request, ok := module.Memory().Read(ptr, size)
		if !ok || size > 64<<10 {
			fail("code.invalid_call", "Invalid serialized call")
			return -1
		}
		var input struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if json.Unmarshal(request, &input) != nil {
			fail("code.invalid_call", "Invalid serialized call")
			return -1
		}
		response := call(ctx, input.Name, input.Arguments)
		if len(response) > int(capacity) {
			response = json.RawMessage(`{"ok":false,"error":{"code":"code.result_limit","message":"Operation response exceeds the bridge limit. The action may have completed; inspect with a read. Do not repeat mutations."}}`)
		}
		if !module.Memory().Write(dest, response) {
			fail("code.invalid_call", "Invalid response buffer")
			return -1
		}
		return int32(len(response))
	}).Export("call").
		NewFunctionBuilder().WithFunc(func(_ context.Context, module wazeroapi.Module, kind int32, ptr, size uint32) {
		if result.Error != nil {
			return
		}
		if size > MaxOutputBytes || kind == 0 && len(result.Console) >= MaxConsoleEntries {
			fail("code.output_limit", "Console and return value exceed the output budget")
			return
		}
		data, ok := module.Memory().Read(ptr, size)
		if !ok || !json.Valid(data) {
			fail("code.invalid_output", "Output must be JSON")
			return
		}
		// Match encoding/json's wire escaping before accepting output, rather
		// than discovering expansion only after a mutation program completes.
		var escaped bytes.Buffer
		json.HTMLEscape(&escaped, data)
		if outputBytes+escaped.Len() > MaxOutputBytes {
			fail("code.output_limit", "Encoded console and return value exceed the output budget; completed mutations are not rolled back")
			return
		}
		data = escaped.Bytes()
		outputBytes += len(data)
		switch kind {
		case 0:
			result.Console = append(result.Console, append(json.RawMessage(nil), data...))
		case 1:
			if finished {
				fail("code.invalid_output", "Program returned more than once")
				return
			}
			finished = true
			result.Value = append(json.RawMessage(nil), data...)
		case 2:
			fail("code.program_failed", "Program threw or rejected; completed mutations are not rolled back")
		default:
			fail("code.invalid_output", "Unknown output kind")
		}
	}).Export("emit").Instantiate(ctx)
	if err != nil {
		fail("code.runtime_failed", "Sandbox bridge initialization failed")
		return result
	}
	compiled, err := runtime.CompileModule(ctx, engine)
	if err != nil {
		fail("code.runtime_failed", "Sandbox compilation failed")
		return result
	}
	// Default WASI has no env, preopened directories, network, host randomness or
	// real clocks. Do not add WithFSConfig, WithEnv, WithSys* or WithRandSource.
	module, err := runtime.InstantiateModule(ctx, compiled, wazero.NewModuleConfig().WithName("").WithStartFunctions("_initialize"))
	if err == nil {
		var encodedNames []byte
		if names == nil {
			names = []string{}
		}
		encodedNames, err = json.Marshal(names)
		source := strings.Replace(bootstrap, "/*OPERATIONS*/", string(encodedNames), 1) + string(transformed.Code) + "\n__chalk_start(__chalk_program);"
		if err == nil {
			var allocation []uint64
			allocation, err = module.ExportedFunction("alloc").Call(ctx, uint64(len(source)+1))
			if err == nil && (len(allocation) != 1 || allocation[0] == 0 || !module.Memory().Write(uint32(allocation[0]), append([]byte(source), 0))) {
				err = errors.New("guest allocation failed")
			}
			if err == nil {
				var status []uint64
				status, err = module.ExportedFunction("run").Call(ctx, allocation[0], uint64(len(source)))
				if err == nil && (len(status) != 1 || status[0] != 0) {
					err = errors.New("guest interrupted or out of memory")
				}
			}
		}
	}
	if result.Error == nil && (err != nil || !finished) {
		code, message := "code.resource_limit", "Program interrupted, out of memory, or did not complete"
		if parent.Err() != nil {
			code, message = "code.canceled", "Request canceled"
		}
		fail(code, message)
	}
	return result
}

const bootstrap = `
"use strict";
const __chalk_start = (() => {
  const call = globalThis.__chalk_call, emit = globalThis.__chalk_emit;
  const stringify = JSON.stringify, parse = JSON.parse;
  delete globalThis.__chalk_call; delete globalThis.__chalk_emit;
  delete globalThis.Date; delete globalThis.performance; delete globalThis.Temporal; delete globalThis.SharedArrayBuffer;
  delete globalThis.Atomics; delete globalThis.WeakRef; delete globalThis.FinalizationRegistry;
  delete Math.random;
  const api = Object.create(null);
  for (const name of /*OPERATIONS*/) {
    api[name] = async (args = {}) => parse(call(stringify({name, arguments: args})));
  }
  Object.defineProperty(globalThis, "chalk", {value: Object.freeze(api)});
  const log = (...args) => emit(0, stringify(args));
  Object.defineProperty(globalThis, "console", {value: Object.freeze({log, info: log, warn: log, error: log})});
  return (program) => {
    program().then(value => emit(1, stringify(value === undefined ? null : value)), () => emit(2, "null"));
  };
})();
`
