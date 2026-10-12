/**
 * Recovery of Hermes-format tool calls left in visible assistant text.
 *
 * Qwen chat templates ask for `<tool_call>{"name", "arguments"}</tool_call>`.
 * Small Qwen models (e.g. `qwen2.5-coder:7b` on Ollama) often drop the tags or
 * wrap the object in a code fence, so the host's template parser misses the call
 * and returns it as plain text on every transport (Responses, Chat Completions,
 * native `/api/chat`). The agent then shows JSON and never runs the tool. A reply
 * made solely of such call objects naming offered tools is converted back into
 * structured tool calls before the message is committed.
 */

import { isRecord } from "@oh-my-pi/pi-utils";
import type { AssistantMessage, Model, ToolCall } from "../types";
import { generateHealedToolCallId } from "./stream-markup-healing";
import { parseToolCallArguments } from "./tool-call-arguments";

const CODE_FENCE = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/i;
const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";

/** Hosts that serve Qwen through a chat template whose Hermes parser misses untagged calls. */
const TEMPLATE_PARSER_PROVIDERS: Record<string, true> = {
	ollama: true,
	"llama.cpp": true,
	"lm-studio": true,
	vllm: true,
};

/**
 * Whether Hermes leak recovery applies to `model`: a Qwen-class model on a local
 * template-parsing host. Hosted APIs parse Qwen calls natively, so there a bare
 * call object in text is a deliberate reply (e.g. "show me the JSON call") and
 * must not be executed.
 */
export function isHermesLeakRecoveryTarget(model: Model): boolean {
	if (model.identity?.class !== "qwen") return false;
	return model.api === "ollama-chat" || TEMPLATE_PARSER_PROVIDERS[model.provider] === true;
}

/**
 * Parse `text` as nothing but Hermes call objects — bare, `<tool_call>`-tagged,
 * comma/newline separated, optionally inside one bare or `json` code fence —
 * each naming a tool in `toolNames`. Returns `undefined` for anything else, so
 * prose that merely contains JSON is left alone.
 */
function parseHermesToolCallText(
	text: string,
	toolNames: ReadonlySet<string>,
): { name: string; arguments: Record<string, unknown> }[] | undefined {
	let body = text.trim();
	const fence = CODE_FENCE.exec(body);
	if (fence) body = fence[1]!.trim();
	const calls: { name: string; arguments: Record<string, unknown> }[] = [];
	let index = 0;
	while (index < body.length) {
		if (body.startsWith(TOOL_CALL_OPEN, index) || body.startsWith(TOOL_CALL_CLOSE, index)) {
			index += body.startsWith(TOOL_CALL_OPEN, index) ? TOOL_CALL_OPEN.length : TOOL_CALL_CLOSE.length;
			continue;
		}
		const char = body[index]!;
		if (char === "," || /\s/.test(char)) {
			index++;
			continue;
		}
		if (char !== "{") return undefined;
		const end = findJsonObjectEnd(body, index);
		if (end === -1) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(body.slice(index, end));
		} catch {
			return undefined;
		}
		if (!isRecord(parsed)) return undefined;
		const name = parsed.name;
		if (typeof name !== "string" || !toolNames.has(name)) return undefined;
		let args = parsed.arguments ?? parsed.parameters;
		if (typeof args === "string") args = parseToolCallArguments(args);
		// Unparseable string arguments come back as a `__parseError` record; that is prose, not a call.
		if (!isRecord(args) || "__parseError" in args) return undefined;
		calls.push({ name, arguments: args });
		index = end;
	}
	return calls.length > 0 ? calls : undefined;
}

/**
 * Replace `message`'s text with structured tool calls when the text is solely
 * Hermes call objects naming offered tools. Thinking blocks are kept. Returns
 * true when the message was rewritten; its stop reason becomes `toolUse`.
 */
export function recoverHermesToolCallLeak(message: AssistantMessage, toolNames: ReadonlySet<string>): boolean {
	if (toolNames.size === 0) return false;
	let text = "";
	for (const block of message.content) {
		if (block.type === "toolCall") return false;
		if (block.type === "text") text += block.text;
	}
	const calls = parseHermesToolCallText(text, toolNames);
	if (!calls) return false;
	const toolCalls: ToolCall[] = calls.map(call => ({
		type: "toolCall",
		id: generateHealedToolCallId(),
		name: call.name,
		arguments: call.arguments,
	}));
	message.content = [...message.content.filter(block => block.type !== "text"), ...toolCalls];
	message.stopReason = "toolUse";
	return true;
}

/** Index just past the `}` closing the object opened at `start`, or -1. */
function findJsonObjectEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (char === "\\") i++;
			else if (char === '"') inString = false;
		} else if (char === '"') {
			inString = true;
		} else if (char === "{") {
			depth++;
		} else if (char === "}") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}
