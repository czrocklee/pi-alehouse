# Security and authority boundaries

Pi Alehouse runs cooperative Agents under the host Pi process and user account.
The patched permission authority, static guard and profile tool tables enforce
specific boundaries on model tool calls. They are **not an OS sandbox**, a
network firewall or protection from opaque programs or trusted in-process code.
Do not delegate work that requires those guarantees.

## Explicit process and tool boundary

- **Trust the installation and host.** `pi-alehouse` starts host Pi with
  `--no-extensions -e` and the package's absolute composition path. It rejects
  additional extension paths, checks for matched generated resources and uses
  trusted absolute util-linux `flock`. Plain `pi` does not load Alehouse; the
  package is not a `pi install` extension. See [installation](getting-started.md#2-install-the-launcher).
- **Own the configuration.** `pi-alehouse init` creates only missing resources,
  with routing Off. It does not repair an existing definition or merge a new
  permission seed into your policy. Inspect your actual settings and rules
  before enabling work.
- **Choose the smallest suitable tool table.** A profile is not a model tier,
  grant or separate account. Both profiles work in the parent's admitted
  directory, under the same project-trust settings. There is no private child
  checkout, and review-only instructions do not make a worker read-only.

| Profile                         | Enforced model-facing tools                                             | What that does not enforce                                                        |
| ------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `worker` (internal `editor`)    | Local read/search, edit/write and Bash, subject to policy; no web tools | No network isolation; ordinary Bash includes Git and builds.                      |
| `scout` (internal `researcher`) | `read`, `grep`, `find`, `ls` and web; no Bash, edit or write            | Web tools can still invoke helpers, read credentials, send data and write caches. |

Both have `alert_parent` and `ask_parent`, not the parent's management tools or
nested delegation. `notify_parent` is denied, not an alias. Use `scout` in new
requests; `researcher` remains the on-disk and internal ID, not a public alias.

### Skill discovery and permissions

Both profiles discover skill metadata by default. Turn off **Agent skills**
(`childSkills`) in [scoped preferences](routing.md#scoped-user-preferences), or
launch with `--no-skills` / `-ns` to force it off for that launch. The setting is
sampled when a child session is created, not when an Agent is queued; existing
sessions keep their loaded resources. Discovery grants neither tools nor access.

`permission.skill` filters the advertised catalogue and gates `read` calls to
matching active entries and their directories. It does **not** protect every
skill file or every access surface. Turning discovery off reduces exposure, not
permission to read known files. Use file/path policy for that. The init seed
allows skills; an existing policy without a skill rule uses its ordinary `*`
fallback. Jev does not automatically approve skill asks. Treat instructions
from skills as input, not as authority.

## Model tool policy

Alehouse uses one patched permission-system authority (32.0.3), with a separate
hard-deny guard and permission-aware search. Tool visibility is not permission.
Project, profile and session rules can affect ordinary checks; do not assume
that a global rule always wins ordinary scope composition. Live rules need not
match the seed. Changing a prompt, UI mode or model cannot override an enforced
deny or profile ceiling.

| Decision                        | What happens                                                                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing effective allow        | Runs without human or Jev review of that check; independent path, tool and safety checks still apply.                                                                   |
| Ordinary ask                    | Follows the approval mode. Session yolo satisfies ordinary asks for that session and covered in-process descendants, without Jev or its checkpoints.                    |
| Final deny or fail-closed floor | Grants and yolo cannot set aside a final deny or automatically satisfy a fail-closed ask. Report a hard refusal; do not rephrase or wrap the command to get it through. |

Check the effective rules in both the parent and child before relying on
approval as a control. The seed denies many known secret paths and writes to
Pi and Git configuration; it normally asks for external directories. Review
exceptions and add rules for your own sensitive paths. Broad Bash allows and
yolo can admit more than you intend. See [Git policy](git-read-proof.md) for
repository commands.

### Configured privilege-command denies

For recognized literal `sudo`, `doas` and `su` executions, the authority first
checks the ordered global Bash rules. A selected global deny survives
project/profile rules, session grants, yolo and authorizers. Same-global-scope
exceptions still count. This is not a blanket ban and does not change scope
precedence for other commands.

The floor uses parsed executions, including recognized wrappers and shell
substitutions, not mentions in comments, arguments or quoted data. It does not
inspect arbitrary scripts or attest executable identity. Incomplete inspection
can fail closed: an advisory query cannot claim an automatic grant when it
needs source or parser evidence it lacks, and the serving parent refuses a
forwarded request it cannot inspect as required.

### Static guard, static-allow exclusion and redirect targets

- **Hard guard:** denies invalid principals, `file:` URLs on path tools,
  unbound permission-aware grep, `cd -` and `cd` option forms, selected
  requested Git execution-environment prefixes, and detectable declarative
  Bash denies.
  An unavailable or indeterminate deny policy fails closed. The guard does not
  issue allows.
- **Static-allow exclusion:** dynamic file operands or redirects, indirect
  file lists, expanding heredocs and inline environment assignments can make
  an otherwise applicable Bash allow unusable. The authority evaluates with
  all Bash allows and session grants set aside and retains stricter full-policy
  restrictions. An ordinary ask can still be satisfied by yolo; a deny default
  can still deny. Human approval of an excluded ask is one-time, not a session
  grant. This changes who approves, not what shell effects can be seen.

The exclusion uses the original tool request, not a model-supplied description
or a truncated command. For forwarded Bash asks, the serving authority checks
its own rules and grants against the original request and honors the child's
exclusion. It refuses missing or malformed access facts; path and external
asks keep their actual surfaces. Use matched parent/child resources. Advisory
checks do not grant or record permission.

#### Redirect-buried argv and home `cd`

Literal redirects are checked by direction, even for new files. Filenames
are decoded once and checked as filesystem literals, not normalized again as
model tool inputs. Other arguments keep their own roles; recovered arguments
can add restrictions, never an allow. A dynamic `cd` leaves the base unknown,
so relative paths can require external-directory approval. Dynamic targets
and opaque programs' internal IO are not fully visible to the classifier.

## Immutable resource floor in writable installations

The launcher and composition establish a process-local deny-only snapshot for
both parent and children. It protects identifiable writes into the Alehouse
package, generated runtime, dependency and host code, and selected Pi agent
directory. It also protects writes to ancestors when removal or renaming
could remove protected descendants. Exact Pi auth files, web configuration and
the configured Jev key file have **read and write** protection through lexical
and canonical aliases. The snapshot also covers aliases of individual trust
inputs and exact Jev audit artifacts, including a supported external logs
symlink's target files. Unrelated logs are not swept into that protection;
the dedicated archive root must not be a symlink.

Project rules, human grants and yolo cannot widen this floor. It is not inode
or hardlink tracking, filesystem isolation, or interception of a script's
internal IO. Trusted host services can still update their own files. Edit
protected policy or configuration deliberately outside the model tools. To
edit Alehouse's source with model tools, use a **separately installed** CLI:
launching from the checkout protects that checkout. Start a fresh process for
a different protected runtime generation.

## Context, identity, and data handling

- **Host credentials:** children reuse the host model runtime and existing
  authentication; Alehouse does not copy credentials into child settings,
  snapshots or journals. A real SDK call or a native model catalogue refresh
  can contact providers, refresh OAuth and update host files. Opening the
  native model selector is not necessarily offline.
- **Prompt data:** opt-in context inheritance copies at most 64 KiB of the
  model-visible conversation as text, not a session fork, permission transfer
  or tool/settings copy. Oversized snapshots fail before child creation.
  Prompts, child findings and files can contain sensitive or untrusted data.
- **History:** journals, thinking, diagnostics, cached pages and results are
  not redacted evidence. Keep them private. Cold history uses only SDK-derived
  links for the parent, with bounded read-only, no-follow access under the
  trusted session root. Historical identity grants no live authority.
- **Optional footer network:** publishing quota data requires explicit
  `AGENT_DASHBOARD_URL`; there is no implicit local endpoint. Grok billing
  credential reads and requests require `PI_ALEHOUSE_GROK_BILLING=1`.
  That integration uses Pi's actual agent directory for `auth.json`, can fall
  back to Grok's own auth, and sends the token to the billing service selected
  by `GROK_CLI_CHAT_PROXY_BASE_URL` (or the built-in service). Review the
  destination before enabling it. Ordinary quota header display needs neither opt-in.

## Scoped settings and trust

Use the required `alehouse-presets.json` catalogue and
[scoped preferences](routing.md#scoped-user-preferences) for routing, not for
credentials. Optional workspace preferences load or save only for the current
trusted cwd, not an inferred Git root. Versioned configuration and saved
selections are checked against current catalogue and host model metadata, not
provider authentication or availability. A model caller can request a profile
and difficulty, not resolve arbitrary providers, cwd, identities or tool
registries. Routing choices grant no permission.

The optional [Codex speed limits](routing.md#set-model-limits) are a read-only
user-level table. A project cannot supply or merge limits. The table governs
Alehouse's request hints, not account access, explicit tiers set elsewhere or billing.

Startup and restoration do not save preferences. Explicit persistent edits use
a cooperative lock, reject a conflicting leaf for that scope and publish by
atomic rename; the writer refuses symlink or read-only replacement. Invalid
configuration is reported, not overwritten. Inspect a failed save before
retrying; see the linked settings guide for uncertain write/lock recovery.

## Parent web access

Both parent and scout use the package-local pin of `pi-web-access`
0.48.0. The launcher checks its location and version, not a digest of its code.

With an enabled preset in Co-worker, Lead or Supervisor, the parent web tools
are hidden from model requests and calls are refused, even if host exclusions
or permissions withhold `agent_spawn`. The filter uses every registered web
name, including the loader or configured names. The tools are not durably
removed; a stored prompt or history may still mention them. Manual and Off
restore the upstream selection and normal parent permission checks. If a scout
is unavailable, the user can choose Manual or Off for direct web access.

This reduces exposure of the longest-lived model context to raw pages. It does
not prevent prompt injection, remove page text from history or quotations, or
block Bash network access. The instruction not to fetch web pages through Bash
is guidance only. Treat scout findings as untrusted even when cited.

## Researcher web access

Scout (internal `researcher`) is the only child profile with web access. It has
a separate web instance and four fixed direct tools; there is no `web_enable`
loader or background-triggered child turn. Keep all four upstream tools enabled
under their default names, or scout assembly fails. The init seed asks for
`web_search`, `source_check` and `fetch_content`, and allows
`get_search_content`; check your live policy. Child asks can be forwarded;
Jev does not automatically approve `fetch_content` asks.

**Enforced in the scout:** `fetch_content` accepts only absolute HTTP(S) URLs,
not local video paths, and has no per-call browser-cookie `auth` parameter.
Fetch, search and source-check have no per-call `proxy`. Search has no
`workflow` or `model` override and always runs without a summary workflow or
curator; fetch modes retain upstream behavior. The three adapted tools validate
these restrictions at input and execution. Host-configured proxies still apply.

**Still trusted upstream:** URL and redirect checks reject private/internal
addresses by default on the guarded fetch paths. DNS preflight does not pin the
actual connection address or guarantee protection against rebinding. Proxy and
network exceptions or remote providers can change where requests go. Use
`fetchContent.domainPolicy.allow` in `web-search.json` to restrict fetch hosts
for both parent and scouts; it is not a search or general egress policy. Neither
URL nor query checks prevent disclosure of project data.

- **GitHub:** repository and issue/PR handling can use stored `gh` credentials,
  including for private content. Clones write outside the child path gates.
  Review account access; `githubClone.enabled: false` and
  `githubPrIssue.enabled: false` disable their respective special handlers,
  not ordinary URL fetches.
- **Video and cookies:** video handling can launch `yt-dlp`/`ffmpeg`.
  Gemini Web can read browser cookies when `allowBrowserCookies` or
  `PI_ALLOW_BROWSER_COOKIES=1` is enabled, even without a scout `auth` input.
  Leave browser-cookie access off unless authorized for the host.
- **Additional destinations:** fetch answer (including fetched images and video
  frames) and video modes can send content to
  another model; field extraction can send it to Cloudflare Clairic.
  Configured external fetch commands, hosted providers and PDF endpoints can
  receive URLs or content. A tool approval does not list every downstream
  action or cost; review provider, helper and credential settings.
- **Shared cache and state:** upstream stores fetched content on disk, by default
  in `web-search-cache` below the web config directory. Its one-hour lifetime and
  size limits do not imply deletion at session close. Review the location
  (`PI_WEB_ACCESS_CACHE_ROOT` can relocate it) and keep it private. DuckDuckGo
  searches also share bot-check cooldown timestamps across the parent, scouts
  and other Pi processes via `duckduckgo-cooldown.json` in the web config
  directory.

Scout source-hygiene instructions prohibit sending local contents in queries or
URLs, but the tools cannot enforce that. Keep web calls under human control or
avoid scout web access for projects with sensitive data; use actual host egress
controls for any mandatory separation.

## Permission readiness and provenance

Child assembly checks the admitted profile digest and tool table, and child
input requires its bound permission service and static-guard acknowledgement.
Missing or mismatched readiness blocks the operation; it is not a human ask.
The guard and forwarding edge use the same session-record principal as the
actual tool gate, never profile markers in prompts or files. Forwarded asks
must have a named, bound requester and real access facts; ordinary unscoped
parent calls still use normal global gates. Startup integrity checks do not
continuously reread definitions or freeze live policy.

### Jev review and audit

Jev is the only model judge. Launch defaults to `PI_JEV_APPROVAL_MODE=enforce-subagents`
(parent and eligible forwarded asks); `shadow` is manual approval with no
Jev automatic allows, not a privacy/offline mode. Existing allows and ordinary
yolo asks never reach Jev. Hard checkpoints defer eligible requests to human
approval before the classifier; incomplete provenance, unsupported policy or
unavailable review also defer. A Run's in-memory witness binds real input;
steering, budget input, cancellation or stale session/mode can invalidate it.
A verdict is checked again before it can allow work.

If configured with a protected `PI_JEV_API_KEY_FILE` path, invoked review can
send bounded action and relevant instructions/prompt context to
`https://api.typesafe.ai/v1/systemone` (`jev-1.13.0`), using the host TypeSafe
classifier with a private key source, not the model registry or an environment
API key. Review the disclosure before configuring the key. Without it, the
ordinary permission path remains. Transport has a two-second cancellation
budget and no retries; four root and eight distinct subagent reviews can be
in flight, independently of Agent capacity. Identical in-flight packets
coalesce; overload defers to human handling.

The [approval menu](interface.md#approval-menu) changes live mode. Widening
requires confirmation; changing modes invalidates pending reviews. A saved
preference is a request, not an allow rule. A same-session record takes
precedence over preferences; on resume judge mode cannot exceed the launch
cap, and yolo is never silently restored. A wider saved mode needs UI consent;
headless startup cannot use a preference to widen the launch mode. Save
explicitly if you want a default.

Automatic allows require a synchronous private audit append after fresh
validation. The Linux writer needs `/proc/self/fd`, verified util-linux flock,
and trustworthy directory ownership. Unsafe or uncertain audit state defers.
In a user namespace, `untrusted_directory_owner` can mean an unmapped ancestor,
not a stale lock; see the [ownership limit](jev-audit-recovery.md#user-namespace-ownership-limit).
Rotation at 1 MiB does not bound archives or guarantee durability. Never delete
a possibly held lock. Stop all writers before upgrade, rollback or
[offline audit recovery](jev-audit-recovery.md); never mix old unlocked writers
with the current protocol. The recovery utility is maintainer-checkout only,
not shipped in the production tarball.

## Communication observation and admission

An `ask_parent` question or an `agent_read` cursor refers to retained Owner
state, not a transferable credential. Off prevents new tasks, steering and
answers, not inspection or accepted child callbacks. See the
[tool contract](tool-contract.md) for observation, answer and handoff rules.

For [scout `return_to`](tool-contract.md#scout-return_to), compound admission
needs an exact synchronous `allow` from the parent's read-only
`checkToolCallPermission("agent_answer", ctx)` for its real tool-call principal.
The decision includes applicable session grants/yolo, records no grant, and
never prompts or invokes the authorizer chain. An ask, deny or unavailable
check installs neither Run. Denies remain final; ordinary separate operations
have their normal gates. The handoff can put untrusted scout text directly into
a worker with Bash/edit/write before the parent model sees it. It is framed as
reference, not parent-authored approval context. The parent-model notice is
not redaction: history and the human UI still retain the source text.

## Recovery and operational boundaries

[Dispatch preflight](task-dispatch.md#preflight-and-admission) can reject known
path denies, but ask/unknown is not a grant. Claims, build-directory leases and
validation observations coordinate declared work only, not arbitrary IO.
[Runtime feedback](runtime-feedback.md) is a partial view of managed blocks;
silence is not permission or evidence that work stopped.

For an unavailable Owner, inspect `/alehouse-status` and follow the
[close and replacement procedure](limitations.md#lifecycle-and-cancellation).
Do not force-unlock, assume rollback, or reload an open Owner. For definition
mismatches, [reconcile matched resources](development.md#matched-resource-migration)
manually and start a fresh process; init does not overwrite existing files.
Historical records never recover pending work or old permission authority.
