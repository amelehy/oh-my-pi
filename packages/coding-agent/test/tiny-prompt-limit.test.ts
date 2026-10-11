import { describe, expect, it } from "bun:test";
import { onnxSafePromptTokens, tailTokenIds } from "@oh-my-pi/pi-coding-agent/tiny/prompt-limit";

describe("onnx prompt position limit", () => {
	it("reserves generated tokens inside the rotary table", () => {
		expect(onnxSafePromptTokens(32768, 1024)).toBe(31744);
		expect(onnxSafePromptTokens(32768, 1)).toBe(32767);
	});

	it("keeps the tail of an over-long prompt", () => {
		expect(tailTokenIds([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
		expect(tailTokenIds([1, 2, 3], 8)).toEqual([1, 2, 3]);
	});
});
