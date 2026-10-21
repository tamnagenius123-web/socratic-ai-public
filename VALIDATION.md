# Local validation contract

This contract defines the limited executable source candidate. It does not declare the whole application production-ready or the repository approved for publication.

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

Of the 110 failed tests, 108 depend on uncleared design/evaluation documents, together with the two collection groups; two existing AI configuration-contract failures also reproduce in the baseline. The referenced root document paths are absent from the original default commit too. Private documents, acceptance matrices and answer material were not reinserted to satisfy tests. These failures remain unresolved, even though they predate the public candidate.

## Scope limits

The verified runtime is ephemeral, loopback-only, synthetic, and disconnected from provider services. Real AI inference, embeddings, Vectorize, queue processing, separate debate/ZKP services, production migration upgrades, and remote deployment are outside this passing contract. Optional browser PDF/EPUB/D3/font resources remain external references and are blocked in the local demonstration. Empty knowledge-content tables are intentional; no private corpus or historical learning data is restored.

The original repository remains private. Separation into a new public repository is approved in principle; an empty private staging repository already exists, while upload, final content scope, unresolved test decisions, and final content review are coordinated separately. MIT is approved for owner-controlled code. Third-party notices remain separate. The source-card rights question was resolved for this candidate by an authorized replacement with newly authored synthetic examples; original issuer-attributed material remains private. History-free files and a secret scan are not sufficient evidence of publication or production readiness.

The two additional synthetic-variant smoke checks verify the exposed catalog uses synthetic IDs/authorship and version metadata, and that both synthetic source cards ingest into at least three local chunks. They do not invoke a provider or certify benchmark equivalence. The case prompt and scenario explicitly identify the examples as fictional; the legacy publicFactIds wire field is retained with synthetic values.

The fresh-only held-out table retains exact equality CHECK constraints for the new synthetic case and baseline versions. These are coordinated identity changes, not relaxed constraints or an original-history migration upgrade. During preparation, the first synthetic runs exposed stale version bindings (126 then 124 failures); the remaining binding and schema literals were corrected before the final comparison.

One intermediate full run also exposed the unchanged loopback-router test's concurrent request-order assertion (616 passed / 111 failed). No router code or ordering assertion was changed. The final same-command rerun returned 617 passed / 110 failed with exactly the baseline failure headers; scheduling sensitivity remains a known validation limit.
