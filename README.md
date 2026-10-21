# Socratic AI — local source candidate

This source candidate runs a limited synthetic demonstration of the application. Publication of this limited synthetic source demo is approved. Production deployment has not been verified or approved. The original private repository and its history are preserved separately.

## Run locally

Use Node.js 24 or later. The verified environment used Node 24.19.0 and npm 11.9.0 on Linux.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run local:schema
npm run local:dev
```

Open http://127.0.0.1:8787 and register a synthetic account. There is no seeded administrator or default password. No Cloudflare account, provider API key or environment file is needed. The launcher uses local workerd/D1, generates temporary signing material in memory, and denies Worker outbound fetch/connect requests. The local page also blocks external browser resources. Data and signing material reset when the process stops.

```sh
npm run local:smoke
npm run typecheck:critical-path-b
npm test
```

The separate [validation contract](VALIDATION.md) states which checks pass and which remain incomplete. The full legacy test suite has unresolved failures; the smoke test is not a replacement for it.

## What is included

Application source, workers, tests, text-based assets, a new SVG icon, build tooling, and 83 fresh-database migration derivatives. Those derivatives retain 750 schema statements and 30 reviewed source-defined catalog statements (235 product-configuration rows). They omit 36 historical row/bootstrap statements, including the default account, knowledge-content seeds and data backfills. They are intended for fresh databases and are not a production upgrade path. The local bootstrap records hashes of these public derivatives in its migration ledger.

Embedded reading extracts without a recorded redistribution note have been replaced with three newly authored synthetic examples; API identifiers are preserved. The training catalog now uses two newly authored synthetic demand/operations cards. Their titles, authors, source IDs, versions and case prompt explicitly identify them as examples, with no actual issuer filing or observed dataset claim. Private databases, conversations, captures, research bundles, private design/evaluation documents, frozen answer-key materials and third-party PDFs are excluded.

## Supported local scope

The verified path includes static UI/assets, synthetic signup/login and identity checks, local document upload/chunking/read/delete, ownership boundaries, and database/journey schema readiness. External AI inference and AI readiness, Workers AI embeddings, Vectorize, queue processing, separate debate/ZKP workers and remote deployment are unverified or disabled. Health remains HTTP 503 while real AI invocation readiness is unavailable.

Optional PDF/EPUB parsing, D3 graph loading and web fonts still reference external resources and are blocked in the local demonstration. Full browser interaction has not been tested. The local smoke test does not claim these features work offline.

The sanitized Wrangler files describe binding templates with placeholder resource identifiers. The local launcher does not activate them. Remote package commands fail closed until a future, separately reviewed deployment configuration is supplied. `npm` and package-lock.json are the tested dependency path; the stale alternative pnpm lock is excluded. No dependency was removed to obtain a build.

## Licensing and publication

The owner approved MIT for code they control; see [LICENSE](LICENSE). Existing third-party notices and dependency licenses remain in force and are not relicensed. [Third-party inventory and notices](THIRD_PARTY_NOTICES.md) identify their scope. The former issuer-attributed reference cards have been replaced only in this candidate with newly authored synthetic examples. The original private source is preserved separately; no rights to third-party filings are claimed.

Dependencies, generated builds, local state and environment files are excluded from the publication allowlist. This repository has a new, independent Git history that does not include the original private repository history. A separate history and a secret scan alone do not establish complete confidentiality or production readiness.

The optional PM2 file now invokes the same local launcher. That launcher supplies only generated local signing material to its Worker, without provider credentials. The manual bandit API script rejects non-loopback targets. Those alternate paths have static/guard checks; PM2 itself has not been installed or launched.

## Synthetic training variant

The training case is version `1.1.0-synthetic`, with source manifest `HH-SYNTHETIC-SOURCES-1.0.0`. It practices reasoning about invented demand and operations notes; it does not teach analysis of actual public filings, establish real-world outcomes, or reproduce the original private benchmark/evidence contract. The open-ended rubric and exact source-identity checks remain active. The legacy JSON field `publicFactIds` is retained for wire compatibility, but its values and prompt are explicitly synthetic examples, not public facts. Its contract digest identifies this synthetic variant, not the private research baseline.

Four existing test files have source identity/title/version fixture literals updated for this authorized variant. An exact substitution-replay comparison confirms that all other test source text, assertion operators, control flow and full test selection are preserved. The full legacy failures remain disclosed in VALIDATION.md. The local smoke additionally checks the synthetic catalog metadata and locally ingested source chunks; external AI training flows remain unverified.

The synthetic adapter description is recorded in `src/services/training/case-contracts/synthetic-demo-adapter.json`; it includes no task payload or answer data. Its SHA256 uses sorted-key, compact UTF-8 JSON without a trailing newline. The synthetic contract SHA256 hashes the contract TypeScript source with its digest literal replaced by 64 zeros, prefixed by `HH-PUBLIC-SYNTHETIC-CONTRACT-v1` and a newline, followed by a newline, `HH-SYNTHETIC-CATALOG`, a newline, and the catalog source bytes. These identify the public example, without claiming equivalence to private research artifacts.
