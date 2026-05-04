# AI Analysis Tools

This repo now exposes two AI-first MCP tools for architectural review and Luau quality analysis.

## `analyze_project_architecture`

Read-only architecture report built from cached structure-map data and cached script summaries.

### Inputs

- `subsystem?: string`
- `pathPrefix?: string`
- `scriptType?: string`
- `limit?: number`
- `includeDependencies?: boolean`

### Output

- scope echo
- subsystem breakdown
- script list
- hotspots
- entrypoints
- structural risks

## `analyze_code_quality`

Read-only script quality report built from live script source reads plus cached summary metadata.

### Inputs

- `instancePaths?: string[]`
- `subsystem?: string`
- `pathPrefix?: string`
- `limit?: number`
- `includeSourceHints?: boolean`

### Output

- aggregate score summary
- severity-ranked findings
- per-script scores
- smell categories
- refactor hints

### Current heuristics

- missing `--!strict`
- legacy `wait()`
- legacy `spawn()`
- deprecated `GetCollisionGroups()`
- infinite loop patterns
- high dependency count
- broad Roblox service usage
- large script size
- high function density
