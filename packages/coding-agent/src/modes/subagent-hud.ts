/**
 * Pinned live agent tree: the block above the editor that shows every
 * subagent in flight as a tree (spawner → spawned), with a live status glyph,
 * what each agent is doing right now, and its elapsed time and spend.
 *
 * The block appears when the first subagent starts and clears itself once no
 * subagent is active. While any agent of a spawn wave is still running, its
 * finished siblings and descendants stay listed with their outcome, so the
 * tree reads as progress ("2 of 5 done") instead of rows silently vanishing.
 */
import {
	getPaddingX,
	getWidthConfigEpoch,
	SPINNER_ADVANCE_MS,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import type { Component } from "@oh-my-pi/pi-tui";
import { sharedSpinnerFrame } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { formatCost } from "@oh-my-pi/pi-tui/overlays/agent-hub-renderer";
import type { ObservableSession } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-tui/prompt/composer";
import {
	FEED_MODEL_BADGE_WIDTH,
	formatFeedModelBadge,
	isFeedModelBadgeEnabled,
	previewLine,
	replaceTabs,
	shortenEmbeddedPaths,
	shortenToolArgumentPaths,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";
import { getTreeBranch, getTreeContinuePrefix } from "@oh-my-pi/pi-tui/render/utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { agentTypeBadge, assignmentGist, formatTaskId } from "@oh-my-pi/pi-tui/tools/task";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import { labelEchoesHandle } from "../task/label";

/** Agent rows a collapsed tree shows before the expander (running agents and their spawners first). */
export const SUBAGENT_HUD_COLLAPSED_LIMIT = 5;

/** A running tool call earns an elapsed marker in its activity row once it outlasts this. */
const ACTIVITY_ELAPSED_MIN_MS = 5000;

/** Narrowest detail worth showing after the tool name in an activity row. */
const ACTIVITY_MIN_DETAIL_WIDTH = 8;

/** Narrowest left column that still earns right-aligned metrics. */
const METRICS_MIN_LEFT_WIDTH = 28;

/** Lines before the first agent row: a leading blank and the header. */
const HUD_CHROME_ROWS = 2;

type HudStatus = "running" | "done" | "failed" | "aborted";

interface HudNode {
	session: ObservableSession;
	/** Id relative to the parent row, so nested rows don't repeat the breadcrumb. */
	name: string;
	status: HudStatus;
	children: HudNode[];
	parent: HudNode | undefined;
}

export interface SubagentHudOptions {
	/** Terminal columns; rows are budgeted to the padded content width. */
	columns: number;
	/** Show every agent instead of the collapsed few. */
	expanded?: boolean;
	/** Give each running agent a second row with its current (or last) tool call. */
	livePreview?: boolean;
	/** Pre-formatted key that opens the agent hub, shown at the header's right edge. */
	hubKey?: string;
	/** Clock for elapsed time and spinner phase; defaults to now. */
	now?: number;
	/** Spinner phase; defaults to the shared tool-block clock so every spinner moves in lockstep. */
	spinnerFrame?: number;
	/** Arm repaints; false (e.g. while `/pause` covers the screen) yields no tick. */
	animate?: boolean;
}

/** One paint of the pinned tree plus what the host needs to route clicks and schedule the next frame. */
export interface SubagentHudView {
	/** Line 0 is blank, line 1 the header; agent rows follow in `order`; the expander (if any) is last. */
	lines: string[];
	/** Agent id per agent row, in painted order. */
	order: string[];
	/** Line index of the expander row, when one is shown. */
	toggleRow: number | undefined;
	/** Delay until the next repaint is needed; undefined when nothing animates. */
	tickMs: number | undefined;
}

function hudStatus(session: ObservableSession): HudStatus {
	switch (session.status) {
		case "active":
			return "running";
		case "completed":
			return "done";
		case "failed":
			return "failed";
		case "aborted":
			return "aborted";
	}
}

/**
 * Subagents the tree shows: every active one, plus finished ones from the
 * same spawn wave — siblings of the same `task` call, or relatives under the
 * same top-level agent — while that wave still has an agent running.
 * Empty when nothing is active, so the block clears.
 */
export function selectHudSessions(sessions: readonly ObservableSession[]): ObservableSession[] {
	const subagents = sessions.filter(session => session.kind === "subagent");
	const active = subagents.filter(session => session.status === "active");
	if (active.length === 0) return [];
	const liveCalls = new Set<string>();
	const liveRoots = new Set<string>();
	for (const session of active) {
		if (session.parentToolCallId) liveCalls.add(session.parentToolCallId);
		liveRoots.add(session.id.split(".", 1)[0]!);
	}
	return subagents.filter(
		session =>
			session.status === "active" ||
			(session.parentToolCallId !== undefined && liveCalls.has(session.parentToolCallId)) ||
			liveRoots.has(session.id.split(".", 1)[0]!),
	);
}

/** Nest sessions by dotted id: a row's parent is its longest listed id prefix. Order follows `sessions`. */
function buildForest(sessions: readonly ObservableSession[]): HudNode[] {
	const nodes = new Map<string, HudNode>();
	for (const session of sessions) {
		nodes.set(session.id, { session, name: session.id, status: hudStatus(session), children: [], parent: undefined });
	}
	const roots: HudNode[] = [];
	for (const node of nodes.values()) {
		const id = node.session.id;
		let parent: HudNode | undefined;
		for (let dot = id.lastIndexOf("."); dot > 0; dot = id.lastIndexOf(".", dot - 1)) {
			parent = nodes.get(id.slice(0, dot));
			if (parent) break;
		}
		if (parent) {
			node.parent = parent;
			node.name = id.slice(parent.session.id.length + 1);
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}
	return roots;
}

function* preorder(nodes: readonly HudNode[]): Generator<HudNode> {
	for (const node of nodes) {
		yield node;
		yield* preorder(node.children);
	}
}

/**
 * Agents a collapsed tree keeps: running agents first (each with the spawners
 * above it, so the tree never shows an orphan), then failures, then the rest
 * in tree order, up to `limit` rows.
 */
function pickCollapsed(roots: readonly HudNode[], limit: number): Set<HudNode> {
	const keep = new Set<HudNode>();
	const all = [...preorder(roots)];
	const passes: ReadonlyArray<(node: HudNode) => boolean> = [
		node => node.status === "running",
		node => node.status === "failed" || node.status === "aborted",
		() => true,
	];
	for (const admits of passes) {
		for (const node of all) {
			if (keep.has(node) || !admits(node)) continue;
			const chain: HudNode[] = [];
			for (let cursor: HudNode | undefined = node; cursor && !keep.has(cursor); cursor = cursor.parent) {
				chain.push(cursor);
			}
			if (keep.size + chain.length > limit) continue;
			for (const member of chain) keep.add(member);
		}
	}
	return keep;
}

/** Whole seconds under a minute (`12s`), then the shared compact form (`1m5s`). */
function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : formatDuration(seconds * 1000);
}

/** Agent time so far: the last snapshot's duration, advanced by wall time while it runs. */
function elapsedMs(session: ObservableSession, now: number): number | undefined {
	const progress = session.progress;
	if (!progress) return undefined;
	if (session.status === "active" && session.progressAt !== undefined) {
		return progress.durationMs + Math.max(0, now - session.progressAt);
	}
	return progress.durationMs;
}

function statusGlyph(status: HudStatus, spinnerFrame: number): string {
	switch (status) {
		case "running": {
			const frames = theme.spinnerFrames;
			return theme.fg("accent", frames[spinnerFrame % frames.length] ?? theme.status.running);
		}
		case "done":
			return theme.styledSymbol("status.success", "success");
		case "failed":
			return theme.styledSymbol("status.error", "error");
		case "aborted":
			return theme.styledSymbol("status.aborted", "warning");
	}
}

function styledName(status: HudStatus, name: string): string {
	switch (status) {
		case "running":
			return theme.fg("accent", theme.bold(name));
		case "done":
			return theme.fg("muted", name);
		case "failed":
			return theme.fg("error", theme.bold(name));
		case "aborted":
			return theme.fg("warning", name);
	}
}

function singleLine(text: string): string {
	return replaceTabs(text).replace(/\s*[\r\n]+\s*/g, " ↵ ");
}

/** Left text and right-aligned metrics in one row; metrics drop first when the row is narrow. */
function fitRow(left: string, right: string, width: number, minLeft = 0): string {
	const rightWidth = visibleWidth(right);
	if (rightWidth > 0 && width - rightWidth - 2 >= Math.max(minLeft, METRICS_MIN_LEFT_WIDTH)) {
		const leftFit = truncateToWidth(left, width - rightWidth - 2);
		const gap = width - visibleWidth(leftFit) - rightWidth;
		return `${leftFit}${" ".repeat(gap)}${right}`;
	}
	return truncateToWidth(left, width);
}

/**
 * Agent row: status glyph, name, role badge, label; elapsed time and spend on
 * the right. The name and role are reserved first; the model badge, label and
 * metrics share whatever width is left.
 */
function renderAgentRow(node: HudNode, prefix: string, width: number, now: number, spinnerFrame: number): string {
	const { session, status } = node;
	const progress = session.progress;
	const rowWidth = Math.max(0, width - visibleWidth(prefix));
	const lead = `${statusGlyph(status, spinnerFrame)} `;
	const name = truncateToWidth(formatTaskId(node.name), Math.max(0, rowWidth - visibleWidth(lead)));
	const role = truncateToWidth(
		agentTypeBadge(session.agent ?? progress?.agent, theme),
		Math.max(0, rowWidth - visibleWidth(lead) - visibleWidth(name)),
	);
	const identityWidth = visibleWidth(lead) + visibleWidth(name) + visibleWidth(role);
	const modelBudget = Math.min(FEED_MODEL_BADGE_WIDTH, rowWidth - identityWidth - 1);
	const modelBadge =
		isFeedModelBadgeEnabled() && modelBudget > 0
			? formatFeedModelBadge(
					progress?.resolvedModelIdentity ?? progress?.resolvedModel,
					progress?.resolvedThinkingLevel,
					progress?.advisor,
					theme,
					modelBudget,
				)
			: "";
	let left = `${lead}${modelBadge ? `${modelBadge} ` : ""}${styledName(status, name)}${role}`;
	const reserved = visibleWidth(left);

	const description = session.description?.trim() || progress?.description?.trim();
	const label = description && !labelEchoesHandle(session.id, description) ? description : undefined;
	if (label) {
		const tone = status === "running" ? "text" : "dim";
		left += `${theme.fg("dim", ":")} ${theme.fg(tone, singleLine(label))}`;
	} else {
		// No label yet (the tiny-model label lands a beat after spawn): show
		// the assignment's first real line, not its markdown scaffolding.
		const gist = progress?.task ? assignmentGist(progress.task) : "";
		if (gist && !labelEchoesHandle(session.id, gist)) {
			left += ` ${theme.fg("muted", previewLine(singleLine(gist), TRUNCATE_LENGTHS.SHORT))}`;
		}
	}

	const metrics: string[] = [];
	const elapsed = elapsedMs(session, now);
	if (elapsed !== undefined) metrics.push(formatElapsed(elapsed));
	if (progress && progress.cost > 0) metrics.push(formatCost(progress.cost));
	const right = metrics.length > 0 ? theme.fg("dim", metrics.join(theme.sep.dot)) : "";
	return `${prefix}${fitRow(left, right, rowWidth, reserved)}`;
}

/**
 * What a running agent is doing: its current tool call with a one-line detail
 * (the call's own intent, else its args) and, once it has run a while, an
 * elapsed marker; between calls, the last call marked with how it ended; a
 * pending retry; or that it is still thinking. The row never overflows `width`.
 */
function renderActivityRow(session: ObservableSession, prefix: string, width: number, now: number): string {
	const rowWidth = Math.max(0, width - visibleWidth(prefix));
	const hook = `${theme.fg("dim", theme.tree.hook)} `;
	const progress = session.progress;
	if (!progress) return `${prefix}${truncateToWidth(`${hook}${theme.fg("dim", "starting…")}`, rowWidth, "")}`;
	if (progress.retryState) {
		const remainingMs = Math.max(0, progress.retryState.startedAtMs + progress.retryState.delayMs - now);
		const when = remainingMs > 0 ? `in ${formatElapsed(remainingMs)}` : "now";
		// Provider error bodies can carry ANSI and control bytes; strip them before they reach the pinned chrome.
		const summary = `retrying ${progress.retryState.attempt}/${progress.retryState.maxAttempts} ${when}: ${singleLine(sanitizeText(progress.retryState.errorMessage))}`;
		return `${prefix}${truncateToWidth(`${hook}${theme.fg("warning", summary)}`, rowWidth)}`;
	}
	const currentTool = progress.currentTool;
	const recent = progress.recentTools[0];
	const tool = currentTool ?? recent?.tool;
	if (!tool) {
		const intent = progress.lastIntent ? `: ${shortenEmbeddedPaths(singleLine(progress.lastIntent))}` : "";
		return `${prefix}${truncateToWidth(`${hook}${theme.fg("dim", `thinking${intent || "…"}`)}`, rowWidth)}`;
	}
	const intent = currentTool ? progress.currentToolIntent : recent?.intent;
	const args = currentTool ? progress.currentToolArgs : recent?.args;
	const argsKey = currentTool ? progress.currentToolArgsKey : recent?.argsKey;
	// A model-written intent is prose, so home paths inside it are shortened as they stand. An argument is
	// shortened by its key, so a literal search pattern that names a home path still shows what was searched.
	const detail = intent
		? shortenEmbeddedPaths(replaceTabs(intent))
		: args
			? shortenToolArgumentPaths(replaceTabs(args), argsKey)
			: undefined;
	const toolElapsed = currentTool && progress.currentToolStartMs ? now - progress.currentToolStartMs : 0;
	const elapsedLabel =
		toolElapsed > ACTIVITY_ELAPSED_MIN_MS
			? `${theme.sep.dot}${theme.fg("warning", formatDuration(toolElapsed))}`
			: "";
	const elapsedWidth = visibleWidth(elapsedLabel);
	// Between calls the row keeps the last call, marked with how it ended.
	const outcome =
		!currentTool && recent
			? `${theme.styledSymbol(recent.isError ? "status.error" : "status.success", recent.isError ? "error" : "success")} `
			: "";
	const leadWidth = visibleWidth(hook) + visibleWidth(outcome);
	// Reserve the elapsed marker first, then cap the tool name; the detail gets whatever is left.
	const shortTool = truncateToWidth(replaceTabs(tool), Math.max(0, rowWidth - leadWidth - elapsedWidth), "");
	let line = `${hook}${outcome}${theme.fg(currentTool ? "muted" : "dim", shortTool)}`;
	const detailBudget = rowWidth - leadWidth - visibleWidth(shortTool) - elapsedWidth - visibleWidth(": ");
	if (detail && detailBudget >= ACTIVITY_MIN_DETAIL_WIDTH) {
		line += `: ${theme.fg("dim", previewLine(detail, detailBudget))}`;
	}
	return `${prefix}${truncateToWidth(`${line}${elapsedLabel}`, rowWidth, "")}`;
}

/** Header: title, live counts per outcome, and on the right the wave's spend and the hub key. */
function renderHeader(
	nodes: readonly HudNode[],
	width: number,
	spinnerFrame: number,
	hubKey: string | undefined,
): string {
	const counts: Record<HudStatus, number> = { running: 0, done: 0, failed: 0, aborted: 0 };
	let cost = 0;
	for (const node of nodes) {
		counts[node.status]++;
		cost += node.session.progress?.cost ?? 0;
	}
	const parts = [`${statusGlyph("running", spinnerFrame)} ${theme.fg("accent", `${counts.running} running`)}`];
	if (counts.done > 0)
		parts.push(`${statusGlyph("done", spinnerFrame)} ${theme.fg("success", `${counts.done} done`)}`);
	if (counts.failed > 0)
		parts.push(`${statusGlyph("failed", spinnerFrame)} ${theme.fg("error", `${counts.failed} failed`)}`);
	if (counts.aborted > 0) {
		parts.push(`${statusGlyph("aborted", spinnerFrame)} ${theme.fg("warning", `${counts.aborted} aborted`)}`);
	}
	const left = `${theme.bold(theme.fg("accent", "Agents"))}  ${parts.join("  ")}`;
	// The counts are the point; the spend and hub hint yield to them on a narrow terminal.
	const extras: string[] = [];
	if (cost > 0) extras.push(theme.fg("dim", formatCost(cost)));
	if (hubKey) extras.push(`${theme.fg("muted", hubKey)} ${theme.fg("dim", "hub")}`);
	const leftWidth = visibleWidth(left);
	while (extras.length > 0 && leftWidth + 2 + visibleWidth(extras.join(theme.fg("dim", theme.sep.dot))) > width) {
		extras.pop();
	}
	return fitRow(left, extras.join(theme.fg("dim", theme.sep.dot)), width);
}

/**
 * Build one paint of the pinned agent tree. Undefined when no subagent is
 * active, so the host clears the block. Each agent owns one returned line;
 * with `livePreview` a running agent's line carries its activity row after a
 * newline, so line N still maps to `order[N - 2]` for click routing.
 */
export function buildSubagentHudView(
	sessions: readonly ObservableSession[],
	options: SubagentHudOptions,
): SubagentHudView | undefined {
	const visible = selectHudSessions(sessions);
	if (visible.length === 0) return undefined;
	const now = options.now ?? Date.now();
	const spinnerFrame = options.spinnerFrame ?? sharedSpinnerFrame(theme.spinnerFrames.length);
	// `SubagentHudComponent` paints through `Text` with horizontal padding, so
	// rows budgeted to the full terminal width would wrap.
	const width = Math.max(0, options.columns - getPaddingX(1) * 2);
	const outerIndent = " ";

	const roots = buildForest(visible);
	const all = [...preorder(roots)];
	const keep =
		options.expanded || all.length <= SUBAGENT_HUD_COLLAPSED_LIMIT
			? undefined
			: pickCollapsed(roots, SUBAGENT_HUD_COLLAPSED_LIMIT);
	const shown = (nodes: readonly HudNode[]): HudNode[] => (keep ? nodes.filter(node => keep.has(node)) : [...nodes]);

	const lines: string[] = ["", truncateToWidth(renderHeader(all, width, spinnerFrame, options.hubKey), width, "")];
	const order: string[] = [];
	const paint = (nodes: readonly HudNode[], continuation: string): void => {
		const siblings = shown(nodes);
		siblings.forEach((node, index) => {
			const isLast = index === siblings.length - 1;
			const branch = theme.fg("dim", `${getTreeBranch(isLast, theme)} `);
			const rail = `${continuation}${theme.fg("dim", getTreeContinuePrefix(isLast, theme))}`;
			const rows = [renderAgentRow(node, `${continuation}${branch}`, width, now, spinnerFrame)];
			if (options.livePreview && node.status === "running") {
				const childRail = shown(node.children).length > 0 ? theme.fg("dim", theme.tree.vertical) : " ";
				rows.push(renderActivityRow(node.session, `${rail}${childRail} `, width, now));
			}
			lines.push(rows.map(row => truncateToWidth(row, width, "")).join("\n"));
			order.push(node.session.id);
			paint(node.children, rail);
		});
	};
	paint(roots, outerIndent);

	let toggleRow: number | undefined;
	if (keep) {
		toggleRow = lines.length;
		const hidden: Record<HudStatus, number> = { running: 0, done: 0, failed: 0, aborted: 0 };
		let hiddenTotal = 0;
		for (const node of all) {
			if (keep.has(node)) continue;
			hidden[node.status]++;
			hiddenTotal++;
		}
		const breakdown = (["running", "done", "failed", "aborted"] as const)
			.filter(status => hidden[status] > 0)
			.map(status => `${hidden[status]} ${status}`)
			.join(", ");
		lines.push(
			truncateToWidth(
				`${outerIndent}${theme.fg("dim", `… ${hiddenTotal} more (${breakdown}) — expand`)}`,
				width,
				"",
			),
		);
	} else if (options.expanded && all.length > SUBAGENT_HUD_COLLAPSED_LIMIT) {
		toggleRow = lines.length;
		lines.push(truncateToWidth(`${outerIndent}${theme.fg("dim", "… show less")}`, width, ""));
	}

	// Wake on the shared spinner clock's next step, so the tree repaints in the
	// same beat as live task cards instead of on a drifting timer of its own.
	const animate = options.animate ?? true;
	const tickMs =
		animate && all.some(node => node.status === "running")
			? Math.ceil(SPINNER_ADVANCE_MS - (performance.now() % SPINNER_ADVANCE_MS))
			: undefined;
	return { lines, order, toggleRow, tickMs };
}

/**
 * Pinned agent tree block with its visible agent order, so click-to-focus can
 * map a rendered row back to its agent. Row 0 is the leading blank, row 1 the
 * header; agent rows follow in `order`; the expander row resolves to the
 * toggle sentinel, which the click router handles before any registry lookup.
 * Long rows wrap inside `Text` (content is two cells narrower than the
 * terminal), so the map is built on the first click after rendering at a new
 * width or width configuration: continuation rows belong to the agent (or
 * toggle) whose logical row started them.
 */
export class SubagentHudComponent implements Component {
	readonly #text: Text;
	#lines: readonly string[];
	#order: readonly string[];
	#toggleLine: number | undefined;
	#physicalOwner?: (string | undefined)[];
	#renderedWidth?: number;
	#renderedRows = 0;
	#renderedWidthConfigEpoch?: number;
	constructor(lines: readonly string[], order: readonly string[], toggleRow?: number) {
		this.#text = new Text(lines.join("\n"), 1, 0);
		this.#lines = lines;
		this.#order = order;
		this.#toggleLine = toggleRow;
	}

	/** Repaint in place with a new view; the click map rebuilds lazily. */
	update(lines: readonly string[], order: readonly string[], toggleRow: number | undefined): void {
		this.#order = order;
		this.#toggleLine = toggleRow;
		this.#text.setText(lines.join("\n"));
		this.#lines = lines;
		this.#physicalOwner = undefined;
	}
	render(width: number): readonly string[] {
		const rows = this.#text.render(width);
		const widthConfigEpoch = getWidthConfigEpoch();
		if (
			this.#renderedWidth !== width ||
			this.#renderedRows !== rows.length ||
			this.#renderedWidthConfigEpoch !== widthConfigEpoch
		) {
			this.#physicalOwner = undefined;
		}
		this.#renderedWidth = width;
		this.#renderedRows = rows.length;
		this.#renderedWidthConfigEpoch = widthConfigEpoch;
		return rows;
	}
	getClickAgentAtRow(row: number): string | undefined {
		if (row < 0 || row >= this.#renderedRows || this.#renderedWidth === undefined) return undefined;
		if (!this.#physicalOwner) {
			if (this.#renderedWidthConfigEpoch !== getWidthConfigEpoch()) return undefined;
			this.#rebuildHitMap(this.#renderedWidth, this.#renderedRows);
		}
		return this.#physicalOwner?.[row];
	}
	#lineOwner(index: number): string | undefined {
		if (this.#toggleLine !== undefined && index === this.#toggleLine) return PINNED_HUD_TOGGLE_ID;
		const orderIndex = index - HUD_CHROME_ROWS;
		return orderIndex >= 0 && orderIndex < this.#order.length ? this.#order[orderIndex] : undefined;
	}
	// Native wrap splits paragraphs independently, so per-line wrapped
	// heights compose exactly to the rendered row count. A length mismatch
	// means the wrap contract drifted: fall back to one row per line rather
	// than misrouting clicks.
	#rebuildHitMap(width: number, renderedRows: number): void {
		const contentWidth = Math.max(1, width - getPaddingX(1) * 2);
		const owner: (string | undefined)[] = [];
		for (let index = 0; index < this.#lines.length; index++) {
			const height = wrapTextWithAnsi(replaceTabs(this.#lines[index]!), contentWidth).length;
			const id = this.#lineOwner(index);
			for (let row = 0; row < height; row++) owner.push(id);
		}
		this.#physicalOwner =
			owner.length === renderedRows ? owner : this.#lines.map((_line, index) => this.#lineOwner(index));
	}
}
