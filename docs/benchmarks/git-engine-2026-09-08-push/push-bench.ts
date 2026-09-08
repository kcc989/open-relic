/**
 * Push benchmark: bun push-bench.ts <checkout-root> [pushes=5]
 *
 * Pushes honojs/hono main into a brand-new app with a real git client, N times,
 * each into a fresh application (a first-time push has nothing to reuse). Reports
 * median wall time and the server's receive-pack phase timings at the median run.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const SOURCE =
  "/tmp/claude-0/-home-user-open-relic/f4a83474-0713-5f9c-9543-d6171ddca52d/scratchpad/src.git";
const EXPECTED = "e7b38ee42bfa41f20194ad20fb949b625346be62";

const root = resolve(process.argv[2] ?? "/home/user/open-relic");
const pushes = Number(process.argv[3] ?? 5);
const app = await import(pathToFileURL(`${root}/apps/api/test/support/app.ts`).href);

/** One `Git receive-pack timings` log line, as receive-pack writes it. */
interface ReceivePackPhases {
  readonly totalMs: number;
  readonly gateWaitMs: number;
  readonly commandsMs: number;
  readonly refsMs: number;
  readonly unpackMs: number;
  readonly bodyIngressMs: number;
  readonly inflateMs: number;
  readonly hashMs: number;
  readonly deltaApplyMs: number;
  readonly storageReadMs: number;
  readonly storageWriteMs: number;
  readonly storageCommitMs: number;
  readonly linkIndexMs: number;
  readonly verifyMs: number;
  readonly refUpdateMs: number;
  readonly responseMs: number;
  readonly bodyBytes: number;
  readonly objects: number;
  readonly deltas: number;
  readonly recentBaseHits: number;
  readonly nativeInflates?: number;
}
interface RouteTimings {
  readonly totalMs: number;
  readonly resolveMs: number;
  readonly repositoryMs: number;
}

// Always async: a synchronous git call that talks to the in-process server deadlocks it.
const git = async (args: readonly string[]): Promise<string> => {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err.slice(0, 300)}`);
  return out;
};

let lastPhases: ReceivePackPhases | null = null;
let lastRoute: RouteTimings | null = null;
const realLog = console.log;
console.log = (...args: unknown[]) => {
  const line = String(args[0] ?? "");
  const m = line.match(/^Git receive-pack timings (\{.*\})$/);
  if (m) {
    // SAFETY: the line is written by receive-pack with exactly these keys.
    lastPhases = JSON.parse(m[1]!) as ReceivePackPhases;
  }
  const r = line.match(/^Git receive-pack route timings (\{.*\})$/);
  if (r) {
    // SAFETY: the route logs these numbers and nothing the harness reads.
    lastRoute = JSON.parse(r[1]!) as RouteTimings;
  }
};
console.error = () => {};

const pushOnce = async (): Promise<{
  ms: number;
  phases: ReceivePackPhases | null;
  route: RouteTimings | null;
}> => {
  const harness = await app.createGitTestApp();
  const server = Bun.serve({
    port: 0,
    idleTimeout: 120,
    fetch: (r: Request) => harness.app.fetch(r),
  });
  const remote = `http://x:${encodeURIComponent(harness.repositoryToken)}@127.0.0.1:${server.port}/git/acme/demo.git`;
  try {
    lastPhases = null;
    lastRoute = null;
    const t = performance.now();
    await git(["-C", SOURCE, "push", "--quiet", remote, "main:refs/heads/main"]);
    const ms = performance.now() - t;
    const head = (await git(["ls-remote", remote, "refs/heads/main"])).split(/\s/)[0];
    assert.equal(head, EXPECTED, `remote main is ${head}`);
    return { ms, phases: lastPhases, route: lastRoute };
  } finally {
    server.stop(true);
    harness.close();
  }
};

await pushOnce(); // warmup
const results = [];
for (let i = 0; i < pushes; i++) {
  Bun.gc(true);
  results.push(await pushOnce());
}
const sorted = [...results].sort((a, b) => a.ms - b.ms);
const med = sorted[Math.floor(sorted.length / 2)]!;
realLog(
  JSON.stringify(
    {
      root,
      pushes,
      medianMs: +med.ms.toFixed(1),
      minMs: +sorted[0]!.ms.toFixed(1),
      maxMs: +sorted.at(-1)!.ms.toFixed(1),
      samples: results.map((r) => +r.ms.toFixed(1)),
      serverPhasesAtMedian: med.phases,
      routeTimingsAtMedian: med.route,
    },
    null,
    2,
  ),
);
