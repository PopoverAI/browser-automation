# browser-automation: `--scenario` flag

## Summary

Add a `--scenario` flag to the `browser-automation test` command that accepts a structured JSON scenario as either an inline string or a file path. This enables Claude Code to author and execute multi-step test scenarios without file I/O, and gives testers a cleaner way to express arrange/act/assert flows against multi-page applications.

## Motivation

The existing CLI accepts a URL and one or more assertion strings as positional arguments. This works well for simple single-page checks but breaks down for transactional flows that:

- Span multiple pages
- Require login or other precondition setup
- Need discrete pass/fail attribution per assertion
- Are authored programmatically by Claude Code

## Interface

```bash
browser-automation test --scenario '<json>' [options]
browser-automation test --scenario ./scenario.json [options]
```

The `--scenario` flag replaces the positional URL and assertion arguments. All existing flags (`--useAgent`, `--cloud`, etc.) remain valid.

## Schema

```typescript
interface Scenario {
  baseUrl: string;
  steps: Step[];
}

interface Step {
  step: "arrange" | "act" | "assert";
  description: string;
  url?: string;           // relative or absolute; navigates before executing step
}
```

### Step semantics

| Type | Purpose | Example |
|---|---|---|
| `arrange` | Set up preconditions (login, navigation) | "Log in as testuser / password123" |
| `act` | Perform the action under test | "Select product SKU-001, set quantity to 3, click Place Order then Confirm" |
| `assert` | Verify an observable outcome | "A success message is shown" |

`url` is optional on all step types. When present, the agent navigates to that URL before executing the step. When absent, the agent continues on the current page. A `baseUrl` at the top level allows relative paths throughout.

### Input resolution

```
if scenario starts with '{' → parse as JSON string
else → read as file path and parse
```

## Output

The existing result schema is unchanged. One result object is emitted per `assert` step, in order. `arrange` and `act` steps do not produce result objects but failures in those steps should surface as `blocked` status on all subsequent `assert` steps.

```json
{
  "results": [
    { "status": "passed", "notes": "..." },
    { "status": "failed", "notes": "..." },
    { "status": "blocked", "notes": "arrange step failed: could not log in" }
  ]
}
```

## Example

```json
{
  "baseUrl": "https://app.example.com",
  "steps": [
    { "step": "arrange", "url": "/login", "description": "Log in as testuser / password123" },
    { "step": "act", "url": "/orders/new", "description": "Select product SKU-001, set quantity to 3, click Place Order then Confirm" },
    { "step": "assert", "description": "A success message is shown confirming the order" },
    { "step": "assert", "url": "/orders", "description": "A new order appears in the order history" },
    { "step": "assert", "description": "The order shows quantity 3 of SKU-001" },
    { "step": "assert", "description": "The order date shows Today" },
    { "step": "assert", "description": "The order total matches the expected amount" }
  ]
}
```

Inline invocation (Claude Code usage):

```bash
GEMINI_API_KEY=xxx npx @popoverai/browser-automation test --useAgent --scenario '{"baseUrl":"https://app.example.com","steps":[...]}'
```

## Out of scope

- Test data parameterization (template names, amounts) — callers are responsible for substituting real values before passing the scenario
- Cleanup / teardown steps — out of scope for now; callers should use isolated test data
- MCP tool wrapping — follow-on; the schema defined here is the contract that MCP tool inputs/outputs would mirror
