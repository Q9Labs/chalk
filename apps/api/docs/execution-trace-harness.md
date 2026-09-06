# Execution trace harness

Use this to explain or test an API flow without live dependencies. It runs real application code with traced doubles at external boundaries; it isn't production observability or a real-provider test.

From `apps/api`:

```sh
go run ./cmd/trace -list
go run ./cmd/trace -scenario <name>
go run ./cmd/trace -scenario all -format json
go run ./cmd/trace -style tree -color always
```

No scenario argument runs the full catalog. `-list` is the current inventory; text is for reading and JSON is for tools.

## Add a scenario

- Add it in `internal/traceharness`, following a neighboring scenario. Register it in `Run` and `ScenarioNames`.
- Use `route:*`, `service:*`, `policy:*`, `ratelimit:*`, `adapter:*`, or `edge:*` to identify what it tests.
- Exercise real behavior and double only external dependencies. Keep one review question per scenario.
- `Recorder.Add` records a step; `Recorder.Start` / `Span.End` records an operation's duration and result.
- Show relevant input, policy decision, service/repository calls, and result. Redact credentials, customer data, production IDs, and private configuration.
- Test the result and important events with `go test ./internal/traceharness ./cmd/trace`, then run the API gate for Go changes.

Don't commit raw trace output. Add scenarios when useful or requested, not as a routine handoff requirement.
