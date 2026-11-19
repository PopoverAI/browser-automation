import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
	AgentBrowserClient,
	AgentBrowserError,
	type AgentBrowserExec,
	type AgentBrowserExecResult,
	DEFAULT_AGENT_BROWSER_COMMAND,
	defaultAgentBrowserCommand,
	parseJsonOutput,
	spawnExec,
} from "../src/agentBrowserClient.js";

const ok = (stdout: string): AgentBrowserExecResult => ({
	stdout,
	stderr: "",
	status: 0,
});

describe("parseJsonOutput", () => {
	it("parses a clean JSON payload", () => {
		expect(parseJsonOutput('{"success":true}\n')).toEqual({ success: true });
	});

	it("skips npm warnings printed above the payload", () => {
		const out =
			"npm warn EBADENGINE Unsupported engine {\nnpm warn EBADENGINE }\n" +
			'[{"command":["wait","1"],"success":true,"result":null,"error":null}]\n';
		expect(parseJsonOutput(out)).toEqual([
			{ command: ["wait", "1"], success: true, result: null, error: null },
		]);
	});

	it("returns undefined when there is no JSON at all", () => {
		expect(parseJsonOutput("✓ Closed session: default\n")).toBeUndefined();
		expect(parseJsonOutput("")).toBeUndefined();
	});
});

describe("AgentBrowserClient", () => {
	it("prepends --session to every invocation", async () => {
		const exec = vi.fn<AgentBrowserExec>(async () => ok("{}"));
		const client = new AgentBrowserClient({ session: "demo", exec });
		await client.run(["get", "url"]);
		expect(exec).toHaveBeenCalledWith(
			["--session", "demo", "get", "url"],
			expect.objectContaining({ timeoutMs: 30_000 }),
		);
	});

	it("batch sends commands as JSON on stdin with --bail and --json", async () => {
		const exec = vi.fn<AgentBrowserExec>(async () =>
			ok(
				JSON.stringify([
					{
						command: ["click", "@e1"],
						success: true,
						result: { clicked: "@e1" },
						error: null,
					},
				]),
			),
		);
		const client = new AgentBrowserClient({ exec });
		const results = await client.batch([["click", "@e1"]], { timeoutMs: 5 });
		expect(results).toHaveLength(1);
		expect(results[0].success).toBe(true);
		const [args, opts] = exec.mock.calls[0];
		expect(args).toEqual(["batch", "--bail", "--json"]);
		expect(opts?.stdin).toBe(JSON.stringify([["click", "@e1"]]));
		expect(opts?.timeoutMs).toBe(5);
	});

	it("batch keeps the client's default timeout when none is given", async () => {
		const exec = vi.fn<AgentBrowserExec>(async () => ok("[]"));
		const client = new AgentBrowserClient({ exec, timeoutMs: 4242 });
		await client.batch([["wait", "1"]]);
		expect(exec.mock.calls[0][1]?.timeoutMs).toBe(4242);
		await client.run(["get", "url"], { timeoutMs: undefined });
		expect(exec.mock.calls[1][1]?.timeoutMs).toBe(4242);
	});

	it("batch omits --bail when asked", async () => {
		const exec = vi.fn<AgentBrowserExec>(async () => ok("[]"));
		const client = new AgentBrowserClient({ exec });
		await client.batch([["wait", "1"]], { bail: false });
		expect(exec.mock.calls[0][0]).toEqual(["batch", "--json"]);
	});

	it("batch surfaces a top-level CLI error object", async () => {
		const exec = vi.fn<AgentBrowserExec>(async () =>
			ok(JSON.stringify({ success: false, error: "Chrome not found" })),
		);
		const client = new AgentBrowserClient({ exec });
		await expect(client.batch([["wait", "1"]])).rejects.toThrow(
			/Chrome not found/,
		);
	});

	it("runJson throws AgentBrowserError when stdout has no JSON", async () => {
		const exec = vi.fn<AgentBrowserExec>(async () => ({
			stdout: "",
			stderr: "boom",
			status: 1,
		}));
		const client = new AgentBrowserClient({ exec });
		await expect(client.runJson(["stream", "status"])).rejects.toBeInstanceOf(
			AgentBrowserError,
		);
	});

	it("ensureStream reuses an already-enabled stream", async () => {
		const exec = vi.fn<AgentBrowserExec>(async () =>
			ok(
				JSON.stringify({
					success: true,
					data: { enabled: true, port: 4321 },
					error: null,
				}),
			),
		);
		const client = new AgentBrowserClient({ exec });
		const s = await client.ensureStream();
		expect(s).toEqual({ url: "ws://127.0.0.1:4321/", enabledByUs: false });
		expect(exec).toHaveBeenCalledTimes(1);
	});

	it("ensureStream enables the stream when it is off and reports enabledByUs", async () => {
		let enabled = false;
		const exec = vi.fn<AgentBrowserExec>(async (args) => {
			if (args[0] === "stream" && args[1] === "status") {
				return ok(
					JSON.stringify({
						success: true,
						data: enabled ? { enabled: true, port: 9999 } : { enabled: false },
						error: null,
					}),
				);
			}
			if (args[0] === "stream" && args[1] === "enable") {
				enabled = true;
				return ok("✓ Streaming enabled\n");
			}
			throw new Error(`unexpected ${args.join(" ")}`);
		});
		const client = new AgentBrowserClient({ exec });
		const s = await client.ensureStream();
		expect(s).toEqual({ url: "ws://127.0.0.1:9999/", enabledByUs: true });
		expect(exec.mock.calls.map((c) => c[0].slice(0, 2))).toEqual([
			["stream", "status"],
			["stream", "enable"],
			["stream", "status"],
		]);
	});

	it("ensureStream fails loudly when the daemon reports no port", async () => {
		const exec = vi.fn<AgentBrowserExec>(async () =>
			ok(
				JSON.stringify({ success: true, data: { enabled: true }, error: null }),
			),
		);
		const client = new AgentBrowserClient({ exec });
		await expect(client.ensureStream()).rejects.toThrow(/no port/);
	});
});

