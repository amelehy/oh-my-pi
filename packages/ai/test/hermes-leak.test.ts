import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { recoverHermesToolCallLeak } from "@oh-my-pi/pi-ai/utils/hermes-leak";

const TOOLS = new Set(["bash", "read"]);

function createUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function textMessage(text: string, extra: AssistantMessage["content"] = []): AssistantMessage {
	return {
		role: "assistant",
		content: [...extra, { type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "qwen2.5-coder:7b",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function recoveredCalls(message: AssistantMessage) {
	return message.content.flatMap(block =>
		block.type === "toolCall" ? [{ name: block.name, arguments: block.arguments }] : [],
	);
}

describe("recoverHermesToolCallLeak", () => {
	it("converts the untagged call qwen2.5-coder emits on Ollama", () => {
		// Verbatim reply from `qwen2.5-coder:7b` via Ollama for "pull down the latest main".
		const message = textMessage(
			'{"name": "bash", "arguments": {"command": "git fetch origin main", "i": "pull down the latest main"}}',
		);
		expect(recoverHermesToolCallLeak(message, TOOLS)).toBe(true);
		expect(message.stopReason).toBe("toolUse");
		expect(message.content.some(block => block.type === "text")).toBe(false);
		expect(recoveredCalls(message)).toEqual([
			{ name: "bash", arguments: { command: "git fetch origin main", i: "pull down the latest main" } },
		]);
	});

	it("converts tagged, fenced, and multi-call replies, keeping thinking", () => {
		const tagged = textMessage('<tool_call>\n{"name": "read", "arguments": {"path": "a.txt"}}\n</tool_call>');
		expect(recoverHermesToolCallLeak(tagged, TOOLS)).toBe(true);
		expect(recoveredCalls(tagged)).toEqual([{ name: "read", arguments: { path: "a.txt" } }]);

		const fenced = textMessage(
			'```json\n{"name": "bash", "arguments": "{\\"command\\": \\"ls\\"}"}\n{"name": "read", "parameters": {"path": "b"}}\n```',
			[{ type: "thinking", thinking: "list then read" }],
		);
		expect(recoverHermesToolCallLeak(fenced, TOOLS)).toBe(true);
		expect(fenced.content[0]).toEqual({ type: "thinking", thinking: "list then read" });
		expect(recoveredCalls(fenced)).toEqual([
			{ name: "bash", arguments: { command: "ls" } },
			{ name: "read", arguments: { path: "b" } },
		]);
	});

	it("leaves prose, unknown tools, malformed JSON, and existing calls untouched", () => {
		const cases = [
			'Run this: {"name": "bash", "arguments": {"command": "ls"}}',
			'{"name": "delete_everything", "arguments": {}}',
			'{"name": "bash", "arguments": {"command": "ls"}',
			'{"name": "bash", "arguments": ["ls"]}',
			'```python\n{"name": "bash", "arguments": {"command": "ls"}}\n```',
		];
		for (const text of cases) {
			const message = textMessage(text);
			expect(recoverHermesToolCallLeak(message, TOOLS)).toBe(false);
			expect(message.content).toEqual([{ type: "text", text }]);
			expect(message.stopReason).toBe("stop");
		}

		const withCall = textMessage('{"name": "bash", "arguments": {"command": "ls"}}', [
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "x" } },
		]);
		expect(recoverHermesToolCallLeak(withCall, TOOLS)).toBe(false);
		expect(recoverHermesToolCallLeak(textMessage('{"name": "bash", "arguments": {}}'), new Set())).toBe(false);
	});
});

describe("recoverHermesToolCallLeak argument handling", () => {
	it("leaves a reply whose string arguments are not JSON as text", () => {
		const text = '{"name": "bash", "arguments": "ls -la"}';
		const message = textMessage(text);
		expect(recoverHermesToolCallLeak(message, TOOLS)).toBe(false);
		expect(message.content).toEqual([{ type: "text", text }]);
	});
});
