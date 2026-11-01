package sandbox

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestSandboxCapabilitiesAndFreshHeaps(t *testing.T) {
	call := func(context.Context, string, json.RawMessage) json.RawMessage {
		return json.RawMessage(`{"ok":true,"result":{"name":"safe"}}`)
	}
	result := Execute(t.Context(), `
const names = [typeof fetch, typeof WebSocket, typeof XMLHttpRequest, typeof process, typeof require,
  typeof Date, typeof performance, typeof setTimeout, typeof SharedArrayBuffer, typeof Atomics, typeof Math.random,
  typeof __chalk_call, typeof __chalk_emit];
names.push(console.log.constructor("return typeof process")());
Object.prototype.host = "polluted";
globalThis.infection = true;
const value = await chalk.inspect({__proto__: {admin: true}});
console.log("bounded", value.result.name);
return names;`, []string{"inspect"}, call)
	if result.Error != nil || result.APICalls != 1 || len(result.Console) != 1 {
		t.Fatalf("sandbox run: %+v", result)
	}
	var capabilities []string
	if err := json.Unmarshal(result.Value, &capabilities); err != nil {
		t.Fatal(err)
	}
	for _, capability := range capabilities {
		if capability != "undefined" {
			t.Fatalf("unexpected capability: %s", result.Value)
		}
	}
	fresh := Execute(t.Context(), `return [typeof infection, typeof ({}).host, typeof chalk.inspect.host];`, []string{"inspect"}, call)
	if fresh.Error != nil || string(fresh.Value) != `["undefined","undefined","undefined"]` {
		t.Fatalf("heap leaked: %+v", fresh)
	}
}

func TestSandboxRejectsEscapesAndResourceAbuse(t *testing.T) {
	for _, test := range []struct{ name, code string }{
		{"network", `return await fetch("https://example.com")`},
		{"filesystem", `return await import("std")`},
		{"host_module", `return await import("os")`},
		{"infinite_loop", `for (;;) {}`},
		{"infinite_microtasks", `for (;;) { await Promise.resolve() }`},
		{"memory_bomb", `const allocations = []; for (;;) allocations.push(new Uint8Array(1024*1024));`},
		{"huge_return", `return "x".repeat(1024*1024)`},
		{"huge_console", `console.log("x".repeat(1024*1024))`},
		{"many_console_entries", `for (let i=0;i<200;i++) console.log(i)`},
		{"pending_promise", `return await new Promise(() => {})`},
		{"api_calls", `for (let i=0;i<33;i++) await chalk.inspect({})`},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			result := Execute(ctx, test.code, []string{"inspect"}, func(context.Context, string, json.RawMessage) json.RawMessage {
				return json.RawMessage(`{"ok":true,"result":{}}`)
			})
			if result.Error == nil {
				t.Fatalf("attack succeeded: %+v", result)
			}
			if len(result.Value) > MaxOutputBytes || len(result.Console) > MaxConsoleEntries || result.APICalls > MaxCalls {
				t.Fatal("resource budget exceeded")
			}
			if ctx.Err() != nil {
				t.Fatal("sandbox did not enforce its own deadline")
			}
		})
	}
	result := Execute(t.Context(), `return 7`, nil, nil)
	if result.Error != nil || string(result.Value) != "7" {
		t.Fatalf("abuse poisoned the next instance: %+v", result)
	}
}

func TestSandboxCanceledCallsAndSourceBounds(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	called := false
	result := Execute(ctx, `return await chalk.inspect({})`, []string{"inspect"}, func(context.Context, string, json.RawMessage) json.RawMessage { called = true; return nil })
	if result.Error == nil || called {
		t.Fatalf("canceled request invoked application: %+v", result)
	}
	for _, code := range []string{strings.Repeat(" ", MaxCodeBytes+1), `return {syntax error`} {
		if result := Execute(t.Context(), code, nil, nil); result.Error == nil {
			t.Fatal("invalid source accepted")
		}
	}
}
