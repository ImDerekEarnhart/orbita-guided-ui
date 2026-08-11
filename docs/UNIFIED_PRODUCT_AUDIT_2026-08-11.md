# Unified Orbita product audit — 2026-08-11

## Outcome

Orbita is one governed core with two user interfaces:

- Guided provides the beginner workflow and human review screens.
- MCP exposes the larger agent-facing toolset to an AI assistant.
- Both resolve a Guided user to the same isolated core tenant and evidence store.

The audited build passed 293 core tests and 131 Guided tests. A staged end-to-end
smoke created a case, uploaded a CSV, compiled and approved the exact plan hash,
completed a run, returned findings and claims, rendered the report and evidence
graph, and then deleted the isolated smoke case.

## Capability map

| Capability | Guided | MCP | Audit result |
| --- | --- | --- | --- |
| Create/list/delete isolated cases | Yes | Yes | Tested |
| Upload and profile tabular evidence | CSV in browser | Text, tables, code, notebooks, governed large-upload path | Tested |
| Compile, hash, approve, and run a plan | Five-step wizard | Direct tools | Tested end to end |
| Plain-language findings and technical receipts | Yes | Structured results and reports | Tested |
| Claim history, impact, contradictions, supersession | Read views | Full governed toolset | Tested |
| Project memory graphs and cross-case operators | Yes | Yes | Tested |
| Programme state and follow-up questions | Yes | Yes | Tested |
| Frozen blind tournaments | Advanced lab | Yes | Tested contracts and receipts |
| Deterministic epistemic adjudication | Explained in guide | Yes | Tested benchmarks and task contracts |
| Evidence and code-context compression | Explained in guide | Yes | Tested tool contracts |
| Imported archive memory and reversal candidates | Not yet a browser workflow | Yes | Tested |
| Curated research knowledge and graph analysis | Not yet a browser workflow | Yes | Restored and tested |
| Governed self-improvement proposals | Not a beginner workflow | Yes | Tested approval and rollback controls |

The MCP server currently registers 61 tools. The Guided web application has 70
explicit application routes, backed by 14 unified core route groups plus the
Discovery Genome service bridge.

## Improvements made in this audit

1. Restored the valid curated `knowledge.sqlite` package. The replaced artifact
   was unreadable and caused knowledge search to fail.
2. Added an integrity and required-table check when the knowledge store opens,
   so a bad deployment fails clearly instead of breaking later during search.
3. Added a beginner capability map and a “How to use Orbita” page.
4. Explained Guided and MCP as two doors into the same governed core.
5. Added actionable timeout copy that warns users to inspect an existing case
   before submitting duplicate work.
6. Fixed mobile navigation, which previously hid every primary navigation link.
7. Added a database-backed run-worker heartbeat to service health.
8. Added a visible warning when the website can accept work but no healthy
   worker is available to execute queued discoveries.
9. Created the missing production worker service and verified its heartbeat.

## Deployment evidence

- Staging core: healthy; unified Guided bridge configured.
- Staging Guided: healthy; `orbita_core_mode=unified`; run worker ready.
- Production core: healthy; OAuth GitHub authentication; Guided bridge configured.
- Production Guided: healthy internally; `orbita_core_mode=unified`; run worker ready.
- Production worker: healthy and reporting a unified-backend heartbeat.

The public Guided address remains `https://staging.safeusi.com`. The Railway
production Guided service currently has no public domain attached, so changing
which environment the public hostname serves should be treated as a separate,
intentional cutover rather than silently moving user traffic during this audit.

## Honest remaining boundaries

- The browser does not expose every MCP-only capability as a full visual workflow.
  That is intentional for advanced controls, but memory import, compression, and
  adjudication could receive dedicated Guided workflows in a later product pass.
- Local ownership integration tests require a real `DATABASE_URL` and therefore
  skip in the dependency-free test run. The deployed web and worker both reached
  PostgreSQL and the worker heartbeat table successfully.
- The repositories still contain older baseline lint debt outside the files
  changed by this audit. Functional suites are green; repository-wide lint is not.
- The deployed local changes should be committed and pushed on their existing
  feature branches so Git history exactly reproduces the running services.
