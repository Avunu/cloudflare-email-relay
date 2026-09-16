import { describe, it, expect } from "vitest";
import { opsTokenOf } from "../../src/config";

const TOKEN = "an-ops-token-of-at-least-thirty-two-characters";

describe("opsTokenOf", () => {
	it("reads the token, trimmed", () => {
		expect(opsTokenOf({ OPS_TOKEN: TOKEN })).toBe(TOKEN);
		expect(opsTokenOf({ OPS_TOKEN: ` ${TOKEN}\n` })).toBe(TOKEN);
	});

	it("treats unset, blank and whitespace-only as no token", () => {
		expect(opsTokenOf({})).toBeNull();
		expect(opsTokenOf({ OPS_TOKEN: undefined })).toBeNull();
		expect(opsTokenOf({ OPS_TOKEN: "" })).toBeNull();
		expect(opsTokenOf({ OPS_TOKEN: "  " })).toBeNull();
	});

	it("refuses a token too short to be a credential", () => {
		expect(opsTokenOf({ OPS_TOKEN: "short" })).toBeNull();
		expect(opsTokenOf({ OPS_TOKEN: "a".repeat(31) })).toBeNull();
		expect(opsTokenOf({ OPS_TOKEN: "a".repeat(32) })).toBe("a".repeat(32));
	});
});
