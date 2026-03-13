# Whisper Worker Backlog

Non-authoritative parking lot only. Current behavior lives in code.

## Keep If Still True

- language hints from API -> worker if/when upstream has a reliable source
- better explicit no-speech handling than error-string matching
- batch/default tuning on real meeting samples
- retry/backoff policy for transient download failures
- minimal success/failure observability additions only when they answer a real operator question

## Rule

- if an item becomes important, implement it or move it into code/tests/issues
- do not let this file become a shadow spec
