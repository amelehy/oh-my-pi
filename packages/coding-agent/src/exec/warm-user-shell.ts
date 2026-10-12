import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import { quotePosixArgument } from "../utils/shell-quote";

/**
 * A long-lived interactive shell on a headless PTY.
 *
 * Spawning `zsh -l -i -c <cmd>` for every `!` command re-runs the user's whole
 * rc chain (pyenv, nvm, compinit, ...), which costs seconds. Instead one
 * interactive shell is started once, kept idle, and each command is typed into
 * its stdin exactly like a person at a terminal — aliases, functions and PATH
 * are already loaded, so a command starts as fast as it would in a real
 * terminal.
 *
 * Commands are NOT typed verbatim. Raw typing would hit line-editor features
 * (tab completion, `!` history expansion, multi-line editing). The command body
 * goes to a temp file and only a short `source <file>` line is typed. That line
 * is wrapped in OSC markers that frame the command's output, so the line-editor
 * echo before it and the prompt redraw after it never reach the caller, and the
 * exit status travels in the closing marker.
 */

/** Shells whose line editor, `source`, `printf` and `$?` behave as the framing line expects. */
export function supportsWarmUserShell(shellBasename: string): boolean {
	return shellBasename.includes("zsh");
}

export interface WarmUserShellSpec {
	shell: string;
	/** Interactive launch args with no command argument (e.g. `-l -i`). */
	args: string[];
	env: Record<string, string>;
	/** Directory the shell is spawned in; every run `cd`s explicitly anyway. */
	cwd: string | undefined;
	/**
	 * Identity of everything that is baked into the shell's state but not covered by
	 * `env`/`args` (the direnv `unset -v` prelude). A different scope gets its own shell.
	 */
	scope: string;
}

export interface WarmUserShellRun {
	command: string;
	cwd: string | undefined;
	cols: number;
	rows: number;
	/** Raw PTY bytes of the command's output (ANSI intact). */
	onOutput: (chunk: string) => void;
	/** Deadline from the start of the run, warm-up wait included. Undefined = none. */
	timeoutMs: number | undefined;
	signal: AbortSignal | undefined;
}

const MAX_WARM_SHELLS = 2;
/** After Ctrl-C, how long the shell gets to print the resync marker before it is killed. */
const INTERRUPT_RECOVERY_MS = 3_000;
/** Pause between Ctrl-C and the resync line so the tty has delivered SIGINT first. */
const INTERRUPT_SETTLE_MS = 150;
/** How long a round waits for the resync marker before Ctrl-C is sent again. */
const INTERRUPT_ROUND_MS = 350;

const ESC = "\x1b";
const BEL = "\x07";
const MARKER_PREFIX = `${ESC}]777;omp:`;

type Outcome =
	| { kind: "done"; exitCode: number | undefined }
	| { kind: "synced" }
	| { kind: "exited"; exitCode: number | undefined };

interface Operation {
	begin: string;
	endPrefix: string;
	sync: string;
	started: boolean;
	onOutput: (chunk: string) => void;
	settle: (outcome: Outcome) => void;
}

/** Escape a marker so `printf` in the shell emits the exact bytes. */
function printfLiteral(marker: string): string {
	return marker.replaceAll(ESC, "\\033").replaceAll(BEL, "\\007");
}

/** Trailing bytes of `buf` that could still grow into one of `markers`; they must not be emitted yet. */
function partialMarkerLength(buf: string, markers: readonly string[]): number {
	const esc = buf.lastIndexOf(ESC);
	if (esc < 0) return 0;
	const tail = buf.slice(esc);
	return markers.some(marker => marker.length > tail.length && marker.startsWith(tail)) ? tail.length : 0;
}

let cmdDirPromise: Promise<string> | undefined;

function commandDir(): Promise<string> {
	cmdDirPromise ??= (async () => {
		const uid = process.getuid?.();
		const dir = path.join(os.tmpdir(), uid === undefined ? "omp-warm-shell" : `omp-warm-shell-${uid}`);
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		return dir;
	})();
	return cmdDirPromise;
}

export class WarmUserShell {
	readonly key: string;
	#pty = new PtySession();
	#nonce = Math.random().toString(36).slice(2, 10);
	#seq = 0;
	#readyMarker: string;
	#readySeen = false;
	#ready = Promise.withResolvers<boolean>();
	#buf = "";
	#op: Operation | undefined;
	#tail: Promise<unknown> = Promise.resolve();
	#dead = false;
	#exit = Promise.withResolvers<void>();

