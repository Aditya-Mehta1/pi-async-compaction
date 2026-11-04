// SQLite session directories and the single-process lock.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.ts";

export type SessionTarget = { kind: "new" } | { kind: "continue" } | { kind: "directory"; path: string };

/** Select and lock a session; an explicit directory reopens its database when present. */
export async function openSession(cwdInput: string, target: SessionTarget) {
	const cwd = await realpath(resolve(cwdInput));
	let directory: string;
	if (target.kind === "directory") {
		directory = resolve(target.path);
	} else {
		const root = join(
			getAgentDir(),
			"experimental",
			"durable-sessions",
			createHash("sha256").update(cwd).digest("hex").slice(0, 24),
		);
		await mkdir(root, { recursive: true });
		if (target.kind === "continue") {
			const entries = await readdir(root, { withFileTypes: true });
			const newest = entries
				.filter((entry) => entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name))
				.map((entry) => entry.name)
				.sort()
				.at(-1);
			if (!newest) throw new Error(`No Durable session exists for ${cwd}`);
			directory = join(root, newest);
		} else {
			directory = join(root, `${Date.now()}-${randomUUID()}`);
		}
	}
	await mkdir(directory, { recursive: true });
	// A crashed process leaves a lock that goes stale after ten seconds.
	const release = await lockfile.lock(directory, { retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 } });
	return { cwd, directory, database: join(directory, "session.sqlite"), release };
}
