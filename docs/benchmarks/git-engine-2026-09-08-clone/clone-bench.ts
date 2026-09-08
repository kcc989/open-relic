/**
 * Clone benchmark: bun clone-bench.ts <checkout-root> [clones=7] [--fresh]
 *
 * Pushes honojs/hono main into a fresh app once, then clones it N times with a
 * real git client, each into a fresh directory. Reports median wall time and the
 * server's own upload-pack phase timings for the median run.
 *
 * --fresh: push into a brand-new app before every clone (authoritative mode —
 * defeats any cross-clone state, at the cost of a ~4s push per sample).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const SOURCE =
  "/tmp/claude-0/-home-user-open-relic/f4a83474-0713-5f9c-9543-d6171ddca52d/scratchpad/src.git";
const EXPECTED = "e7b38ee42bfa41f20194ad20fb949b625346be62";

const root = resolve(process.argv[2] ?? "/home/user/open-relic");
const clones = Number(process.argv[3] ?? 7);
const fresh = process.argv.includes("--fresh");
const app = await import(pathToFileURL(`${root}/apps/api/test/support/app.ts`).href);

const git = async (args: readonly string[]): Promise<void> => {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err.slice(0, 300)}`);
};

/** One `Git upload-pack timings` log line, as logUploadPackTimings writes it. */
interface UploadPackPhases {
  readonly totalMs: number;
  readonly requestMs: number;
  readonly negotiationMs: number;
  readonly packPlanningMs: number;
  readonly storageReadMs: number;
  readonly deflateMs: number;
  readonly hashMs: number;
  readonly firstByteMs: number | null;
  readonly responseBytes: number;
  readonly objects: number;
}

/** The route's own summary line, beside the phases. */
interface RouteTimings {
  readonly totalMs: number;
  readonly resolveMs: number;
  readonly repositoryMs: number;
}

let lastTimings: UploadPackPhases | null = null;
let lastRoute: RouteTimings | null = null;
const realLog = console.log;
console.log = (...args: unknown[]) => {
  const line = String(args[0] ?? "");
  const m = line.match(/^Git upload-pack timings (\{.*\})$/);
  if (m) {
    // SAFETY: the line is written by logUploadPackTimings with exactly these keys.
    lastTimings = JSON.parse(m[1]!) as UploadPackPhases;
  }
  const r = line.match(/^Git upload-pack route timings (\{.*\})$/);
  if (r) {
    // SAFETY: the route logs these three numbers and nothing the harness reads.
    lastRoute = JSON.parse(r[1]!) as RouteTimings;
  }
};
console.error = () => {};

interface Server {
  harness: any;
  server: ReturnType<typeof Bun.serve>;
  remote: string;
}
const start = async (): Promise<Server> => {
  const harness = await app.createGitTestApp();
  const server = Bun.serve({
    port: 0,
    idleTimeout: 120,
    fetch: (r: Request) => harness.app.fetch(r),
  });
  const remote = `http://x:${encodeURIComponent(harness.repositoryToken)}@127.0.0.1:${server.port}/git/acme/demo.git`;
  await git(["-C", SOURCE, "push", "--quiet", remote, "main:refs/heads/main"]);
  return { harness, server, remote };
};
const stop = (s: Server) => {
  s.server.stop(true);
  s.harness.close();
};

const cloneOnce = async (
  s: Server,
): Promise<{ ms: number; timings: UploadPackPhases | null; route: RouteTimings | null }> => {
  const dir = await mkdtemp(join(tmpdir(), "clone-bench-"));
  try {
    lastTimings = null;
    lastRoute = null;
    const t = performance.now();
    await git(["-c", "protocol.version=2", "clone", "--quiet", s.remote, join(dir, "co")]);
    const ms = performance.now() - t;
    const head = execFileSync("git", ["-C", join(dir, "co"), "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    assert.equal(head, EXPECTED, `clone checked out ${head}`);
    return { ms, timings: lastTimings, route: lastRoute };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const results: { ms: number; timings: UploadPackPhases | null; route: RouteTimings | null }[] = [];
let shared: Server | null = fresh ? null : await start();
try {
  if (shared) await cloneOnce(shared); // warmup
  for (let i = 0; i < clones; i++) {
    const s = shared ?? (await start());
    Bun.gc(true);
    try {
      results.push(await cloneOnce(s));
    } finally {
      if (!shared) stop(s);
    }
  }
  // Every run asserted HEAD; one full fsck confirms the pack is well-formed too.
  {
    const s = shared ?? (await start());
    const dir = await mkdtemp(join(tmpdir(), "clone-fsck-"));
    try {
      await git(["clone", "--quiet", s.remote, join(dir, "co")]);
      execFileSync("git", ["-C", join(dir, "co"), "fsck", "--full", "--no-progress"], {
        stdio: "pipe",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
      if (!shared) stop(s);
    }
  }
} finally {
  if (shared) stop(shared);
}

const sorted = [...results].sort((a, b) => a.ms - b.ms);
const med = sorted[Math.floor(sorted.length / 2)]!;
realLog(
  JSON.stringify(
    {
      root,
      mode: fresh ? "fresh-push-per-clone" : "push-once-clone-many",
      clones,
      medianMs: +med.ms.toFixed(1),
      minMs: +sorted[0]!.ms.toFixed(1),
      maxMs: +sorted.at(-1)!.ms.toFixed(1),
      samples: results.map((r) => +r.ms.toFixed(1)),
      serverTimingsAtMedian: med.timings,
      routeTimingsAtMedian: med.route,
    },
    null,
    2,
  ),
);
