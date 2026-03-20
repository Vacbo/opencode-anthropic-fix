# OpenCode Plugin & TUI Testing Skill

> **Quick Start**: Build Docker images → Run headless tests → Verify TUI snapshots

```bash
# 1. Build images
docker build -f docker/Dockerfile.dev -t opencode-test-dev .
docker build -f docker/Dockerfile.plugin -t opencode-test-plugin .

# 2. Run headless tests
TEST_MODE=mock docker compose run headless-tests

# 3. Run TUI tests
docker compose run tui-test-suite
```

---

## Overview

This skill enables AI agents to test OpenCode plugins and core changes through two complementary paths:

1. **Headless Programmatic Testing** — Run OpenCode with `-p` flag in Docker, parse NDJSON output, verify plugin behavior programmatically
2. **TUI Visual Testing** — Interact with OpenCode's terminal UI using microsoft/tui-test to validate visual changes

**Key Features:**

- Docker-based isolation (no host contamination)
- Mock LLM mode (default, deterministic, no API costs)
- Real LLM mode (opt-in, requires mounted credentials)
- Both headless AND TUI testing paths
- Golden file snapshot comparison
- CI/CD ready (GitHub Actions example included)

---

## Prerequisites

- **Docker** 20.10+ with Docker Compose
- **Bun** 1.3+ (for local test development)
- **OpenCode CLI** (installed in Docker images)

---

## Setup

### 1. Build Docker Images

```bash
# Development image (full source build)
docker build -f docker/Dockerfile.dev -t opencode-test-dev .

# Plugin testing image (pre-built binary + Bun)
docker build -f docker/Dockerfile.plugin -t opencode-test-plugin .
```

**Image Sizes:**

- `opencode-test-dev`: ~1GB (includes Go toolchain)
- `opencode-test-plugin`: <600MB (Bun + pre-built binary)

### 2. Configure Test Mode

**Mock LLM Mode (DEFAULT)** — No API keys required:

```bash
export TEST_MODE=mock
```

**Real LLM Mode** — Requires mounted credentials:

```bash
export TEST_MODE=real
# Mount your config: ~/.config/opencode/ → /home/opencode/.config/opencode/
```

### 3. Verify Setup

```bash
# Check OpenCode works
docker run --rm opencode-test-plugin opencode --version

# Check Bun works
docker run --rm opencode-test-plugin bun --version
```

---

## Headless Testing Path

Headless testing runs OpenCode programmatically and parses the NDJSON output stream to verify plugin behavior.

### Basic Recipe

1. **Create Plugin** in `.opencode/plugins/my-plugin.ts`:

```typescript
import { tool } from "@opencode-ai/plugin";

export default async function plugin() {
  return {
    tools: {
      greet: tool({
        description: "Greet someone",
        args: { name: tool.schema.string() },
        execute: ({ name }) => `Hello ${name}!`,
      }),
    },
  };
}
```

2. **Run Headless Test**:

```bash
TEST_MODE=mock docker compose run headless-tests
```

3. **Parse Output** using `helpers/parse-ndjson.ts`:

```typescript
import { parseNDJSON, extractToolCalls } from "./helpers/parse-ndjson";

const events = parseNDJSON(stdout);
const toolCalls = extractToolCalls(events);
// Verify: toolCalls contains "greet" with correct args
```

4. **Assert Results** using `helpers/assert.ts`:

```typescript
import { assertToolCalled, assertContains } from "./helpers/assert";

assertToolCalled(events, "greet");
assertContains(events, "Hello Alice!");
```

### Running Tests

**Via Docker Compose** (recommended):

```bash
docker compose run headless-tests
```

**Full Worked Example**:

```bash
./tests/examples/headless-full-test.sh
```

This example tests:

- Custom tool registration and execution
- Hook execution (`tool.execute.before`)
- Auth provider integration

---

## TUI Testing Path (microsoft/tui-test) — PRIMARY

microsoft/tui-test is the **primary** TUI testing method. It's 2+ years old, Microsoft-maintained, and provides Jest-like snapshot testing.

### Basic Recipe

1. **Write Test** in `tests/tui-test/my-test.test.ts`:

```typescript
import { test, expect } from "@microsoft/tui-test";

test.use({
  program: "opencode",
  env: { TEST_MODE: "mock" },
  rows: 24,
  columns: 80,
});

test("startup state", async ({ terminal }) => {
  await terminal.waitForIdle();
  expect(terminal).toMatchSnapshot({ includeColors: true });
});

test("prompt submission", async ({ terminal }) => {
  await terminal.waitForIdle();
  await terminal.type("Say hello");
  await terminal.keyPress("Enter");
  await terminal.waitForText("Hello!");
  expect(terminal).toMatchSnapshot({ includeColors: true });
});
```

2. **Run Tests**:

```bash
# Via Docker (recommended)
docker compose run tui-test-suite

# Or locally
cd tests/tui-test && bunx @microsoft/tui-test
```

