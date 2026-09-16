import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { BINDINGS, outboundService } from "./test/integration/outbound";

// Integration tests run inside the real Workers runtime (workerd) so they exercise R2, the
// InboxQueue Durable Object (SQLite + alarm) and the ops API end-to-end: a message is stored
// before it is pushed, a failed push is retried on the schedule, and a rejected one is not.
//
// Everything the worker fetches goes through `outboundService` — a fake Odoo and a fake Frappe
// that answer by recipient and record what they were sent (test/integration/outbound.ts). There
// is no network. The Worker under test is test/integration/worker.ts: the relay bound to the
// fixture tenant table.
//
// Vitest-pool-workers v0.18+ (for vitest 4) exposes its runtime as a Vite plugin,
// `cloudflareTest(workersConfig)`, rather than the older `poolOptions.workers` config.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./test/integration/wrangler.jsonc" },
			miniflare: {
				bindings: { ...BINDINGS },
				outboundService,
			},
		}),
	],
	test: {
		include: ["test/integration/**/*.test.ts"],
	},
});