	constructor(spec: WarmUserShellSpec, key: string) {
		this.key = key;
		this.#readyMarker = `${MARKER_PREFIX}${this.#nonce}:ready${BEL}`;
		void this.#pty
			.startArgv({ application: spec.shell, args: spec.args, cwd: spec.cwd, env: spec.env }, (err, chunk) => {
				if (!err && chunk) this.#consume(chunk);
			})
			.then(
				result => this.#onExit(result.exitCode),
				error => {
					logger.warn("Warm user shell failed to start", { shell: spec.shell, error: String(error) });
					this.#onExit(undefined);
				},
			);
		// Typed ahead of the rc chain finishing: the tty buffers it until the line editor starts.
		this.#write(` HISTFILE=/dev/null; SAVEHIST=0; printf '${printfLiteral(this.#readyMarker)}'\n`);
	}

	get dead(): boolean {
		return this.#dead;
	}

	/** Resolves true once the rc chain finished and the shell is at a prompt, false if it died first. */
	get ready(): Promise<boolean> {
		return this.#ready.promise;
	}

	/** Resolves when the shell process is gone. */
	get exited(): Promise<void> {
		return this.#exit.promise;
	}

	kill(): void {
		try {
			this.#pty.kill();
		} catch {
			// Already gone.
		}
	}

	/**
	 * Run one command. Returns `undefined` when the shell never became usable, so the caller can
	 * fall back to a one-shot shell. Runs on one shell are serialized.
	 */
	run(run: WarmUserShellRun): Promise<PtyRunResult | undefined> {
		const result = this.#tail.then(() => this.#execute(run));
		this.#tail = result.catch(() => undefined);
		return result;
	}

