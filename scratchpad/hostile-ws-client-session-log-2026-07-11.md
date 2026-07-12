# Hostile WebSocket Client Session Log

- 2026-07-11 16:11 PKT — Began the test-only Mint WebSocket client extension. Confirmed the existing client preserves JSON and close compatibility but drops raw frames and client state after a receive timeout. The focused integration tests will exercise an ephemeral Bandit listener without timing sleeps.
- 2026-07-11 16:16 PKT — The first real-listener test run showed that Bandit closes TCP after a client close frame without emitting a peer close frame. The graceful-close test now verifies the observed TCP termination rather than a reflected close payload.
- 2026-07-11 16:15 PKT — Formatting and the focused client plus transport test suite passed with 14 tests. A later fixed-seed rerun was blocked before test execution by an unrelated shared `test/support/sync_breaker/checker.ex` one-line heredoc syntax error; its source remains untouched.
