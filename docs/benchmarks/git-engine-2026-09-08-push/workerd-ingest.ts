/**
 * Real-repository push work on production storage: for each root, ingest the
 * honojs/hono pack into a fresh repository N times (alternating roots) and then
 * run the connectivity check a push performs. bun workerd-ingest.ts <rootA> <rootB> [samples=3]
 */
import { build } from "/home/user/open-relic/node_modules/esbuild/lib/main.js";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

/** The parser's phase timings, as createPackTimings() lays them out. */
interface PackPhases {
  readonly bodyIngressMs: number;
  readonly bodyBytes: number;
  readonly bodyChunks: number;
  readonly inflateMs: number;
  readonly hashMs: number;
  readonly deltaApplyMs: number;
  readonly storageReadMs: number;
  readonly storageWriteMs: number;
  readonly storageCommitMs: number;
  readonly linkIndexMs: number;
  readonly objects: number;
  readonly deltas: number;
  readonly recentBaseHits: number;
  readonly nativeInflates: number;
}
interface IngestReply {
  readonly objectCount: number;
  readonly totalMs: number;
  readonly timings: PackPhases;
}

const HERE = "/tmp/claude-0/-home-user-open-relic/f4a83474-0713-5f9c-9543-d6171ddca52d/scratchpad";
const TIP = "e7b38ee42bfa41f20194ad20fb949b625346be62";
const roots = [resolve(process.argv[2]!), resolve(process.argv[3] ?? process.argv[2]!)];
const samples = Number(process.argv[4] ?? 3);
const main = "/home/user/open-relic";
const temp = await mkdtemp(join(tmpdir(), "workerd-ingest-"));
const binary = join(main, "node_modules/.bin/workerd");
const ports = [
  32_000 + Math.floor(Math.random() * 1000),
  33_000 + Math.floor(Math.random() * 1000),
];
const source = await readFile(join(HERE, "worker-profile.ts"), "utf8"); // beside this file when copied
// Optional: an alternate worker source for arm B (same engine, different Worker/adapter).
const altWorker = process.argv[5];
let server: ReturnType<typeof spawn> | undefined;
let log = "";
try {
  for (let i = 0; i < roots.length; i++) {
    const src = i === 1 && altWorker ? await readFile(altWorker, "utf8") : source;
    await build({
      stdin: {
        contents: src.replaceAll("../../apps/", "./apps/"),
        resolveDir: roots[i]!,
        loader: "ts",
      },
      outfile: join(temp, `${i}.mjs`),
      bundle: true,
      format: "esm",
      platform: "browser",
      external: ["node:*", "cloudflare:*"],
      loader: { ".sql": "text" },
      nodePaths: [join(main, "node_modules")],
    });
  }
  await mkdir(join(temp, "data"));
  const services = ports.map(
    (_, i) => `(name = "engine${i}", worker = (
    modules = [(name = "worker.mjs", esModule = embed "${i}.mjs")],
    compatibilityDate = "2026-07-04", compatibilityFlags = ["nodejs_compat"],
    bindings = [(name = "REPOSITORIES", durableObjectNamespace = (className = "BenchmarkRepository"))],
    durableObjectNamespaces = [(className = "BenchmarkRepository", uniqueKey = "engine${i}", enableSql = true)],
    durableObjectStorage = (localDisk = "data")
  ))`,
  );
  await writeFile(
    join(temp, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
services = [${services.join(",")}, (name = "data", disk = (path = "${join(temp, "data")}", writable = true))],
sockets = [${ports.map((p, i) => `(name = "http${i}", address = "127.0.0.1:${p}", http = (), service = "engine${i}")`).join(",")}]
);`,
  );
  server = spawn(binary, ["serve", `-I${join(main, "node_modules")}`, join(temp, "config.capnp")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr!.on("data", (c) => {
    log += c;
  });
  server.stdout!.on("data", (c) => {
    log += c;
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${ports[0]}/`);
      break;
    } catch {
      if (server.exitCode !== null || attempt > 100) throw new Error(log);
      await Bun.sleep(100);
    }
  }
  const pack = new Uint8Array(await readFile(join(HERE, "hono-main.pack")));
  const call = async (i: number, path: string, repo: string, body: Uint8Array) => {
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:${ports[i]}${path}`, {
      method: "POST",
      headers: { "x-repository": repo },
      body,
    });
    const text = await response.text();
    const ms = performance.now() - start;
    // SAFETY: /ingest answers with readPack's summary, totalMs, and the timings object;
    // /check answers { missing }. Both are produced by worker-profile.ts beside this file.
    const json = JSON.parse(text) as IngestReply & { readonly missing?: string | null };
    if (response.headers.get("x-worker-body-bytes"))
      process.stderr.write(
        `arm ${i} worker buffered ${response.headers.get("x-worker-body-bytes")} bytes\n`,
      );
    if (response.headers.get("x-worker-rpc-calls"))
      process.stderr.write(
        `arm ${i} worker made ${response.headers.get("x-worker-rpc-calls")} rpc calls\n`,
      );
    if (!response.ok) throw new Error(`${response.status}: ${text}\n${log.slice(-4000)}`);
    return { ms, json };
  };
  const runs: { ms: number; checkMs: number; timings: PackPhases }[][] = [[], []];
  for (let s = -1; s < samples; s++) {
    for (const i of s % 2 === 0 ? [0, 1] : [1, 0]) {
      const repo = `hono-${i}-${s}`;
      const r = await call(i, "/ingest", repo, pack);
      assert.equal(r.json.objectCount, 23235);
      const c = await call(i, `/check?tip=${TIP}`, repo, new Uint8Array());
      assert.equal(c.json.missing, null);
      if (s >= 0)
        runs[i]!.push({ ms: +r.ms.toFixed(1), checkMs: +c.ms.toFixed(1), timings: r.json.timings });
    }
  }
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
  console.log(
    JSON.stringify(
      {
        runtime: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
        storage: "local disk SQLite Durable Objects",
        repository: "honojs/hono main pack, 23,235 objects",
        roots,
        ingestMs: { a: median(runs[0]!.map((r) => r.ms)), b: median(runs[1]!.map((r) => r.ms)) },
        checkMs: {
          a: median(runs[0]!.map((r) => r.checkMs)),
          b: median(runs[1]!.map((r) => r.checkMs)),
        },
        samples: { a: runs[0]!.map((r) => r.ms), b: runs[1]!.map((r) => r.ms) },
        timingsAtLastRun: { a: runs[0]!.at(-1)?.timings, b: runs[1]!.at(-1)?.timings },
      },
      null,
      2,
    ),
  );
} catch (e) {
  process.stderr.write(log.slice(-6000));
  throw e;
} finally {
  server?.kill("SIGTERM");
  if (server && server.exitCode === null) await new Promise((d) => server!.once("exit", d));
  await rm(temp, { recursive: true, force: true });
}
