/** Run with Bun: bun scripts/benchmark-git-engine.ts ../open-relic-baseline [samples]. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpus, platform, arch } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { blob, commit, tree, treeEntry } from "../apps/api/test/support/git-objects.ts";
import { buildPack, streamOf, concat } from "../apps/api/test/support/pack.ts";
import { pktLine, flushPkt } from "../apps/api/src/git/pkt-line.ts";
import type { PackObject } from "../apps/api/src/pack.ts";

const baseline = process.argv[2];
if (!baseline) throw new Error("Pass the baseline checkout path.");
const samples = Number(process.argv[3] ?? 5);
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("Samples must be positive.");
const roots = [resolve(baseline), resolve(import.meta.dir, "..")];
const engines = await Promise.all(
  roots.map(async (root) => ({
    root,
    parser: await import(pathToFileURL(`${root}/apps/api/src/pack.ts`).href),
    store: await import(pathToFileURL(`${root}/apps/api/src/object-store.ts`).href),
    database: await import(pathToFileURL(`${root}/apps/api/test/support/database.ts`).href),
    connectivity: await import(pathToFileURL(`${root}/apps/api/src/connectivity.ts`).href),
    upload: await import(pathToFileURL(`${root}/apps/api/src/git/upload-pack.ts`).href),
  })),
);
type Engine = (typeof engines)[number];
interface Measurement {
  ms: number;
  objects: number;
  bytes: number;
  queries: number;
  transactions: number;
}
interface Workload {
  name: string;
  run: (engine: Engine) => Promise<Measurement>;
}
const workloads: Workload[] = [];
const tiny = Array.from({ length: 10_000 }, (_, i) => blob(`small object ${i}`));
const sourceText = await Bun.file(
  new URL("../apps/api/src/repository-store.ts", import.meta.url),
).text();
const source = Array.from({ length: 500 }, (_, i) => blob(`${sourceText}\n// revision ${i}\n`));
const packed = (objects: readonly ReturnType<typeof blob>[]) =>
  buildPack(objects.map((object) => ({ kind: "object" as const, ...object }))).bytes;
for (const [name, objects, chunkSize] of [
  ["parse-small-64k", tiny, 65_536],
  ["parse-small-1m", tiny, 1_048_576],
  ["parse-source-64k", source, 65_536],
] as const) {
  const pack = packed(objects);
  workloads.push({
    name,
    run: async (engine) => {
      let count = 0;
      const start = performance.now();
      await engine.parser.readPack(streamOf(pack, { chunkSize }), {
        read: async () => null,
        write: async (object: PackObject) => {
          assert.equal(object.oid, objects[count]!.oid);
          count += 1;
        },
      });
      return {
        ms: performance.now() - start,
        objects: count,
        bytes: pack.length,
        queries: 0,
        transactions: 0,
      };
    },
  });
}
const ingestPack = packed(tiny);
workloads.push({
  name: "ingest-small-sqlite",
  run: async (engine) => {
    let queries = 0;
    let transactions = 0;
    const opened = engine.database.createTestRepositoryStorage({
      onQuery: () => {
        queries += 1;
      },
    });
    const transaction = opened.db.transaction.bind(opened.db);
    opened.db.transaction = (...args: Parameters<typeof transaction>) => {
      transactions += 1;
      return transaction(...args);
    };
    const store = new engine.store.ObjectStore(opened.db, opened.kv);
    queries = 0;
    const start = performance.now();
    try {
      const result = await engine.parser.readPack(streamOf(ingestPack), store);
      const ms = performance.now() - start;
      const measuredQueries = queries;
      for (const leaf of [tiny[0]!, tiny.at(-1)!])
        assert.deepEqual((await store.read(leaf.oid)).bytes, leaf.bytes);
      return {
        ms,
        objects: result.objectCount,
        bytes: ingestPack.length,
        queries: measuredQueries,
        transactions,
      };
    } finally {
      opened.close();
    }
  },
});
const leaves = Array.from({ length: 1_000 }, (_, i) =>
  blob(`file ${i}\n${"persistent file contents\n".repeat(30)}`),
);
const root = tree(leaves.map((leaf, i) => treeEntry(`file-${i}`, leaf)));
const first = commit({ tree: root, message: "Initial snapshot" });
const empty = commit({ tree: root, parents: [first], message: "Empty commit" });
const changed = blob("one changed file\n");
const changedRoot = tree([
  treeEntry("file-0", changed),
  ...leaves.slice(1).map((leaf, i) => treeEntry(`file-${i + 1}`, leaf)),
]);
const update = commit({ tree: changedRoot, parents: [first], message: "One changed file" });
const history = [first];
for (let i = 0; i < 500; i++)
  history.push(commit({ tree: root, parents: [history.at(-1)!], message: `History ${i}` }));
const fixturePack = packed([...leaves, root, ...history, empty, changed, changedRoot, update]);
for (const [name, tip, have] of [
  ["clone-1000-files", first, null],
  ["fetch-empty-commit", empty, first],
  ["fetch-one-file", update, first],
] as const) {
  workloads.push({
    name,
    run: async (engine) => {
      let queries = 0;
      const opened = engine.database.createTestRepositoryStorage({
        onQuery: () => {
          queries += 1;
        },
      });
      try {
        const store = new engine.store.ObjectStore(opened.db, opened.kv);
        await engine.parser.readPack(streamOf(fixturePack), store);
        const request = concat(
          pktLine(`want ${tip.oid}\n`),
          flushPkt(),
          ...(have ? [pktLine(`have ${have.oid}\n`)] : []),
          pktLine("done\n"),
        );
        queries = 0;
        const start = performance.now();
        const response = new Uint8Array(
          await new Response(
            engine.upload.uploadPackResultStream(streamOf(request), store, new Set([tip.oid])),
          ).arrayBuffer(),
        );
        const ms = performance.now() - start;
        const measuredQueries = queries;
        const prefix = Number.parseInt(new TextDecoder().decode(response.subarray(0, 4)), 16);
        const received = new Map<string, PackObject>();
        await engine.parser.readPack(streamOf(response.subarray(prefix)), {
          read: (oid: string) => store.read(oid),
          write: async (object: PackObject) => {
            received.set(object.oid, object);
          },
        });
        assert(received.has(tip.oid));
        return {
          ms,
          objects: received.size,
          bytes: response.length,
          queries: measuredQueries,
          transactions: 0,
        };
      } finally {
        opened.close();
      }
    },
  });
}
workloads.push({
  name: "connectivity-500-commits",
  run: async (engine) => {
    let queries = 0;
    const opened = engine.database.createTestRepositoryStorage({
      onQuery: () => {
        queries += 1;
      },
    });
    try {
      const store = new engine.store.ObjectStore(opened.db, opened.kv);
      await engine.parser.readPack(streamOf(fixturePack), store);
      queries = 0;
      const start = performance.now();
      const missing = await engine.connectivity.findMissingObject(history.at(-1)!.oid, store, {
        verified: new Set(),
        visited: new Set(),
      });
      const ms = performance.now() - start;
      assert.equal(missing, null);
      return { ms, objects: history.length + 1, bytes: 0, queries, transactions: 0 };
    } finally {
      opened.close();
    }
  },
});
// Keep the engine's diagnostic formatting in the measured path, but omit terminal I/O.
console.log = () => {};
const results = [];
for (const workload of workloads) {
  process.stderr.write(`Benchmarking ${workload.name}\n`);
  for (const engine of engines) await workload.run(engine);
  const runs: Measurement[][] = [[], []];
  for (let sample = 0; sample < samples; sample++) {
    for (const index of sample % 2 === 0 ? [0, 1] : [1, 0]) {
      Bun.gc(true);
      runs[index]!.push(await workload.run(engines[index]!));
    }
  }
  const median = (runs: Measurement[]) =>
    [...runs].sort((a, b) => a.ms - b.ms)[Math.floor(runs.length / 2)]!;
  results.push({
    workload: workload.name,
    baseline: median(runs[0]!),
    updated: median(runs[1]!),
    samples: runs,
  });
}
process.stdout.write(
  JSON.stringify(
    {
      runtime: `Bun ${Bun.version}`,
      platform: `${platform()} ${arch()}`,
      cpu: cpus()[0]?.model,
      baseline: execFileSync("git", ["-C", roots[0]!, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      samples,
      warmups: 1,
      order: "alternating",
      results,
    },
    null,
    2,
  ) + "\n",
);
