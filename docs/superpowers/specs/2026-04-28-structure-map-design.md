# Structure Map Design

## Problem

The current Roblox MCP workflow re-discovers too much of the game on every analysis pass.
Hierarchy tools such as `get_file_tree`, `search_files`, `search_objects`, and `get_project_structure` are driven by live recursive scans in the Studio plugin. This creates three problems:

- repeated Luau tree walks over the same `DataModel`
- repeated script reads to rebuild context the agent already had conceptually
- high token and credit cost because the agent must re-summarize structure and script roles from scratch

The user goal is to make project understanding cheaper, faster, and more stable across repeated AI sessions.

## Goals

- Build a reusable project map that describes the game structure without rescanning everything on each request.
- Keep that map updated when the Roblox `DataModel` changes, including script creation, deletion, moves, renames, and source edits.
- Persist the map to disk so it survives MCP server restarts and can be reused by CLI flows and agents.
- Add persistent script summaries keyed by `sourceHash` so script meaning does not need to be recomputed every time.
- Make discovery-oriented agents query the map first and read full script source only for targeted files.

## Non-Goals

- Do not replace existing source read or write tools.
- Do not attempt full semantic analysis of all Luau code inside the plugin.
- Do not guarantee real-time perfect consistency at sub-frame precision; brief debounce windows are acceptable.

## Proposed Architecture

The system has three layers.

### 1. Live structure index in the Studio plugin

The plugin maintains an in-memory `StructureMapState` representing the current `DataModel`.

Each node stores compact metadata:

- `path`
- `name`
- `className`
- `parentPath`
- `childPaths` or `childCount`
- `hasSource`
- `scriptType`
- `enabled` when relevant
- essential tags / attributes summary
- `sourceHash` for script-like instances
- `summaryStatus` for script summaries: `missing`, `fresh`, or `stale`

The plugin is the source of truth for live structure.

### 2. Persistent cache in the Node server

The Node side stores a persisted snapshot per place, for example:

- cache path recommendation:
  - `C:\roblox-mcp-ai\.studio-cli\cache\structure-map\<placeId>.json`
  - script summaries may live beside it, or inside the same file

The persisted snapshot contains:

- `placeId`
- `placeName`
- `updatedAt`
- `version`
- `roots`
- `nodesByPath`
- `scriptInventory`
- `summaryIndex`

This cache is used by MCP tools, CLI commands, and future agent workflows before falling back to live traversal.

### 3. Agent-first map workflow

Discovery agents and subagents must prefer the structure map over wide live scans.

Default flow:

1. read structure summary
2. query the map for relevant subsystems or script containers
3. expand only selected paths
4. read script sources only for candidate files
5. update script summaries only when `sourceHash` changed

## Data Model

### Structure map node

```json
{
  "path": "game.ServerScriptService.AI.EnemyBrain",
  "name": "EnemyBrain",
  "className": "ModuleScript",
  "parentPath": "game.ServerScriptService.AI",
  "childCount": 0,
  "hasSource": true,
  "scriptType": "ModuleScript",
  "sourceHash": "sha256:...",
  "summaryStatus": "fresh",
  "subsystem": "AI"
}
```

### Script summary record

Each script summary is stored separately from the structural node but linked by `path` and `sourceHash`.

Fields:

- `path`
- `sourceHash`
- `summaryShort`
- `summaryLong` optional
- `purpose`
- `exports`
- `dependencies`
- `servicesUsed`
- `sideEffects`
- `subsystem`
- `updatedAt`

If the current node `sourceHash` differs from the summary record hash, that summary becomes `stale`.

## Update Lifecycle

### Structural updates

The plugin updates the in-memory structure map whenever the `DataModel` changes in a structurally relevant way, including:

- new instance created
- instance destroyed
- instance renamed
- instance reparented / moved
- script created
- script deleted
- script source changed

### Source updates

For script-like instances:

- recompute `sourceHash` when source changes
- mark the related summary as `stale`
- do not recompute semantic summary inside the plugin

### Persistence

Persistence happens in two steps:

1. immediate write to plugin memory
2. debounced flush from Node to disk every `1-3s` during change bursts, plus explicit full refresh on demand

This keeps live reads fast while avoiding excessive disk writes.

## MCP Surface

Add or evolve tools so map-first workflows are possible.

### New tools

- `get_structure_map_summary`
  - returns place metadata, top-level services, counts, version, and summary freshness stats
- `query_structure_map`
  - query by path prefix, class, subsystem, `hasSource`, script type, tags, or fuzzy name
- `refresh_structure_map`
  - force rebuild from live plugin state and flush persisted cache
- `get_script_inventory`
  - returns all script-like nodes with compact summaries

### Existing tools to adapt

- `get_project_structure`
  - should use cached structure data by default and only expand requested branches
- `search_files`
  - should query script inventory first and fall back to live content scans only when explicitly needed
- `search_objects`
  - should query the structure index instead of rescanning `game` every time for name/class searches

## Script Summary Strategy

Summaries are not regenerated on every agent run.

Rules:

- generate `summaryShort` for all scripts
- generate `summaryLong` only on demand or for marked important subsystems
- regenerate summaries only when `sourceHash` changes
- keep the summary process outside the plugin, using Node or a dedicated analysis flow

Recommended summary generation flow:

1. structure map marks script as `stale`
2. Node server or CLI schedules summary refresh
3. targeted script read is performed
4. summary record is updated and persisted

## Integration With Agents and Subagents

Discovery-oriented subagents should be briefed to use the map first.

Required behavior:

1. call `get_structure_map_summary`
2. call `query_structure_map` for the target subsystem
3. inspect only returned candidate nodes
4. call `get_script_source` only when deeper code inspection is necessary

This is the main credit-saving mechanism. The map becomes the default project memory layer.

## Invalidation Rules

Invalidate or refresh affected cache portions when:

- place changes
- plugin reconnects to a different place
- structure version advances
- a write tool mutates instances or scripts
- reverse sync changes tracked files and source hashes diverge

Prefer branch-level invalidation where possible instead of rebuilding the whole map on every change.

## Rollout Plan

### Phase 1

- add in-memory structure map in plugin
- add persisted cache file in Node
- add summary and query tools
- route `get_project_structure` through the cache

### Phase 2

- add script inventory and summary index
- mark summaries stale on source change
- add CLI support for forcing refresh and inspecting cache health

### Phase 3

- add selective branch invalidation
- optionally add change journal / delta queries
- optionally add dependency extraction for `require(...)`

## Risks

- path-based identity is easy to implement but renames and moves can look like delete + create unless the plugin keeps a stronger identity internally
- summary generation can still be expensive if too many scripts are refreshed at once
- cache invalidation bugs could cause stale context if versioning is weak

## Testing

- plugin unit coverage for node add/remove/rename/reparent/source-change transitions
- server tests for cache persistence and invalidation
- MCP tests for query behavior and cache-backed `get_project_structure`
- regression test ensuring repeated discovery avoids full live rescans when nothing changed

## Recommendation

Implement the hybrid design:

- live incremental map in the Studio plugin
- debounced persistent cache in the Node server
- map-first discovery workflow for agents
- hash-keyed persistent script summaries

This gives the best balance between performance, cost reduction, and project understanding quality.
