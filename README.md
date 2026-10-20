# @pipeworx/turbulence-modeling-resource

Catalog of NASA Langley's standard turbulence-model verification and
validation test cases (flat plates, airfoils, jets, a backward-facing step,
the wall-mounted hump, shock/boundary-layer interactions, and more), plus
reference data for the cases that publish an unambiguous experimental or
correlation dataset.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1851+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `tmr_cases(...)` — the full case catalog (or one category): id, category,
  flow regime, documented Mach/Reynolds conditions, and whether reference
  data is available via `tmr_reference_data`.
- `tmr_reference_data(...)` — the reference (experimental or correlation)
  data for one case, where the case's own page unambiguously labels a file as
  the reference data rather than one of many turbulence-model CFD results.

## Auth

Keyless. US government work — public domain.

## Data sources

- NASA Langley Research Center, Turbulence Modeling Resource — the standard
  set of verification cases (checking that a turbulence model is implemented
  correctly) and validation cases (checking that it reproduces real flow
  physics) used across the turbulence-modeling community: flat plates,
  bumps-in-channel, 2D and 3D airfoils, axisymmetric jets, a backward-facing
  step, a wall-mounted hump, shock/boundary-layer interactions, a supersonic
  square duct, the ONERA M6 wing, and a high-Reynolds-number channel flow.

The resource moved from its original NASA-hosted address to a GitHub Pages
site the publisher itself maintains; this pack reads from the current
address. Mach number and Reynolds number in the case catalog are filled in
only where a case's own page states them explicitly — a `null` means NASA's
page did not give that figure, not that the flow has no such condition.

Case directories hold dozens of files each — one per turbulence model's CFD
result, plus (for some cases) the actual experimental or correlation
reference data the models are checked against, named and linked distinctly
on the case's own page. `tmr_reference_data` only serves the latter kind,
and only for cases where that distinction is unambiguous from the page
itself; everything else stays unmapped rather than guessed at, which is why
only a handful of cases report `reference_data: true` today. Every file
follows the same plain-text, Tecplot-style convention: `#`-prefixed comment
lines, a `variables="col1","col2",...` header, optional `zone, t="label"`
sections, then whitespace-separated numeric rows — parsed generically in
`src/index.ts` rather than per-case.

`tmr_reference_data`'s `data_as_of` is the upstream file's own `Last-Modified`
response header — never a date written into the pack at build time, which
would silently go stale. `fetched_at` is always this call's own timestamp, so
a caller still knows when Pipeworx last asked even on the rare response
without a `Last-Modified` header. `tmr_cases`' `catalog_transcribed` is a
different thing entirely: the case list and conditions are a plain array
transcribed from the publisher's pages at pack-build time, not re-fetched
live on every call, so it is named and dated separately rather than
borrowing `data_as_of`'s meaning.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "turbulence-modeling-resource": {
      "url": "https://gateway.pipeworx.io/turbulence-modeling-resource/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/turbulence-modeling-resource/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1851+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/tmr_cases \
  -H 'Content-Type: application/json' \
  -d '{"category":"validation-basic"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/tmr_cases`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "turbulence-modeling-resource": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-turbulence-modeling-resource"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-turbulence-modeling-resource
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Turbulence Modeling Resource data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
