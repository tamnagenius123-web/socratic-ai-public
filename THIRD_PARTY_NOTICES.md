# Third-party inventory

This file records installed package metadata and preserves available vendor notices. Owner-controlled Socratic AI code is licensed under MIT. This inventory does not relicense third-party material or certify redistribution rights.

| Package | Pinned installed version | Package license label | Available notice files |
|---|---|---|---|
| hono | 4.12.9 | MIT | [LICENSE](third-party-licenses/hono/LICENSE) |
| @cloudflare/workers-types | 4.20260329.1 | MIT OR Apache-2.0 | License label from package metadata; package contents are not vendored here |
| @hono/vite-build | 1.10.1 | MIT | License label from package metadata; package contents are not vendored here |
| @hono/vite-dev-server | 0.18.3 | MIT | License label from package metadata; package contents are not vendored here |
| @types/node | 24.13.3 | MIT | [LICENSE](third-party-licenses/types__node/LICENSE) |
| tailwindcss | 3.4.19 | MIT | [LICENSE](third-party-licenses/tailwindcss/LICENSE) |
| typescript | 7.0.2 | Apache-2.0 | [NOTICE.txt](third-party-licenses/typescript/NOTICE.txt), [LICENSE](third-party-licenses/typescript/LICENSE) |
| vite | 6.4.1 | MIT | [LICENSE.md](third-party-licenses/vite/LICENSE.md) |
| vitest | 3.2.4 | MIT | [LICENSE.md](third-party-licenses/vitest/LICENSE.md) |
| wrangler | 4.79.0 | MIT OR Apache-2.0 | License label from package metadata; package contents are not vendored here |
| miniflare | 4.20260329.0 | MIT | License label from package metadata; package contents are not vendored here |

Hono and Tailwind license files are also copied into public/third-party-licenses so the local build carries them. Two installed development-only libvips packages carry LGPL-3.0-or-later labels; node_modules and native binaries are excluded from the publication candidate. Any later binary/tooling distribution needs its own license review.

Optional browser features still reference PDF.js 3.11.174, epub.js 0.3.93, D3 7, and Google Fonts. Those assets are not vendored here; local-demo browser policy blocks external resources. Their notices/rights and offline support remain an owner decision.

The root MIT LICENSE and first-party package metadata apply only to copyright controlled by tamnagenius123-web. Existing vendor notices remain unchanged. Former issuer-attributed reference cards in src/services/training/case-catalog.ts were replaced with newly authored, explicitly synthetic examples and matching source identities. No excerpt or redistribution claim to an actual corporate filing remains in those cards. Original research publications, screenshots, databases, and unreviewed literary extracts are not included.