describe("spawnExec", () => {
	it("survives a child that exits before draining stdin (EPIPE) and reports its status", async () => {
		const exec = spawnExec([process.execPath, "-e", "process.exit(3)"]);
		const r = await exec([], {
			stdin: "x".repeat(1024 * 1024),
			timeoutMs: 10_000,
		});
		expect(r.status).toBe(3);
	});

	it("rejects with a timeout error and kills a hung child", async () => {
		const exec = spawnExec([
			process.execPath,
			"-e",
			"setInterval(() => {}, 1000)",
		]);
		await expect(exec([], { stdin: "x", timeoutMs: 200 })).rejects.toThrow(
			/timed out/,
		);
	});
});

describe("defaultAgentBrowserCommand", () => {
	/** A folder with agent-browser installed in its node_modules, as npm or pnpm lays it out. */
	const withAgentBrowser = () => {
		// Resolved as Node resolves it, through the temp folder's symlink on macOS.
		const root = realpathSync(mkdtempSync(join(tmpdir(), "ab-lookup-")));
		const pkg = join(root, "node_modules", "agent-browser");
		mkdirSync(join(pkg, "bin"), { recursive: true });
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({
				name: "agent-browser",
				bin: { "agent-browser": "./bin/agent-browser.js" },
			}),
		);
		writeFileSync(join(pkg, "bin", "agent-browser.js"), "");
		return { root, script: join(pkg, "bin", "agent-browser.js") };
	};
	const empty = () => mkdtempSync(join(tmpdir(), "ab-none-"));
	const NODE = join("/opt", "node", "bin", "node");

	it("runs the project's installed agent-browser as its own script on this Node, with no npx or shell", () => {
		const project = withAgentBrowser();
		expect(
			defaultAgentBrowserCommand({
				cwd: project.root,
				from: pathToFileURL(join(empty(), "cli.js")).href,
				execPath: NODE,
			}),
		).toEqual([NODE, project.script]);
	});

	it("runs the copy installed beside the recorder when the project has none, as a global install puts them", () => {
		const beside = withAgentBrowser();
		expect(
			defaultAgentBrowserCommand({
				cwd: empty(),
				from: pathToFileURL(join(beside.root, "node_modules", "x", "cli.js"))
					.href,
				execPath: NODE,
			}),
		).toEqual([NODE, beside.script]);
	});

	it("with none installed, runs npx through npm's own script on this Node, so Windows needs no shell", () => {
		const npxCli = join(
			"/opt",
			"node",
			"bin",
			"node_modules",
			"npm",
			"bin",
			"npx-cli.js",
		);
		expect(
			defaultAgentBrowserCommand({
				cwd: empty(),
				from: pathToFileURL(join(empty(), "cli.js")).href,
				execPath: NODE,
				exists: (path) => path === npxCli,
			}),
		).toEqual([NODE, npxCli, "--yes", "agent-browser"]);
	});

	it("with neither agent-browser nor npm's script found, falls back to npx on the path", () => {
		expect(
			defaultAgentBrowserCommand({
				cwd: empty(),
				from: pathToFileURL(join(empty(), "cli.js")).href,
				execPath: NODE,
				exists: () => false,
			}),
		).toEqual(DEFAULT_AGENT_BROWSER_COMMAND);
	});
});