	#write(data: string): void {
		try {
			this.#pty.write(data);
		} catch {
			// The shell exited between the check and the write; #onExit settles any waiter.
		}
	}

	#onExit(exitCode: number | undefined): void {
		if (this.#dead) return;
		this.#dead = true;
		this.#ready.resolve(false);
		this.#exit.resolve();
		const op = this.#op;
		this.#op = undefined;
		op?.settle({ kind: "exited", exitCode });
	}

	#consume(chunk: string): void {
		this.#buf += chunk;
		for (;;) {
			if (!this.#readySeen) {
				const at = this.#buf.indexOf(this.#readyMarker);
				if (at < 0) {
					this.#buf = this.#buf.slice(this.#buf.length - partialMarkerLength(this.#buf, [this.#readyMarker]));
					return;
				}
				this.#buf = this.#buf.slice(at + this.#readyMarker.length);
				this.#readySeen = true;
				this.#ready.resolve(true);
				continue;
			}
			const op = this.#op;
			if (!op) {
				// Idle: prompt redraws, title sequences, hook output.
				this.#buf = "";
				return;
			}
			const markers = op.started ? [op.endPrefix, op.sync] : [op.begin, op.sync];
			let at = -1;
			let hit = "";
			for (const marker of markers) {
				const found = this.#buf.indexOf(marker);
				if (found >= 0 && (at < 0 || found < at)) {
					at = found;
					hit = marker;
				}
			}
			if (at < 0) {
				const hold = partialMarkerLength(this.#buf, markers);
				const safe = this.#buf.length - hold;
				if (op.started) {
					if (safe > 0) op.onOutput(this.#buf.slice(0, safe));
					this.#buf = this.#buf.slice(safe);
				} else {
					this.#buf = this.#buf.slice(safe);
				}
				return;
			}
			if (hit === op.begin) {
				this.#buf = this.#buf.slice(at + hit.length);
				op.started = true;
				continue;
			}
			if (op.started && at > 0) op.onOutput(this.#buf.slice(0, at));
			if (hit === op.sync) {
				this.#op = undefined;
				this.#buf = "";
				op.settle({ kind: "synced" });
				return;
			}
			// End marker carries the exit status up to BEL, which may still be in flight.
			const rest = this.#buf.slice(at + hit.length);
			const bel = rest.indexOf(BEL);
			if (bel < 0) {
				this.#buf = this.#buf.slice(at);
				return;
			}
			const code = Number.parseInt(rest.slice(0, bel), 10);
			this.#op = undefined;
			this.#buf = "";
			op.settle({ kind: "done", exitCode: Number.isNaN(code) ? undefined : code });
			return;
		}
	}

	async #execute(run: WarmUserShellRun): Promise<PtyRunResult | undefined> {
		if (this.#dead) return undefined;

		let cancelReason: "abort" | "timeout" | undefined;
		const cancelled = Promise.withResolvers<void>();
		const cancel = (reason: "abort" | "timeout"): void => {
			cancelReason ??= reason;
			cancelled.resolve();
		};
		const onAbort = (): void => cancel("abort");
		if (run.signal?.aborted) onAbort();
		run.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = run.timeoutMs === undefined ? undefined : setTimeout(() => cancel("timeout"), run.timeoutMs);
		const cancelledResult = (): PtyRunResult => ({
			exitCode: undefined,
			cancelled: cancelReason === "abort",
			timedOut: cancelReason === "timeout",
		});

		let scriptPath: string | undefined;
		try {
			const usable = await Promise.race([this.#ready.promise, cancelled.promise.then(() => undefined)]);
			if (usable === undefined) return cancelledResult();
			if (!usable) return undefined;

			const id = `${this.#nonce}:${++this.#seq}`;
			const begin = `${MARKER_PREFIX}${id}:B${BEL}`;
			const endPrefix = `${MARKER_PREFIX}${id}:E:`;
			const sync = `${MARKER_PREFIX}${id}:S${BEL}`;
			const settled = Promise.withResolvers<Outcome>();
			const op: Operation = {
				begin,
				endPrefix,
				sync,
				started: false,
				onOutput: run.onOutput,
				settle: settled.resolve,
			};

			scriptPath = path.join(await commandDir(), `cmd-${id.replace(":", "-")}.zsh`);
			const body =
				run.cwd === undefined
					? run.command
					: `builtin cd -- ${quotePosixArgument(run.cwd)} || return 1\n${run.command}`;
			await Bun.write(scriptPath, `${body}\n`, { mode: 0o600 });
			if (this.#dead) return undefined;
			if (cancelReason) return cancelledResult();

			try {
				this.#pty.resize(run.cols, run.rows);
			} catch {
				// A dead PTY is reported through #onExit.
			}
			this.#op = op;
			this.#buf = "";
			this.#write(
				` printf '${printfLiteral(begin)}'; builtin source ${quotePosixArgument(scriptPath)}; printf '${printfLiteral(endPrefix)}%s${printfLiteral(BEL)}' "$?"\n`,
			);

			let outcome = await Promise.race([settled.promise, cancelled.promise.then(() => undefined)]);
			if (outcome === undefined) {
				void this.#interrupt(op, settled.promise);
				outcome = await settled.promise;
				return cancelledResult();
			}
			if (outcome.kind === "synced") return cancelledResult();
			return { exitCode: outcome.exitCode, cancelled: false, timedOut: false };
		} finally {
			clearTimeout(timer);
			run.signal?.removeEventListener("abort", onAbort);
			if (scriptPath) void fs.rm(scriptPath, { force: true });
		}
	}

	/**
	 * Ctrl-C the running command and resync on a marker. One Ctrl-C is not enough: if it lands
	 * between the shell deciding to fork a child and the child taking the foreground, only the
	 * shell sees SIGINT and the child keeps running; and the tty drops buffered input on every
	 * INTR, so the resync line must be re-typed after each. Rounds repeat until the marker arrives
	 * or the budget is spent, then a still-wedged shell is killed.
	 */
	async #interrupt(op: Operation, settled: Promise<unknown>): Promise<void> {
		// Everything after Ctrl-C is the shell redrawing its prompt and echoing our resync line.
		op.onOutput = () => undefined;
		const deadline = Date.now() + INTERRUPT_RECOVERY_MS;
		while (this.#op === op && Date.now() < deadline) {
			this.#write("\x03");
			await Bun.sleep(INTERRUPT_SETTLE_MS);
			if (this.#op !== op) return;
			this.#write(` printf '${printfLiteral(op.sync)}'\n`);
			await Promise.race([settled, Bun.sleep(INTERRUPT_ROUND_MS)]);
		}
		if (this.#op === op) this.kill();
	}
}

const pool = new Map<string, WarmUserShell>();
let cleanupRegistered = false;

function poolKey(spec: WarmUserShellSpec): string {
	const env = Object.entries(spec.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return Bun.hash(JSON.stringify([spec.shell, spec.args, env, spec.scope])).toString(36);
}

/** The warm shell for `spec`, spawning it (and evicting the least recently used) when absent. */
export function acquireWarmUserShell(spec: WarmUserShellSpec): WarmUserShell {
	const key = poolKey(spec);
	const existing = pool.get(key);
	if (existing && !existing.dead) {
		// Re-insert so Map order tracks recency.
		pool.delete(key);
		pool.set(key, existing);
		return existing;
	}
	if (!cleanupRegistered) {
		cleanupRegistered = true;
		postmortem.register("warm-user-shell", () => disposeWarmUserShells(), { exitOnly: true });
	}
	const shell = new WarmUserShell(spec, key);
	pool.set(key, shell);
	void shell.exited.then(() => {
		if (pool.get(key) === shell) pool.delete(key);
	});
	while (pool.size > MAX_WARM_SHELLS) {
		const oldest = pool.keys().next().value;
		if (oldest === undefined) break;
		pool.get(oldest)?.kill();
		pool.delete(oldest);
	}
	return shell;
}

export function disposeWarmUserShells(): void {
	for (const shell of pool.values()) shell.kill();
	pool.clear();
}
