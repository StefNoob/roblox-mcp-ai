# AGENT_LITE.md

Token-light operating guide for Roblox Studio MCP.

## Setup

1. Start the local stack with `npm run studio -- dev --place <slug>` when Blueprint V1 is available.
2. Verify health with `npm run studio -- status` or `curl http://localhost:3002/health`.
3. Prefer local `.luau` edits under `blueprint-v1/places/<slug>/src/` when Rojo is active.

## Discovery Order

Use this order unless the task explicitly requires raw source or a full tree:

1. `get_place_info`
2. `get_structure_map_summary`
3. `query_structure_map`
4. `get_script_inventory` or `get_subsystem_summary`
5. `explain_script_cached`
6. `get_project_structure` only for a targeted branch
7. `get_script_source` only for candidate scripts

Do not start with broad recursive scans if the cache-backed structure tools can answer the question.

## Reads

- `get_instance_properties` excludes `Source` by default. Set `includeSource: true` only when script text is required.
- Prefer line-range reads for large scripts.
- Prefer cached summaries over full-source reads during exploration.

## Writes

Preferred order:

1. `batch_script_edits`
2. `set_script_source_checked`
3. `set_script_source` or `set_script_source_fast`
4. Chunked upload tools for large rewrites

Do not use `set_property` for `Source`.

## Rule

Map first, source second, full-tree last.