3. **Snapshots** are auto-created in `__snapshots__/*.snap`:

```
tests/tui-test/__snapshots__/
└── opencode.test.ts.snap
```

### Running Tests

**Via Docker Compose**:

```bash
docker compose run tui-test-suite
```

**Full Worked Example**:

```bash
./tests/examples/tui-full-test.sh
```

This example:

- Runs microsoft/tui-test suite (ALWAYS)
- Conditionally runs tui-mcp tests (if TUIMCP_AVAILABLE=true)
- Generates evidence report

---

## TUI Testing Path (tui-mcp) — OPTIONAL

**⚠️ Note**: tui-mcp is validated but high-risk (6 days old, 1 star). Use microsoft/tui-test as your **primary** TUI testing method. tui-mcp is optional for interactive debugging.

### When to Use

- Interactive debugging sessions
- Ad-hoc TUI exploration
- When you need MCP-native TUI interaction

### Basic Recipe

**Launch and Capture Startup State**:

```bash
bun tests/tui-mcp/startup-state.ts
```

**Send Prompt and Capture Response**:

```bash
bun tests/tui-mcp/prompt-response.ts
```

**Using the MCP Client Directly**:

```typescript
import { McpClient } from "./tests/tui-mcp/mcp-client";

const client = new McpClient();
await client.connect();

// Launch OpenCode
const sessionId = await client.launch("opencode", [], { TEST_MODE: "mock" });

// Wait for ready state
await client.waitForText(sessionId, "Ask anything");

// Capture snapshot
const snapshot = await client.snapshot(sessionId);
console.log(snapshot.text);

// Send input
await client.sendText(sessionId, "Say hello");
await client.sendKeys(sessionId, ["Enter"]);

// Cleanup
await client.kill(sessionId);
```

---

## Golden File Management

Golden files are reference snapshots for TUI states. They ensure visual consistency across test runs.

### What Are Golden Files

Located in `golden/`:

- `golden/startup.txt` — Initial OpenCode screen
- `golden/post-prompt.txt` — After submitting prompt
- `golden/error-state.txt` — Error display state
- `golden/composer-draft.txt` — Composer draft state
- `golden/resize.txt` — Terminal resize behavior

### Creating Golden Files

**Regenerate All**:

```bash
./scripts/regenerate-golden.sh
```

**Update Specific Snapshots**:

```bash
# Via tui-test
bun test --update-snapshots

# Via tui-mcp
bun tests/tui-mcp/startup-state.ts --golden
```

### Comparing Against Golden

**Normalize and Compare**:

```bash
# Strip ANSI codes and compare
helpers/normalize-snapshot.sh actual.txt | diff - golden/startup.txt

# Or use comparison script
helpers/golden-compare.sh actual.txt golden/startup.txt
```

**Programmatic Comparison**:

```bash
# Exit 0 = match, Exit 1 = mismatch with diff output
helpers/golden-compare.sh <(bun tests/tui-mcp/startup-state.ts) golden/startup.txt
```

### Determinism Check

Golden files must be byte-for-byte identical across runs:

```bash
# Run twice and compare
bun tests/tui-mcp/startup-state.ts > /tmp/run1.txt
bun tests/tui-mcp/startup-state.ts > /tmp/run2.txt
diff /tmp/run1.txt /tmp/run2.txt  # Should be empty
```

---

## Troubleshooting

### Issue: Tests fail with "No API key"

**Solution**: Use `TEST_MODE=mock` (default). Real mode requires credentials.

### Issue: Golden files differ unexpectedly

**Solution**:

- If OpenCode TUI changed intentionally: Run `./scripts/regenerate-golden.sh`
- If unexpected: Investigate the diff — may be a regression

### Issue: tui-mcp not working

**Solution**: Use microsoft/tui-test instead (primary method). See `docs/fallback-alternatives.md` for migration guide.

### Issue: Docker build fails

**Solution**:

- Check Docker version: `docker --version` (need 20.10+)
- Clear cache: `docker builder prune`
- Check available disk space

### Issue: Tests timeout

**Solution**:

- Increase timeout in `tests/tui-test/tui-test.config.ts`
- Check if mock LLM server is running
- Verify Docker container has sufficient resources

### Issue: Snapshots differ on different machines

**Solution**:

- Use Docker for consistent environment
- Check for locale/terminal differences
- Ensure `TEST_MODE=mock` for determinism

---

## CI Integration

See `tests/examples/ci-github-actions.yml` for complete GitHub Actions workflow.

### Quick Setup

```yaml
name: OpenCode Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build Docker images
        run: docker compose build

      - name: Cache Docker layers
        uses: actions/cache@v3
        with:
          path: /tmp/.buildx-cache
          key: ${{ runner.os }}-docker-${{ hashFiles('docker/**') }}

  headless-tests:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run headless tests
        run: TEST_MODE=mock docker compose run headless-tests

  tui-tests:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run TUI tests
        run: docker compose run tui-test-suite

  upload-evidence:
    needs: [headless-tests, tui-tests]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: test-evidence
          path: .sisyphus/evidence/
          retention-days: 30
```

