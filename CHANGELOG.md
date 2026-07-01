# Changelog

All notable public changes to this project will be documented in this file.

This changelog starts from the public-source cleanup. Earlier internal release
notes were archived privately before publication because they included
deployment, customer, and incident-specific detail that is not appropriate for a
public repository.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Local Redis and combined Postgres/Redis service helpers for Go API
  development.
- MIT license metadata across the workspace.
- Generic Go API logging/observability hooks and local performance harness for
  request, database, lifecycle, and footprint profiling.
- Public-safe scratchpad structure for architecture decisions, debugging
  lessons, deployment lessons, and summarized session memory.
- Public repository hygiene guidance for keeping raw logs, generated debug
  bundles, production identifiers, and private operational runbooks out of
  tracked source.

### Changed

- Replaced private historical scratchpad entries with curated public summaries.
- Replaced internal agent/runbook guidance with public contributor guidance.

### Removed

- Raw scratchpad session logs, local upload artifacts, private agent skills, and
  internal release archaeology from the tracked tree.
