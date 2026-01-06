# Golang Learning Plan - Chalk API Codebase

## ✅ Completed: Core Go Concepts (main.go walkthrough)

### Session 1: Fundamentals
- [x] Package system (`package main` vs libraries)
- [x] Import organization (stdlib, third-party, internal)
- [x] Context concept (abort signals + deadlines + metadata)
- [x] Interfaces are reference types (not copied like structs)
- [x] Variable declaration (`:=` vs `var`, scoping rules)
- [x] Error handling philosophy (no exceptions, explicit errors)
- [x] Multiple return values pattern `(result, error)`
- [x] The `err != nil` check (explicit, not truthy/falsy)
- [x] Format verbs (`%v`, `%s`, `%d`, `%T`, etc.)

### Session 2: Pointers & Memory
- [x] Pointers vs values (`*Type` vs `Type`)
- [x] The `&` operator (address-of, creates pointer)
- [x] Why return pointers (performance + mutability)
- [x] Pointer mutability (shared state across functions)
- [x] Zero values (nil for pointers/interfaces, 0 for ints, "" for strings)
- [x] Interface values contain pointers internally

### Session 3: Resource Management
- [x] The `defer` keyword (cleanup scheduling)
- [x] LIFO execution order for multiple defers
- [x] Deferred arguments evaluated immediately
- [x] `os.Exit()` bypasses defer (need manual cleanup)
- [x] Resource acquisition pattern (acquire, check, defer, use)

### Session 4: Initialization Patterns
- [x] Struct literals (`Type{field: value}`)
- [x] Inline struct initialization
- [x] Zero values for unset fields
- [x] Named vs positional initialization
- [x] Conditional initialization (optional dependencies)
- [x] Variable shadowing with `:=` in inner scopes

### Session 5: Error Handling Strategies
- [x] `log.Println` vs `log.Fatalf`
- [x] Fatal errors during startup (fail fast)
- [x] Warning errors for optional features (graceful degradation)
- [x] Error propagation (return errors, let caller decide)
- [x] Eager vs lazy validation

### Session 6: Concurrency Basics
- [x] Goroutines (`go functionCall()`)
- [x] Channels (`make(chan Type, capacity)`)
- [x] Channel send/receive operators (`<-`)
- [x] Blocking on channel receive
- [x] Signal handling (`signal.Notify`)
- [x] Graceful shutdown pattern

### Session 7: Dependency Injection
- [x] Config struct pattern (bundle dependencies)
- [x] Optional dependencies (check for nil)
- [x] Constructor patterns (with/without errors)
- [x] Library wrapper pattern (abstraction layer)
- [x] Method receivers (`(c *Client)` vs `(c Client)`)

### Session 8: Code Architecture Patterns
- [x] Fail-fast during initialization
- [x] Required vs optional dependencies
- [x] HTTP client timeout configuration
- [x] Connection pooling (automatic in http.Client)
- [x] Background task lifecycle management

---

## 🔄 In Progress: Database Layer (sqlc)

### Partially Covered
- [x] Overview of sqlc (SQL → Go code generation)
- [x] Schema structure (5 tables: tenants, rooms, participants, recordings, audit_logs)
- [x] Generated models (structs from tables)
- [x] Query patterns (`:one`, `:many`, `:exec`)
- [x] Nullable fields → pointers in Go
- [x] JSONB → `[]byte` mapping
- [x] Timestamp types (`time.Time` vs `pgtype.Timestamptz`)
- [x] UUID handling (`github.com/google/uuid`)
- [x] The Queries object (`db.New(pool)`)
- [x] DBTX interface (pool vs transaction)

### ⚠️ Blocked: Need SQL Knowledge First
- [ ] How to read SQL schema (CREATE TABLE, data types, constraints)
- [ ] How to read SQL queries (SELECT, INSERT, UPDATE, DELETE)
- [ ] SQL relationships (foreign keys, ON DELETE CASCADE)
- [ ] SQL indexes and why they matter
- [ ] Understanding JOIN operations
- [ ] Understanding WHERE clauses and filters
- [ ] Understanding RETURNING clause

---

## 📋 TODO: SQL Crash Course (PREREQUISITE)

### Essential SQL Concepts to Learn
- [ ] Basic SELECT statements
- [ ] INSERT, UPDATE, DELETE operations
- [ ] WHERE clause filtering
- [ ] Primary keys and foreign keys
- [ ] Relationships (one-to-many, many-to-many)
- [ ] JOIN operations (INNER, LEFT)
- [ ] NULL handling in SQL
- [ ] Common data types (VARCHAR, INT, UUID, TIMESTAMPTZ, JSONB)
- [ ] Basic aggregation (COUNT, SUM, etc.)
- [ ] LIMIT and OFFSET (pagination)
- [ ] ORDER BY (sorting)

### Recommended Learning Path
1. Interactive SQL tutorial (sqlzoo.net or sqlbolt.com)
2. Practice with the chalk schema
3. Read existing queries in `db/queries/*.sql`
4. Come back to understand how sqlc generates Go code