### Matrix Testing

Test multiple platforms:

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest]
```

---

## Fallback Alternatives

If tui-mcp breaks or is abandoned, here are alternatives:

### 1. microsoft/tui-test (RECOMMENDED)

Already integrated. Just use it as your primary TUI testing method.

### 2. tmux send-keys + capture-pane

Most reliable, works everywhere:

```bash
# Start session
tmux new-session -d -s opencode-test "opencode"

# Send input
tmux send-keys -t opencode-test "Say hello" Enter

# Capture screen
tmux capture-pane -t opencode-test -p > screen.txt

# Cleanup
tmux kill-session -t opencode-test
```

### 3. GeorgePearse/mcp-tui-test

Python-based MCP alternative:

```bash
pip install mcp-tui-test
mcp-tui-test launch --program opencode
```

See `docs/fallback-alternatives.md` for detailed migration guides.

---

## File Reference

### Docker

- `docker/Dockerfile.dev` — Full source build image
- `docker/Dockerfile.plugin` — Pre-built binary image
- `docker/docker-compose.yml` — Service orchestration

### Helpers

- `helpers/parse-ndjson.ts` — Parse headless NDJSON output
- `helpers/normalize-snapshot.sh` — Strip ANSI escape codes
- `helpers/golden-compare.sh` — Compare snapshots
- `helpers/assert.ts` — Test assertion library
- `helpers/mock-llm-server.ts` — Mock LLM provider
- `helpers/mount-config.sh` — Filter and mount user config

### Headless Tests

- `tests/headless/run-tests.sh` — Test harness
- `tests/headless/inject-plugin.sh` — Plugin injection
- `tests/headless/assert.ts` — Headless assertions
- `tests/headless/recipes/tool-registration.test.ts` — Tool test recipe
- `tests/headless/recipes/hook-execution.test.ts` — Hook test recipe
- `tests/headless/recipes/auth-provider.test.ts` — Auth test recipe

### TUI Tests

- `tests/tui-mcp/mcp-client.ts` — MCP client wrapper
- `tests/tui-mcp/startup-state.ts` — Startup snapshot recipe
- `tests/tui-mcp/prompt-response.ts` — Prompt test recipe
- `tests/tui-test/opencode.test.ts` — microsoft/tui-test suite

### Examples

- `tests/examples/headless-full-test.sh` — Complete headless example
- `tests/examples/tui-full-test.sh` — Complete TUI example
- `tests/examples/ci-github-actions.yml` — CI workflow

### Documentation

- `docs/headless-format.md` — NDJSON protocol documentation
- `docs/test-modes.md` — Mock vs Real mode details
- `docs/fallback-alternatives.md` — tui-mcp alternatives

### Golden Files

- `golden/startup.txt` — Startup state reference
- `golden/post-prompt.txt` — Post-prompt state reference
- `golden/error-state.txt` — Error state reference
- `golden/composer-draft.txt` — Composer draft reference
- `golden/resize.txt` — Resize behavior reference

### Scripts

- `scripts/regenerate-golden.sh` — Regenerate all golden files

---

## Decision Tree

**Q: Which testing path should I use?**

| Scenario                              | Recommended Path                  |
| ------------------------------------- | --------------------------------- |
| Testing plugin logic programmatically | **Headless**                      |
| Testing TUI appearance/behavior       | **microsoft/tui-test**            |
| Interactive debugging                 | **tui-mcp** (optional)            |
| CI/CD automation                      | **Headless + microsoft/tui-test** |
| Quick smoke test                      | **Headless**                      |
| Visual regression testing             | **microsoft/tui-test**            |

**Q: Mock or Real LLM mode?**

| Scenario                      | Mode                              |
| ----------------------------- | --------------------------------- |
| Development / CI              | **Mock** (default, deterministic) |
| Integration testing           | **Real** (requires API keys)      |
| Debugging plugin issues       | **Mock** (reproducible)           |
| Testing real LLM interactions | **Real** (actual API calls)       |

---

## Summary

This skill provides:

✅ **Headless Testing** — Programmatic plugin verification via NDJSON parsing  
✅ **TUI Testing** — Visual regression with microsoft/tui-test (primary)  
✅ **Mock LLM Mode** — Deterministic, fast, no API costs (default)  
✅ **Real LLM Mode** — Actual API calls when needed (opt-in)  
✅ **Docker Isolation** — Clean, reproducible test environment  
✅ **Golden Files** — Reference snapshots for TUI states  
✅ **CI Ready** — GitHub Actions workflow included  
✅ **Future Proof** — Fallback alternatives if tui-mcp breaks

**Next Steps:**

1. Build Docker images
2. Run `tests/examples/headless-full-test.sh`
3. Run `tests/examples/tui-full-test.sh`
4. Integrate into your CI pipeline

---

_Generated for OpenCode TUI Testing Skill — 2026-03-19_
