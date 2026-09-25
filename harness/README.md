# Pi Alehouse worker harness

The harness is Pi Alehouse's internal, opt-in Owner-local worker backend, not another npm package or a separate Pi runtime. Launch through the explicit built `pi-alehouse` CLI, not direct extension discovery: root `pi.extensions: []` intentionally prevents source composition autoload or `pi install` extension loading. The CLI supplies `--no-extensions -e <absolute composition.ts>`. It uses the host Pi SDK and the matched generated permission authority and worker definitions. Ordinary `pi` is unchanged; this launcher does not copy authentication or rewrite Pi settings.

**Release acceptance remains PENDING.** The latest root portable check (847/847 package tests), controlled full/readonly, Jev and SDK-history repeats, and final installed-tarball RPC smoke passed in their declared scopes. The inherited cooperative-local operating contract documents limitations, not public acceptance. See [limitations](docs/limitations.md), [release policy](release-policy.json) and [validation scope](docs/validation-evidence.md).

## Operate

1. Build the root package and generate matching `runtime/{agents,policy,permission-system}` resources. Run `node bin/pi-alehouse.mjs init` from the repository root to create **only absent** resources (five worker definitions, one routing catalogue and one managed permission config). Existing personal files stay intact. The neutral version-2 `harness-presets.json` defaults to `off`; configure your own exact registered provider/model IDs before enabling workers. See [getting started](docs/getting-started.md) and [routing configuration](docs/routing.md#preset-configuration).
2. Start a **fresh** `pi-alehouse` process. Select the parent model normally and a worker preset independently via `/harness-preset` or `Alt+S`. `off` blocks new delegation, not already accepted Runs. When enabled, the parent has eight fixed harness management tools. Release idle Agents when capacity is needed.
3. Before exit, use `/harness-close` and wait for **confirmed** Owner closure. A never-used Owner closes automatically before session replacement; a used Owner needs literal **Yes** from Pi's UI. `/tree` always needs explicit close because it changes the current session in place. Do not `/reload` with an open Owner. Once a replacement guard returns after closure, Pi does not atomically serialize later teardown/hooks/target loading: finish each replacement before starting another. Unconfirmed drain does not prove execution exit.

Off leaves accepted queued/running work and result/cleanup tools available. A fresh initially Off conversation has no harness tool schemas or orchestration reminder; turning Off later cannot remove historical model context. See [Off](docs/routing.md#off).

The parent retains normal footer/title, approval queue, health/Stats, and pinned `pi-web-access` 0.31.0 tools. Child sessions have neither web tools nor nested delegation. Luna is not loaded; its shared checkpoint helper is imported by Jev without registering a second authorizer. See [security](docs/security.md). Leaving this launcher and starting ordinary `pi` does not retroactively stop its children; close the Owner first.

## Limits at a glance

- Four execution slots; eight resident Agent reservations, including queued/busy/uncertain-cleanup reservations. `release_agent` is permanent.
- Default Run execution deadline 30 minutes (1 ms–24 h configurable), excluding queue time. Expiry/cancellation requests a stop; it is not forced exit, rollback, or guaranteed zero later provider activity.
- `wait_ms`/`wait_runs.timeout_ms` bounds only the parent's wait (five minutes max); Esc interrupts waiting, not worker work.
- Owner-local result retention is bounded to 512 cumulative Runs and 64 Mi UTF-16 result units (including reservations for unsettled Runs); this is not a total heap/RSS cap or a durable store.
- Child usage is observed conservatively and handed to the next parent tool result if available. Spend settling after the last result remains unmerged residue, not fabricated into Pi totals.

## Contract references

| Concern | Reference |
| --- | --- |
| Ownership, lifecycle, SDK adapters, history and accounting | [Architecture](docs/architecture.md) |
| Owner / Agent / Run / Session vocabulary | [Concepts](docs/concepts.md) |
| Eight parent tools and two child tools | [Tool contract](docs/tool-contract.md) |
| Slots, effort, Off, version-2 configuration | [Routing](docs/routing.md) |
| Widget, panels, footer and Stats | [Interface](docs/interface.md) |
| Permission, provenance, leases and data handling | [Security](docs/security.md) |
| Layout and quality gates | [Development](docs/development.md) |
| Supported/unsupported behavior | [Limitations](docs/limitations.md) |
| Test scope and evidence gaps | [Validation evidence](docs/validation-evidence.md) |
| Package ownership rationale | [Organization decision](docs/decisions/001-organization-boundaries.md) |

Legacy tool names, profile IDs, config path, `harness:*` records, event names and cross-extension symbols remain compatibility surface, not a second public product. See [notices](THIRD_PARTY_NOTICES.md) and [root notices](../THIRD_PARTY_NOTICES.md).
