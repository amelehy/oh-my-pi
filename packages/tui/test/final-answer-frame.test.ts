/**
 * Contract: the reply that ends a turn renders inside an accent box titled
 * `Answer` with the turn's totals, so it stands apart from the steps logged
 * above it; replies that hand off to tool calls, and turns with no prose, keep
 * the plain transcript presentation.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent, markFinalAnswer } from "@oh-my-pi/pi-tui/chat/assistant-message";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";

function reply(stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	} as unknown as AssistantMessage;
}

function finishRaw(message: AssistantMessage): readonly string[] {
	const container = new TranscriptContainer();
	const component = new AssistantMessageComponent(message);
	container.addChild(component);
	component.setTurnUsage({ elapsedMs: 12_400, input: 18_000, output: 1_000, cost: 0.02 });
	markFinalAnswer(container, component, message);
	return component.render(60);
}

function finish(message: AssistantMessage): string[] {
	return finishRaw(message).map(row => Bun.stripANSI(row));
}

describe("final answer frame", () => {
	const initial = chatTranscriptDisplayPreferences.answerFrame;
	beforeAll(async () => {
		await initTheme();
	});
	afterEach(() => {
		setChatTranscriptDisplayPreferences({ answerFrame: initial });
		vi.restoreAllMocks();
	});

	it("boxes the turn-ending reply under an Answer title carrying the turn's totals", () => {
		setChatTranscriptDisplayPreferences({ answerFrame: true });
		const rows = finish(reply("stop", [{ type: "text", text: "All three agents finished." }]));
		expect(rows[0]).toStartWith(theme.boxRound.topLeft);
		expect(rows[0]).toContain("Answer");
		expect(rows[0]).toContain("12.4s");
		expect(rows.at(-1)).toStartWith(theme.boxRound.bottomLeft);
		const body = rows.find(row => row.includes("All three agents finished."))!;
		expect(body).toStartWith(theme.boxRound.vertical);
		expect(body.trimEnd()).toEndWith(theme.boxRound.vertical);
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(60);
	});

	it("fills every row of the box, table rows included, with the lighter answer background", () => {
		setChatTranscriptDisplayPreferences({ answerFrame: true });
		const fill = theme.getBgAnsi("customMessageBg");
		const rows = finishRaw(
			reply("stop", [{ type: "text", text: "Done.\n\n| Agent | Time |\n|---|---|\n| Alpha | 29.4s |" }]),
		);
		for (const row of rows) expect(row).toStartWith(fill);
		// Inner resets (bold, table borders) re-apply the fill so it never drops out mid-row.
		const tableRow = rows.find(row => Bun.stripANSI(row).includes("Alpha"))!;
		for (const reset of tableRow.matchAll(/\x1b\[(?:0|49)?m(?!$)/g)) {
			expect(tableRow.slice(reset.index! + reset[0].length)).toStartWith(fill);
		}
	});

	it("leaves step replies, prose-less turns, and the disabled setting unboxed", () => {
		setChatTranscriptDisplayPreferences({ answerFrame: true });
		const handoff = finish(
			reply("toolUse", [
				{ type: "text", text: "Checking the hosts file." },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/etc/hosts" } },
			]),
		);
		expect(handoff.join("\n")).not.toContain("Answer");
		expect(handoff.join("\n")).toContain("Checking the hosts file.");

		const aborted = finish(reply("aborted", [{ type: "text", text: "Partial reply" }]));
		expect(aborted.join("\n")).not.toContain("Answer");

		const thinkingOnly = finish(reply("stop", [{ type: "thinking", thinking: "Nothing to say." }]));
		expect(thinkingOnly.join("\n")).not.toContain("Answer");

		setChatTranscriptDisplayPreferences({ answerFrame: false });
		const disabled = finish(reply("stop", [{ type: "text", text: "All done." }]));
		expect(disabled.join("\n")).not.toContain("Answer");
		expect(disabled.join("\n")).toContain("All done.");
	});

	it("closes a reply whose head already reached history with a rule instead of a box", () => {
		setChatTranscriptDisplayPreferences({ answerFrame: true });
		const component = new AssistantMessageComponent(reply("stop", [{ type: "text", text: "Long reply." }]));
		component.setFinalAnswer("rule");
		const rows = component.render(60).map(row => Bun.stripANSI(row));
		expect(rows[0]).not.toStartWith(theme.boxRound.topLeft);
		expect(rows.some(row => row.includes("Long reply."))).toBe(true);
		expect(rows.at(-1)).toContain("Answer ↑");
	});

	it("keeps image rows out of the box: a reply holding them takes the closing rule", () => {
		setChatTranscriptDisplayPreferences({ answerFrame: true });
		// Stand in for a terminal image row (picture, figure, or chart) so the test runs on any terminal.
		vi.spyOn(TERMINAL, "isImageLine").mockImplementation(line => line.includes("IMAGE-ROW"));
		const rows = finish(reply("stop", [{ type: "text", text: "Here is the chart.\n\nIMAGE-ROW" }]));
		expect(rows[0]).not.toStartWith(theme.boxRound.topLeft);
		const imageRow = rows.find(row => row.includes("IMAGE-ROW"))!;
		expect(imageRow).not.toContain(theme.boxRound.vertical);
		expect(rows.at(-1)).toContain("Answer ↑");
	});

	it("keeps the style a reused answer was first given when a rebuild marks it again", () => {
		setChatTranscriptDisplayPreferences({ answerFrame: true });
		const message = reply("stop", [{ type: "text", text: "Reused." }]);
		const component = new AssistantMessageComponent(message);
		component.setFinalAnswer("rule");
		const container = new TranscriptContainer();
		container.addChild(component);
		// The container would allow a frame here; a reused block keeps its earlier decision.
		markFinalAnswer(container, component, message);
		expect(component.finalAnswer).toBe("rule");
	});
});
