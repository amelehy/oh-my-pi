/**
 * Contract: live task previews (inline task cards, the pinned agent tree)
 * summarize a delegated assignment by what it asks for, never by the task
 * template's markdown scaffolding (`# Target`, `None.`).
 */
import { describe, expect, it } from "bun:test";
import { assignmentGist } from "../src/tools/task";

describe("assignmentGist", () => {
	it("prefers the action section over scope sections that come first", () => {
		const assignment =
			"# Target\nNo files.\n\n# Change\n- Run bash `sleep 30` and reply done\n\n# Acceptance\nReplies done.";
		expect(assignmentGist(assignment)).toBe("Run bash `sleep 30` and reply done");
	});

	it("skips the preamble, headings, and empty placeholders when no action section exists", () => {
		expect(assignmentGist("Complete assignment thoroughly:\n\n# Target\nNone.\n\nFiles: src/foo.ts")).toBe(
			"Files: src/foo.ts",
		);
		expect(assignmentGist("Investigate flaky CI on macOS\nthen report")).toBe("Investigate flaky CI on macOS");
	});

	it("falls back to the raw text when every line is scaffolding", () => {
		expect(assignmentGist("# Target\nNone.")).toBe("# Target\nNone.");
	});
});