---

## 📋 TODO: HTTP Layer (Option A + C)

### Router & Middleware (Not Started)
- [ ] How Gin router works
- [ ] Route registration
- [ ] Middleware pattern
- [ ] JWT authentication middleware
- [ ] API key authentication middleware
- [ ] Request/response flow

### Handler Pattern (Not Started)
- [ ] Handler function signature
- [ ] Extracting path parameters
- [ ] Extracting query parameters
- [ ] Reading request body (JSON)
- [ ] Validating input
- [ ] Calling domain services
- [ ] Returning JSON responses
- [ ] Error handling in handlers

### Request Flow Example (Not Started)
- [ ] Pick one endpoint (e.g., POST /api/v1/rooms)
- [ ] Trace from HTTP request → handler → domain → database → response
- [ ] Understand each layer's responsibility
- [ ] See how errors bubble up
- [ ] See how context flows through

---

## 📋 TODO: Domain Layer (Not Started)

### Business Logic Patterns
- [ ] Service structs (RoomService, ParticipantService, etc.)
- [ ] Dependency injection in services
- [ ] Validation logic
- [ ] Business rule enforcement
- [ ] Integration with Cloudflare API
- [ ] Integration with Redis pub/sub

---

## 📋 TODO: Advanced Go Concepts (Not Started)

### Type System
- [ ] Struct embedding (composition)
- [ ] Interface satisfaction (implicit)
- [ ] Type assertions
- [ ] Type switches
- [ ] Empty interface (`any` / `interface{}`)

### Concurrency (Deep Dive)
- [ ] Goroutine lifecycle
- [ ] Channel patterns (buffered vs unbuffered)
- [ ] Select statement
- [ ] Mutexes and sync primitives
- [ ] Race conditions and prevention
- [ ] Context cancellation propagation

### Error Handling (Advanced)
- [ ] Error wrapping (`fmt.Errorf` with `%w`)
- [ ] Error unwrapping (`errors.Is`, `errors.As`)
- [ ] Custom error types
- [ ] Sentinel errors
- [ ] Panic and recover

### Testing
- [ ] Table-driven tests
- [ ] Mock interfaces
- [ ] Test fixtures
- [ ] Integration tests

---

## 🎯 Immediate Action Items

**Before continuing with Golang:**
1. [ ] Complete SQL basics tutorial (2-3 hours)
2. [ ] Read chalk schema and understand table relationships
3. [ ] Read 3-4 queries from `db/queries/` and understand what they do
4. [ ] Come back to finish database layer walkthrough

**After SQL knowledge:**
1. [ ] Complete database layer understanding
2. [ ] Trace a full request (POST /api/v1/rooms)
3. [ ] Understand handler → domain → database flow
4. [ ] Read middleware (authentication/authorization)
5. [ ] Feel confident to contribute!

---

## 📝 Key Takeaways So Far

### Go Philosophy
- Explicit over implicit (no hidden magic)
- Errors are values, not exceptions
- Composition over inheritance
- Simple is better than complex
- Built for concurrency from day one

### Common Patterns in Chalk Codebase
1. **Config struct pattern** - Bundle related configuration
2. **Dependency injection** - Pass dependencies explicitly
3. **Interface-based design** - `StorageClient`, `DBTX`, etc.
4. **Resource cleanup with defer** - Always paired with acquisition
5. **Context propagation** - Every I/O operation takes context
6. **sqlc for database** - Type-safe SQL, no ORM magic
7. **Clean Architecture layers** - HTTP → Domain → Infrastructure

### Things That Might Trip You Up
- Variable shadowing with `:=` in nested scopes
- `os.Exit()` bypassing deferred cleanup
- Pointers vs values (when to use which)
- Nil interface values (need to check before use)
- Goroutine panics don't crash main (unless you want them to)

---

## 🔗 Resources

### Official Go Resources
- Tour of Go: https://go.dev/tour/
- Effective Go: https://go.dev/doc/effective_go
- Go by Example: https://gobyexample.com/

### SQL Learning
- SQL Bolt: https://sqlbolt.com/
- SQL Zoo: https://sqlzoo.net/
- PostgreSQL Tutorial: https://www.postgresqltutorial.com/

### Chalk-Specific
- Main.go walkthrough: ✅ Complete
- Database schema: `apps/api/db/migrations/001_initial_schema.sql`
- Query examples: `apps/api/db/queries/*.sql`
- Generated code: `apps/api/internal/infrastructure/postgres/db/*.go`

---

## 🎨 Dev Setup Completed
- [x] Editor: Cursor with dark theme
- [ ] Install Go extension (if not already)
- [ ] Install PostgreSQL extension (for SQL syntax)
- [ ] Configure `gopls` for Go language server

---

**Last session ended at:** Database layer overview (sqlc patterns)
**Blocker identified:** Need SQL knowledge to continue
**Next session:** SQL crash course, then resume database layer
