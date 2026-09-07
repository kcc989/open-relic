/** bun scripts/benchmark-workerd.ts ../open-relic-baseline [samples] */
import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { blob, commit, tree, treeEntry } from "../apps/api/test/support/git-objects.ts";
import { buildPack, concat } from "../apps/api/test/support/pack.ts";
import { pktLine, flushPkt } from "../apps/api/src/git/pkt-line.ts";

const base = process.argv[2];
if (!base) throw new Error("Pass the baseline checkout path.");
const samples = Number(process.argv[3] ?? 5);
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("Samples must be positive.");
const root = resolve(import.meta.dir, "..");
const temp = await mkdtemp(join(tmpdir(), "open-relic-workerd-"));
const binary = join(root, "node_modules/.bin/workerd");
const ports = [
  28_000 + Math.floor(Math.random() * 1_000),
  29_000 + Math.floor(Math.random() * 1_000),
];
const source = await readFile(join(root, "scripts/benchmarks/worker.ts"), "utf8");
const roots = [resolve(base), root];
let server: ReturnType<typeof spawn> | undefined;
let serverLog = "";
try {
  for (let i = 0; i < roots.length; i++) {
    await build({
      stdin: {
        contents: source.replaceAll("../../apps/", "./apps/"),
        resolveDir: roots[i]!,
        loader: "ts",
      },
      outfile: join(temp, `${i}.mjs`),
      bundle: true,
      format: "esm",
      platform: "browser",
      external: ["node:*", "cloudflare:*"],
      loader: { ".sql": "text" },
      nodePaths: [join(root, "node_modules")],
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
  const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
services = [${services.join(",")}, (name = "data", disk = (path = "${join(temp, "data")}", writable = true))],
sockets = [${ports.map((port, i) => `(name = "http${i}", address = "127.0.0.1:${port}", http = (), service = "engine${i}")`).join(",")}]
);`;
  await writeFile(join(temp, "config.capnp"), config);
  server = spawn(binary, ["serve", `-I${join(root, "node_modules")}`, join(temp, "config.capnp")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr!.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  server.stdout!.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${ports[0]}/`);
      break;
    } catch {
      if (server.exitCode !== null) throw new Error(serverLog);
      if (attempt === 99) throw new Error(`workerd did not start: ${serverLog}`);
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  const pack = (objects: readonly ReturnType<typeof blob>[]) =>
    buildPack(objects.map((object) => ({ kind: "object" as const, ...object }))).bytes;
  const tiny = Array.from({ length: 10_000 }, (_, i) => blob(`small object ${i}`));
  const tinyPack = pack(tiny);
  const sourceText = await readFile(join(root, "apps/api/src/repository-store.ts"), "utf8");
  const sourcePack = pack(
    Array.from({ length: 500 }, (_, i) => blob(`${sourceText}\n// revision ${i}\n`)),
  );
  const leaves = Array.from({ length: 1_000 }, (_, i) =>
    blob(`file ${i}\n${"persistent file contents\n".repeat(30)}`),
  );
  const treeRoot = tree(leaves.map((leaf, i) => treeEntry(`file-${i}`, leaf)));
  const first = commit({ tree: treeRoot, message: "Initial snapshot" });
  const empty = commit({ tree: treeRoot, parents: [first], message: "Empty commit" });
  const revised = blob("one changed file\n");
  const changedTree = tree([
    treeEntry("file-0", revised),
    ...leaves.slice(1).map((leaf, i) => treeEntry(`file-${i + 1}`, leaf)),
  ]);
  const update = commit({ tree: changedTree, parents: [first], message: "One changed file" });
  const history = [first];
  for (let i = 0; i < 500; i++)
    history.push(commit({ tree: treeRoot, parents: [history.at(-1)!], message: `History ${i}` }));
  const fixture = pack([...leaves, treeRoot, ...history, empty, revised, changedTree, update]);
  const gitRepos = [join(temp, "baseline.git"), join(temp, "updated.git")];
  for (const repo of gitRepos) execFileSync("git", ["init", "--bare", "--quiet", repo]);
  const request = (tip: string, have: string | null) =>
    concat(
      pktLine(`want ${tip}\n`),
      flushPkt(),
      ...(have ? [pktLine(`have ${have}\n`)] : []),
      pktLine("done\n"),
    );
  const call = async (i: number, path: string, repo: string, body?: Uint8Array) => {
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:${ports[i]}${path}`, {
      method: "POST",
      headers: { "x-repository": repo },
      body: body === undefined ? null : new Uint8Array(body),
    });
    const data = new Uint8Array(await response.arrayBuffer());
    const ms = performance.now() - start;
    if (!response.ok)
      throw new Error(
        `${response.status}: ${new TextDecoder().decode(data)}\n${serverLog.slice(-6000)}`,
      );
    return { ms, data };
  };
  for (const i of [0, 1]) await call(i, "/ingest", "fixture", fixture);
  const workloads = [
    { name: "parse-small", path: "/parse", body: tinyPack, newStore: false },
    { name: "parse-source", path: "/parse", body: sourcePack, newStore: false },
    { name: "ingest-small", path: "/ingest", body: tinyPack, newStore: true },
    {
      name: "clone-1000-files",
      path: `/fetch?tip=${first.oid}`,
      body: request(first.oid, null),
      newStore: false,
    },
    {
      name: "fetch-empty-commit",
      path: `/fetch?tip=${empty.oid}`,
      body: request(empty.oid, first.oid),
      newStore: false,
    },
    {
      name: "fetch-one-file",
      path: `/fetch?tip=${update.oid}`,
      body: request(update.oid, first.oid),
      newStore: false,
    },
    {
      name: "connectivity-500-commits",
      path: `/check?tip=${history.at(-1)!.oid}`,
      body: new Uint8Array(),
      newStore: false,
    },
  ];
  const results = [];
  for (const workload of workloads) {
    process.stderr.write(`Benchmarking workerd ${workload.name}\n`);
    const runs: Array<Array<{ ms: number; bytes: number; objects: number | null }>> = [[], []];
    for (let sample = -1; sample < samples; sample++) {
      for (const i of sample % 2 === 0 ? [0, 1] : [1, 0]) {
        const repo = workload.newStore ? `ingest-${sample}` : "fixture";
        const result = await call(i, workload.path, repo, workload.body);
        let objects: number | null = null;
        if (workload.path.startsWith("/fetch")) {
          const prefix = Number.parseInt(new TextDecoder().decode(result.data.subarray(0, 4)), 16);
          assert.equal(new TextDecoder().decode(result.data.subarray(prefix, prefix + 4)), "PACK");
          objects = new DataView(result.data.buffer, result.data.byteOffset + prefix).getUint32(8);
          execFileSync("git", ["--git-dir", gitRepos[i]!, "index-pack", "--stdin", "--strict"], {
            input: result.data.subarray(prefix),
            stdio: ["pipe", "pipe", "pipe"],
          });
        } else {
          const json = JSON.parse(new TextDecoder().decode(result.data));
          if (workload.path.startsWith("/check")) assert.equal(json.missing, null);
          else assert.equal(json.objectCount, workload.name.includes("source") ? 500 : 10_000);
        }
        if (sample >= 0) runs[i]!.push({ ms: result.ms, bytes: result.data.length, objects });
      }
    }
    const median = (rows: (typeof runs)[number]) =>
      [...rows].sort((a, b) => a.ms - b.ms)[Math.floor(rows.length / 2)]!;
    results.push({
      workload: workload.name,
      baseline: median(runs[0]!),
      updated: median(runs[1]!),
      samples: runs,
    });
  }
  for (const repo of gitRepos)
    execFileSync("git", ["--git-dir", repo, "fsck", "--full"], { stdio: "pipe" });
  process.stdout.write(
    JSON.stringify(
      {
        runtime: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
        storage: "local disk SQLite Durable Objects",
        integrity: "git index-pack --strict on each fetched pack; git fsck --full on each client",
        samples,
        warmups: 1,
        order: "alternating",
        results,
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  process.stderr.write(serverLog.slice(-8000));
  throw error;
} finally {
  server?.kill("SIGTERM");
  if (server && server.exitCode === null) await new Promise((done) => server!.once("exit", done));
  await rm(temp, { recursive: true, force: true });
}
