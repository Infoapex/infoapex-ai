# Obsidian trace projection v1

Status: implemented by GRAPH-04.

The Obsidian vault is a disposable, human-facing projection of the rebuildable SQLite
code and trace indexes. It is not an agent query engine, a runtime dependency, or a
source of authority. Planner and worker behavior must remain unchanged when the vault
does not exist.

## Export

```text
obsidian-export --path . --out docs/code-map/generated
```

The exporter writes into an adjacent staging directory and swaps the completed tree
into place. A successful regeneration therefore removes notes for entities that no
longer exist. A failed generation leaves the previous vault intact.

The default projection contains current T0/T1 trace entities. Use
`--include-advisory` to include T2 data and `--include-superseded` to include entities
that are the target of a current `supersedes` edge. These flags affect visualization
only and never raise the authority of an entity.

Generated trace artifacts are:

- `trace-index.md`, with the selected trust and lifecycle filters;
- typed notes under `trace/<entity-type>/` for ADRs, rules, contracts, criteria, tasks,
  gates, and evidence;
- explicit relation labels on every wikilink (`implements`, `verified_by`, and so on);
- links to generated file or symbol notes when a trace edge reaches a code entity;
- `canvases/trace-map.canvas`, separate from `canvases/code-map.canvas`;
- `.trace-projection-manifest.json`, conforming to
  `contracts/trace-projection-manifest.v1.schema.json`.

## Freshness and enforcement

The projection manifest contains the full current trace-graph digest, repository
commit, and the exact authoritative source namespace/hash set. Validate it with:

```text
graph-drift --scope . \
  --projection-manifest docs/code-map/generated/.trace-projection-manifest.json \
  --fail-on-review
```

Any graph mutation after export produces a projection digest failure. A source hash or
commit mismatch is reported independently. The regular code export manifest remains
`.export-manifest.json`; it is not a substitute for the trace projection manifest.

## Security and privacy

Only indexed metadata and declared evidence references are projected. Raw prompts,
conversations, secrets, credentials, and SQLite files are not copied. The output path
cannot be the repository root, preventing an atomic swap from replacing source data.
