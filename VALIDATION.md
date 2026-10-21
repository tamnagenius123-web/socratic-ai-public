# Local validation contract

This contract defines the limited executable source demo approved for source publication. Production deployment has not been verified or approved, and the whole application is not declared production-ready.

## Required local checks

- A clean install uses the declared npm lock and keeps lifecycle scripts disabled. No dependency is omitted to make a build pass.
- `npm run build` compiles the real application worker and static assets.
- `npm run typecheck:critical-path-b` checks the repository's declared critical TypeScript boundary; it is not a claim of a project-wide type audit.
- `npm run local:schema` compiles all 83 fresh-database migration derivatives with foreign keys enabled, checks referential integrity, and rejects personal/content rows in the bootstrap.
- `npm run local:smoke` exercises real local workerd/D1: static entry and CSS, database/journey readiness, anonymous identity rejection, synthetic registration/login/identity, library access, synthetic document upload/read/delete, ownership isolation, and denied Worker outbound fetch.
- AI readiness must remain degraded when no actual provider has been configured and verified. A local success must not override or fake that readiness contract.

The observed result is a successful build and critical type check, 157 application tables with 235 reviewed catalog rows and no bootstrap account/conversation/document rows, and 16 passing smoke checks. The local migration ledger records the names and hashes of the 83 reviewed derivatives, not an assertion that original historical row transformations were applied.

Loopback HTTP checks observed a rendered entry page, local SVG/CSS assets, rejection of anonymous identity access, and successful synthetic registration. The initial HTTP health probe revealed the missing migration ledger. It was corrected; the final loopback HTTP probe verifies database, journey and growth readiness. HTTP 503 remains the expected overall health status while AI runtime verification is unconfigured. Full browser interaction has not been verified.

## Full legacy suite and baseline comparison

All original Vitest test/fixture files and the Vitest include pattern are retained. Four test files have literal source IDs/titles/versions updated to the authorized synthetic case variant; an exact substitution-replay comparison confirms that all other test source text, assertion operators and control flow are unchanged. The separate manual shell utility has a stricter loopback target guard; its response assertions are retained. `npm test` continues to run the full legacy suite; it is not replaced by the smoke profile.

Under the same Node runtime, verified dependencies, and outbound guard:

| Scope | Passed tests | Failed tests | Passed files | Failed files |
|---|---:|---:|---:|---:|
| Isolated default-commit application baseline | 617 | 110 | 31 | 8 |
| Public source candidate | 617 | 110 | 31 | 8 |

Both runs collect 727 tests across 39 files and share the same 112 failure headers, including two collection failure groups. There are no additional observed candidate failure cases after fixing a producer/consumer binding-template mismatch and adapting only fixture string literals to the synthetic source variant. No assertion was removed, weakened or skipped to obtain this result.

Of the 110 failed tests, 108 depend on uncleared design/evaluation documents. Two additional collection failure groups encounter missing document fixtures before individual test cases are collected; the same two groups occur in the baseline. The remaining two failed tests are the JSON/text parameterizations of one legacy AI fallback test with a redacted mock fixture, unchanged from the baseline. Its success comparison expects a redaction placeholder without the Bearer prefix, so it cannot match the transport header; two fixture provider keys also share the same placeholder. The mocked HTTP 503 failures do not establish actual provider defects or a credential leak. Actual provider fallback and its credential-isolation contract remain unverified. The referenced root document paths are absent from the original default commit too. Private documents, acceptance matrices and answer material were not reinserted to satisfy tests. All 110 failed tests and the two collection groups remain unresolved.

## Scope limits

The verified runtime is ephemeral, loopback-only, synthetic, and disconnected from provider services. Real AI inference, embeddings, Vectorize, queue processing, separate debate/ZKP services, production migration upgrades, and remote deployment are outside this passing contract. Optional browser PDF/EPUB/D3/font resources remain external references and are blocked in the local demonstration. Empty knowledge-content tables are intentional; no private corpus or historical learning data is restored.

The original repository remains private. The reviewed source has been uploaded to the separate socratic-ai-public staging repository with an independent Git history, and publication of this limited synthetic source demo is approved. The staging repository remains private until the separate visibility transition. Production deployment is unverified and unapproved; the unresolved tests and unsupported features remain disclosed here. MIT is approved for owner-controlled code. Third-party notices remain separate. The source-card rights question was resolved for this candidate by an authorized replacement with newly authored synthetic examples; original issuer-attributed material remains private. An independent history and a secret scan do not establish complete confidentiality or production readiness.

The two additional synthetic-variant smoke checks verify the exposed catalog uses synthetic IDs/authorship and version metadata, and that both synthetic source cards ingest into at least three local chunks. They do not invoke a provider or certify benchmark equivalence. The case prompt and scenario explicitly identify the examples as fictional; the legacy publicFactIds wire field is retained with synthetic values.

The fresh-only held-out table retains exact equality CHECK constraints for the new synthetic case and baseline versions. These are coordinated identity changes, not relaxed constraints or an original-history migration upgrade. During preparation, the first synthetic runs exposed stale version bindings (126 then 124 failures); the remaining binding and schema literals were corrected before the final comparison.

One intermediate full run also exposed the unchanged loopback-router test's concurrent request-order assertion (616 passed / 111 failed). No router code or ordering assertion was changed. The final same-command rerun returned 617 passed / 110 failed with exactly the baseline failure headers; scheduling sensitivity remains a known validation limit.

## Source snapshot for executable validation

The build, critical-boundary type check, schema checks, 16 smoke checks and full-suite totals above apply to the source snapshot preserved in root commit `1bad6a0d3057a794e1c163872688df230dbccb00`, tree `dfd3646b312dcfd382f6363c5a89f60e528e8a47`, with 400-file content SHA256 `e2d3ab3da26b14d38e8283c58f96fb685d1d47cf8be1b0d8bc5ec03b2ea6eba7`. This later follow-up changes README.md and VALIDATION.md only. Application, test and configuration bytes are unchanged; executable checks were not rerun for these documentation edits. The two edited documents receive a separate offline secret scan and the updated file inventory is verified against remote Git blobs.
