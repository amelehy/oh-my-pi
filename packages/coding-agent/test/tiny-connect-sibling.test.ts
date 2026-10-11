import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { connectTinyWorker, type WorkerLaunch } from "@oh-my-pi/pi-coding-agent/tiny/title-client";

const SERVER = `
Bun.listen({
	unix: process.argv[1],
	socket: {
		data(socket) {
			socket.write(JSON.stringify({ type: "pong", id: "probe", tag: "t" }) + "\\n");
		},
	},
});
`;

describe("connectTinyWorker when the spawned worker loses the bind race", () => {
	it("respawns once the sibling that held the socket is gone", async () => {
		const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tiny-sibling-"));
		const procs: Array<{ kill(): void }> = [];
		let spawns = 0;
		const launch: WorkerLaunch = {
			backend: "onnx",
			tag: "t",
			async spawn(endpoint, logPath) {
				spawns += 1;
				if (spawns === 1) {
					// Lost the bind race to a sibling that has since exited: nothing is
					// listening any more, so a plain wait would stall to the timeout.
					await Bun.write(logPath, "omp tiny worker already listening on " + endpoint + "\n");
					const proc = Bun.spawn({ cmd: [process.execPath, "-e", ""], stdout: "ignore", stderr: "ignore" });
					await proc.exited;
					return { proc, logPath };
				}
				await Bun.write(logPath, "");
				const proc = Bun.spawn({
					cmd: [process.execPath, "-e", SERVER, endpoint],
					stdout: "ignore",
					stderr: "ignore",
				});
				procs.push(proc);
				return { proc, logPath };
			},
		};
		try {
			const handle = await connectTinyWorker(launch, "lfm2.5-230m", runtimeDir);
			expect(spawns).toBe(2);
			await handle.terminate();
		} finally {
			for (const proc of procs) proc.kill();
			await fs.rm(runtimeDir, { recursive: true, force: true });
		}
	}, 30_000);
});
