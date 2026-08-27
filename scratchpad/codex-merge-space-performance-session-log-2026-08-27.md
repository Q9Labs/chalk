# Merge Space performance work

## 2026-08-27

- Closed PR #79 because current `master` already contains its invite work.
- Merged current `master` into `perf/profile-meeting`. The only conflict was `.fallowrc.json`; the resolution keeps current entries and adds the live profiler entry points.
- Reduced the new profiler suite from 37 tests to 15 boundary tests. Removed summary-shape, formatting, and repeated edge checks.
- Killed five manual mutants covering diagnostic URL privacy, measurement mode selection, GPU validation, partial CPU-profile cleanup, and trace cleanup. Restored the implementation and confirmed all 15 retained tests pass.
