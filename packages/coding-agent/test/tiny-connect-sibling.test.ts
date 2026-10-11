import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { connectTinyWorker, type WorkerLaunch } from "@oh-my-pi/pi-coding-agent/tiny/title-client";

/**
 * A fake worker on the unix socket `argv[1]`. It ignores the first `argv[2]`
 * pings (a worker stuck in a synchronous ONNX run), then answers with launch
 * tag `argv[3]`. A `shutdown` request makes it exit, like a real worker.
 */
const SERVER = `
import { rmSync } from "node:fs";
let pings = 0;
Bun.listen({
	unix: process.argv[1],
	socket: {
		data(socket, chunk) {
			if (String(chunk).includes("shutdown")) {
				rmSync(process.argv[1], { force: true });
				process.exit(0);
			}
			if (++pings > Number(process.argv[2])) {
				socket.write(JSON.stringify({ type: "pong", id: "probe", tag: process.argv[3] }) + "\\n");
			}
		},
	},
});
console.log("ready");
`;

const LOSER_LOG = (endpoint: string) => `omp tiny worker already listening on ${endpoint}\n`;

/**
 * Drive `connectTinyWorker` through a first spawn that loses the bind race
 * ("already listening") and exits at once, with the sibling it lost to
 * behaving per `kind`:
 * - absent: the sibling is gone; the client must spawn again.
 * - busy: the sibling holds the socket but is silent for one probe; the client
 *   must keep waiting and adopt it, not spawn again.
 * - stale: the sibling answers with another launch tag; the client must shut it
 *   down and spawn again.
 */
async function connectAfterLostRace(kind: "absent" | "busy" | "stale"): Promise<{ spawns: number }> {
	const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-tiny-${kind}-`));
	const procs: Array<{ kill(): void }> = [];
	let spawns = 0;
	/** Start a fake worker and return once it is listening, so the race is deterministic. */
	const serve = async (endpoint: string, silentPings: number, tag: string) => {
		const proc = Bun.spawn({
			cmd: [process.execPath, "-e", SERVER, endpoint, String(silentPings), tag],
			stdout: "pipe",
			stderr: "ignore",
		});
		procs.push(proc);
		await proc.stdout.getReader().read();
		return proc;
	};
	const launch: WorkerLaunch = {
		backend: "onnx",
		tag: "new",
		async spawn(endpoint, logPath) {
			spawns += 1;
			if (spawns === 1) {
				await Bun.write(logPath, LOSER_LOG(endpoint));
				if (kind === "busy") await serve(endpoint, 1, "new");
				if (kind === "stale") await serve(endpoint, 0, "old");
				const proc = Bun.spawn({ cmd: [process.execPath, "-e", ""], stdout: "ignore", stderr: "ignore" });
				await proc.exited;
				return { proc, logPath };
			}
			await Bun.write(logPath, "");
			return { proc: await serve(endpoint, 0, "new"), logPath };
		},
	};
	try {
		const handle = await connectTinyWorker(launch, "lfm2.5-230m", runtimeDir);
		await handle.terminate();
		return { spawns };
	} finally {
		for (const proc of procs) proc.kill();
		await fs.rm(runtimeDir, { recursive: true, force: true });
	}
}

describe("connectTinyWorker when the spawned worker loses the bind race", () => {
	it("respawns once the sibling that held the socket is gone", async () => {
		expect((await connectAfterLostRace("absent")).spawns).toBe(2);
	}, 30_000);

	it("keeps waiting for a sibling that is busy, then adopts it without spawning again", async () => {
		expect((await connectAfterLostRace("busy")).spawns).toBe(1);
	}, 30_000);

	it("replaces a sibling running another launch tag", async () => {
		expect((await connectAfterLostRace("stale")).spawns).toBe(2);
	}, 30_000);
});
