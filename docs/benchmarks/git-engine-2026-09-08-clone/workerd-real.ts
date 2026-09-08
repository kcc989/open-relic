/**
 * Real-repository clone on production storage: two engines under local workerd
 * with SQLite Durable Objects, each ingesting honojs/hono main once, then serving
 * the whole clone's pack N times. bun workerd-real.ts <rootA> <rootB> [samples=5]
 */
import { build } from "/home/user/open-relic/node_modules/esbuild/lib/main.js";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

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

const HERE = "/tmp/claude-0/-home-user-open-relic/f4a83474-0713-5f9c-9543-d6171ddca52d/scratchpad";
const TIP = "e7b38ee42bfa41f20194ad20fb949b625346be62";
const roots = [resolve(process.argv[2]!), resolve(process.argv[3]!)];
const samples = Number(process.argv[4] ?? 5);
const main = "/home/user/open-relic";
// Optional: an alternate scripts/benchmarks/worker.ts for arm B (same engine, different DO adapter).
const altWorker = process.argv[5];
const { pktLine, flushPkt } = await import(`${main}/apps/api/src/git/pkt-line.ts`);
const { concat } = await import(`${main}/apps/api/test/support/pack.ts`);

const temp = await mkdtemp(join(tmpdir(), "workerd-real-"));
const binary = join(main, "node_modules/.bin/workerd");
const ports = [
  30_000 + Math.floor(Math.random() * 1000),
  31_000 + Math.floor(Math.random() * 1000),
];
const source = await readFile(join(main, "scripts/benchmarks/worker.ts"), "utf8");
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
  // A real git client negotiates side-band-64k over Smart HTTP; without it the pack
  // streams as one tiny chunk per entry, which is not what a clone looks like.
  const request = concat(pktLine(`want ${TIP} side-band-64k\n`), flushPkt(), pktLine("done\n"));
  let lastPhases: UploadPackPhases | null = null;
  const call = async (i: number, path: string, body: Uint8Array) => {
    const logAt = log.length;
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:${ports[i]}${path}`, {
      method: "POST",
      headers: { "x-repository": "hono" },
      body,
    });
    const data = new Uint8Array(await response.arrayBuffer());
    const ms = performance.now() - start;
    if (!response.ok)
      throw new Error(`${response.status}: ${new TextDecoder().decode(data)}\n${log.slice(-4000)}`);
    // workerd forwards console.log to its stdout, so the engine's own phase timings are in the log.
    const m = log.slice(logAt).match(/Git upload-pack timings (\{[^\n]*\})/);
    if (m) {
      // SAFETY: the line is written by logUploadPackTimings with exactly these keys.
      lastPhases = JSON.parse(m[1]!) as UploadPackPhases;
    }
    return { ms, data };
  };

  // Skip the NAK line, then concatenate every band-1 payload until the flush.
  const unband = (data: Uint8Array): Uint8Array => {
    const parts: Uint8Array[] = [];
    let at = 0;
    const dec = new TextDecoder();
    while (at < data.length) {
      const len = Number.parseInt(dec.decode(data.subarray(at, at + 4)), 16);
      if (len === 0) {
        at += 4;
        continue;
      }
      const payload = data.subarray(at + 4, at + len);
      at += len;
      if (payload[0] === 1) parts.push(payload.subarray(1));
      else if (payload[0] === 3)
        throw new Error(`server error: ${dec.decode(payload.subarray(1))}`);
      // band 2 is progress; a bare NAK/ACK line has no band byte and starts with "NAK"/"ACK"
    }
    return concat(...parts);
  };
  const ingest: number[] = [];
  for (const i of [0, 1]) {
    const r = await call(i, "/ingest", pack);
    ingest.push(+r.ms.toFixed(1));
    assert.equal(JSON.parse(new TextDecoder().decode(r.data)).objectCount, 23235);
  }
  const client = join(temp, "client.git");
  execFileSync("git", ["init", "--bare", "--quiet", client]);
  const runs: number[][] = [[], []];
  const phases: (UploadPackPhases | null)[] = [null, null];
  for (let s = -1; s < samples; s++) {
    for (const i of s % 2 === 0 ? [0, 1] : [1, 0]) {
      const r = await call(i, `/fetch?tip=${TIP}`, request);
      const packBytes = unband(r.data);
      assert.equal(new TextDecoder().decode(packBytes.subarray(0, 4)), "PACK");
      execFileSync("git", ["--git-dir", client, "index-pack", "--stdin", "--strict"], {
        input: packBytes,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (s >= 0) {
        runs[i]!.push(+r.ms.toFixed(1));
        phases[i] = lastPhases;
      }
    }
  }
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
  console.log(
    JSON.stringify(
      {
        runtime: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
        storage: "local disk SQLite Durable Objects",
        repository: "honojs/hono main @ e7b38ee, 23,235 objects",
        ingestMs: { a: ingest[0], b: ingest[1] },
        cloneMs: { a: median(runs[0]!), b: median(runs[1]!) },
        samples: { a: runs[0], b: runs[1] },
        phasesAtLastRun: { a: phases[0], b: phases[1] },
        roots,
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
