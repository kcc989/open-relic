import { afterEach, describe, expect, test } from "bun:test";

import { PktLineReader, flushPkt, pktLine } from "../src/git/pkt-line.ts";
import type { SyncKv } from "../src/db/kv.ts";
import { MAX_OBJECT_BYTES } from "../src/object.ts";
import { ObjectStore, RepositoryStorageExhaustedError } from "../src/object-store.ts";
import { PackError, readPack } from "../src/pack.ts";
import { RemoteBranchError, RepositoryStore, type RemoteFetch } from "../src/repository-store.ts";
import { blob, commit, tree, treeEntry } from "./support/git-objects.ts";
import { buildPack, concat, streamOf } from "./support/pack.ts";
import {
  createSqliteFullError,
  createTestRepositoryStorage,
  type TestRepositoryStorage,
} from "./support/database.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const openHandles: Array<() => void> = [];

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: Uint8Array;
  readonly credentials: RequestCredentials;
  readonly headers: Headers;
}

const exactBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

const storage = (): TestRepositoryStorage => {
  const opened = createTestRepositoryStorage();
  openHandles.push(opened.close);
  return opened;
};

afterEach(() => {
  for (const close of openHandles.splice(0)) {
    close();
  }
});

const advertisement = (options: {
  readonly head: string;
  readonly branch: string;
  readonly otherBranch?: { readonly name: string; readonly oid: string };
  readonly extraRefs?: Readonly<Record<string, string>>;
  readonly shallow?: readonly string[];
  readonly supportsShallow?: boolean;
}): Uint8Array =>
  concat(
    pktLine("# service=git-upload-pack\n"),
    encoder.encode("0000"),
    pktLine("version 1\n"),
    pktLine(
      `${options.head} HEAD\0symref=HEAD:refs/heads/${options.branch}${options.supportsShallow === false ? "" : " shallow"} ofs-delta object-format=sha1\n`,
    ),
    pktLine(`${options.head} refs/heads/${options.branch}\n`),
    ...(options.otherBranch === undefined
      ? []
      : [pktLine(`${options.otherBranch.oid} refs/heads/${options.otherBranch.name}\n`)]),
    ...Object.entries(options.extraRefs ?? {}).map(([name, oid]) => pktLine(`${oid} ${name}\n`)),
    ...(options.shallow ?? []).map((oid) => pktLine(`shallow ${oid}\n`)),
    encoder.encode("0000"),
  );

const smartHttpFixture =
  (options: {
    readonly advertisement: Uint8Array;
    readonly pack: Uint8Array;
    readonly requests: RecordedRequest[];
    readonly shallow?: readonly string[];
  }): RemoteFetch =>
  async (input, init) => {
    const request = new Request(input, init);
    options.requests.push({
      url: request.url,
      method: request.method,
      body: new Uint8Array(await request.clone().arrayBuffer()),
      credentials: init?.credentials ?? request.credentials,
      headers: request.headers,
    });

    if (request.method === "GET") {
      return new Response(exactBuffer(options.advertisement), {
        headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
      });
    }

    return new Response(
      exactBuffer(
        concat(
          ...(options.shallow ?? []).map((oid) => pktLine(`shallow ${oid}\n`)),
          ...(options.shallow === undefined ? [] : [encoder.encode("0000")]),
          pktLine("NAK\n"),
          options.pack,
        ),
      ),
      {
        headers: { "Content-Type": "application/x-git-upload-pack-result" },
      },
    );
  };

describe("fetching one public HTTPS branch", () => {
  test("discovers the remote HEAD and imports only that branch", async () => {
    const readme = blob("selected branch\n");
    const selectedTree = tree([treeEntry("README.md", readme)]);
    const oldest = commit({ tree: selectedTree, message: "oldest" });
    const middle = commit({ tree: selectedTree, parents: [oldest], message: "middle" });
    const selected = commit({ tree: selectedTree, parents: [middle], message: "selected" });
    const unrelated = commit({ tree: tree([]), message: "unrelated" });
    const pack = buildPack(
      [readme, selectedTree, oldest, middle, selected].map((object) => ({
        kind: "object" as const,
        type: object.type,
        bytes: object.bytes,
      })),
    ).bytes;
    const requests: RecordedRequest[] = [];
    const fetchRemote = smartHttpFixture({
      advertisement: advertisement({
        head: selected.oid,
        branch: "trunk",
        otherBranch: { name: "unrelated", oid: unrelated.oid },
        extraRefs: {
          "refs/tags/v1": unrelated.oid,
          "refs/notes/review": unrelated.oid,
        },
      }),
      pack,
      requests,
    });
    const opened = storage();
    const repository = new RepositoryStore(opened.db, opened.kv);
    await repository.initialize({
      defaultBranch: "main",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    const imported = await repository.importBranch(
      { url: "https://git.example/public/project.git" },
      fetchRemote,
    );

    expect(imported).toEqual({ branch: "trunk", oid: selected.oid, shallow: [] });
    expect(await repository.describe()).toEqual({
      defaultBranch: "trunk",
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    expect(await repository.readObject(selected.oid)).toEqual({
      type: "commit",
      bytes: selected.bytes,
    });
    expect(await repository.readObject(unrelated.oid)).toBeNull();
    expect(await repository.readObject(oldest.oid)).not.toBeNull();

    const refAdvertisement = await new Response(await repository.advertiseReceivePack()).text();
    expect(refAdvertisement).toContain(`${selected.oid} refs/heads/trunk`);
    expect(refAdvertisement).not.toContain("refs/heads/unrelated");
    expect(refAdvertisement).not.toContain("refs/tags/");
    expect(refAdvertisement).not.toContain("refs/notes/");

    expect(requests.map((request) => request.url)).toEqual([
      "https://git.example/public/project.git/info/refs?service=git-upload-pack",
      "https://git.example/public/project.git/git-upload-pack",
    ]);
    const negotiation = decoder.decode(requests[1]!.body);
    expect(negotiation).toContain(`want ${selected.oid}`);
    expect(negotiation).not.toContain(unrelated.oid);
    expect(negotiation).not.toContain("deepen ");
  });

  test("imports a real shallow history at every positive integer depth", async () => {
    const contents = blob("the working tree\n");
    const snapshot = tree([treeEntry("story.txt", contents)]);
    const omitted = commit({ tree: snapshot, message: "one" });
    const boundary = commit({ tree: snapshot, parents: [omitted], message: "two" });
    const tip = commit({ tree: snapshot, parents: [boundary], message: "three" });
    const pack = buildPack(
      [contents, snapshot, boundary, tip].map((object) => ({
        kind: "object" as const,
        type: object.type,
        bytes: object.bytes,
      })),
    ).bytes;
    const requests: RecordedRequest[] = [];
    const fetchRemote = smartHttpFixture({
      advertisement: advertisement({ head: tip.oid, branch: "main" }),
      pack,
      requests,
      shallow: [boundary.oid],
    });
    const opened = storage();
    const repository = new RepositoryStore(opened.db, opened.kv);
    await repository.initialize({
      defaultBranch: "main",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    const imported = await repository.importBranch(
      { url: "https://git.example/public/project.git", depth: 2 },
      fetchRemote,
    );

    expect(imported.shallow).toEqual([boundary.oid]);
    expect(decoder.decode(requests[1]!.body)).toContain("deepen 2\n");
    expect(await repository.readObject(omitted.oid)).toBeNull();
    expect(await repository.readObject(boundary.oid)).not.toBeNull();

    let progress = await repository.sweep();
    while (progress.phase !== "complete") {
      progress = await repository.sweep();
    }
    expect(await repository.readObject(boundary.oid)).not.toBeNull();

    const servedAdvertisement = await new Response(await repository.advertiseUploadPack(1)).text();
    expect(servedAdvertisement).toContain(`shallow ${boundary.oid}\n`);

    const served = new PktLineReader(
      await repository.uploadPack(
        streamOf(concat(pktLine(`want ${tip.oid}\n`), flushPkt(), pktLine("done\n"))),
      ),
    );
    const acknowledgement = await served.next();
    expect(acknowledgement.kind === "line" ? decoder.decode(acknowledgement.payload) : "").toBe(
      "NAK\n",
    );
    const copied = storage();
    const copiedObjects = new ObjectStore(copied.db, copied.kv);
    await readPack(served.rest(), copiedObjects);
    expect(await copiedObjects.read(tip.oid)).not.toBeNull();
    expect(await copiedObjects.read(boundary.oid)).not.toBeNull();
    expect(await copiedObjects.read(omitted.oid)).toBeNull();
  });

  test("imports the selected history from a remote that is itself shallow", async () => {
    const snapshot = tree([]);
    const absentParent = commit({ tree: snapshot, message: "absent upstream history" });
    const boundary = commit({
      tree: snapshot,
      parents: [absentParent],
      message: "upstream boundary",
    });
    const tip = commit({ tree: snapshot, parents: [boundary], message: "selected" });
    const pack = buildPack(
      [snapshot, boundary, tip].map((object) => ({
        kind: "object" as const,
        type: object.type,
        bytes: object.bytes,
      })),
    ).bytes;
    const requests: RecordedRequest[] = [];
    const opened = storage();
    const repository = new RepositoryStore(opened.db, opened.kv);
    await repository.initialize({
      defaultBranch: "main",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    const imported = await repository.importBranch(
      { url: "https://git.example/public/shallow.git" },
      smartHttpFixture({
        advertisement: advertisement({
          head: tip.oid,
          branch: "main",
          shallow: [boundary.oid],
        }),
        pack,
        requests,
      }),
    );

    expect(imported).toEqual({ branch: "main", oid: tip.oid, shallow: [boundary.oid] });
    expect(await repository.readObject(absentParent.oid)).toBeNull();
    expect(await new Response(await repository.advertiseUploadPack(1)).text()).toContain(
      `shallow ${boundary.oid}\n`,
    );
  });

  test("rejects non-public remote URL literals before making a request", async () => {
    const invalid = [
      "http://git.example/project.git",
      "https://user:secret@git.example/project.git",
      "https://localhost/project.git",
      "https://127.0.0.1/project.git",
      "https://10.20.30.40/project.git",
      "https://172.16.1.2/project.git",
      "https://192.168.1.2/project.git",
      "https://169.254.1.2/project.git",
      "https://[::1]/project.git",
      "https://[fc00::1]/project.git",
      "https://[fe80::1]/project.git",
    ];
    let requests = 0;
    const fetchRemote: RemoteFetch = async () => {
      requests += 1;
      throw new Error("A rejected URL reached the network.");
    };

    for (const url of invalid) {
      const opened = storage();
      const repository = new RepositoryStore(opened.db, opened.kv);
      await repository.initialize({
        defaultBranch: "main",
        createdAt: "2026-08-13T00:00:00.000Z",
      });

      try {
        await repository.importBranch({ url }, fetchRemote);
        throw new Error(`Accepted ${url}`);
      } catch (error) {
        if (!(error instanceof RemoteBranchError)) throw error;
        expect(error.code).toBe("invalid-url");
        expect(error.message).not.toContain("secret");
      }
    }

    expect(requests).toBe(0);
  });

  test("revalidates bounded HTTPS redirects and sends no credentials or cookies", async () => {
    const selected = commit({ tree: tree([]), message: "selected" });
    const pack = buildPack([
      { kind: "object", type: selected.type, bytes: selected.bytes },
      { kind: "object", type: "tree", bytes: tree([]).bytes },
    ]).bytes;
    const requests: RecordedRequest[] = [];
    const fetchRemote: RemoteFetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        method: request.method,
        body: new Uint8Array(await request.clone().arrayBuffer()),
        credentials: init?.credentials ?? request.credentials,
        headers: request.headers,
      });

      if (request.url.startsWith("https://git.example/")) {
        return new Response(null, {
          status: request.method === "GET" ? 302 : 307,
          headers: {
            Location: request.url.replace("https://git.example/", "https://mirror.example/"),
          },
        });
      }
      if (request.method === "GET") {
        return new Response(exactBuffer(advertisement({ head: selected.oid, branch: "main" })), {
          headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
        });
      }
      return new Response(exactBuffer(concat(pktLine("NAK\n"), pack)), {
        headers: { "Content-Type": "application/x-git-upload-pack-result" },
      });
    };
    const opened = storage();
    const repository = new RepositoryStore(opened.db, opened.kv);
    await repository.initialize({
      defaultBranch: "main",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    await repository.importBranch(
      { url: "https://git.example/project.git?opaque=do-not-log" },
      fetchRemote,
    );

    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.credentials).toBe("omit");
      expect(request.headers.has("Authorization")).toBe(false);
      expect(request.headers.has("Cookie")).toBe(false);
    }
  });

  test("accepts every positive integer depth and rejects every other number", async () => {
    let requests = 0;
    const fetchRemote: RemoteFetch = async () => {
      requests += 1;
      throw new Error("An invalid depth reached the network.");
    };

    for (const depth of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const opened = storage();
      const repository = new RepositoryStore(opened.db, opened.kv);
      await repository.initialize({
        defaultBranch: "main",
        createdAt: "2026-08-13T00:00:00.000Z",
      });

      try {
        await repository.importBranch(
          { url: "https://git.example/project.git", depth },
          fetchRemote,
        );
        throw new Error(`Accepted depth ${depth}`);
      } catch (error) {
        if (!(error instanceof RemoteBranchError)) throw error;
        expect(error.code).toBe("invalid-depth");
      }
    }

    expect(requests).toBe(0);
  });

  test("normalizes depths above Git's infinite-depth sentinel on the wire", async () => {
    const snapshot = tree([]);
    const selected = commit({ tree: snapshot });
    const pack = buildPack(
      [snapshot, selected].map((object) => ({
        kind: "object" as const,
        type: object.type,
        bytes: object.bytes,
      })),
    ).bytes;
    const requests: RecordedRequest[] = [];
    const opened = storage();
    const repository = new RepositoryStore(opened.db, opened.kv);
    await repository.initialize({
      defaultBranch: "main",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    await repository.importBranch(
      { url: "https://git.example/project.git", depth: Number.MAX_SAFE_INTEGER },
      smartHttpFixture({
        advertisement: advertisement({ head: selected.oid, branch: "main" }),
        pack,
        requests,
        shallow: [],
      }),
    );

    expect(decoder.decode(requests[1]!.body)).toContain("deepen 2147483647\n");
  });

  test("selects an explicitly requested branch instead of remote HEAD", async () => {
    const snapshot = tree([]);
    const head = commit({ tree: snapshot, message: "default" });
    const selected = commit({ tree: snapshot, message: "release" });
    const pack = buildPack(
      [snapshot, selected].map((object) => ({
        kind: "object" as const,
        type: object.type,
        bytes: object.bytes,
      })),
    ).bytes;
    const requests: RecordedRequest[] = [];
    const opened = storage();
    const repository = new RepositoryStore(opened.db, opened.kv);
    await repository.initialize({
      defaultBranch: "main",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    const imported = await repository.importBranch(
      { url: "https://git.example/project.git", branch: "release/2.x" },
      smartHttpFixture({
        advertisement: advertisement({
          head: head.oid,
          branch: "main",
          otherBranch: { name: "release/2.x", oid: selected.oid },
        }),
        pack,
        requests,
      }),
    );

    expect(imported.branch).toBe("release/2.x");
    expect((await repository.describe())?.defaultBranch).toBe("release/2.x");
    expect(decoder.decode(requests[1]!.body)).toContain(`want ${selected.oid}`);
    expect(decoder.decode(requests[1]!.body)).not.toContain(head.oid);
  });

  test("rejects an invalid requested branch before making a request", async () => {
    let requests = 0;
    const opened = storage();
    const repository = new RepositoryStore(opened.db, opened.kv);
    await repository.initialize({
      defaultBranch: "main",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    try {
      await repository.importBranch(
        { url: "https://git.example/project.git", branch: "release/../secret" },
        async () => {
          requests += 1;
          throw new Error("An invalid branch reached the network.");
        },
      );
      throw new Error("Accepted an invalid branch.");
    } catch (error) {
      if (!(error instanceof RemoteBranchError)) throw error;
      expect(error.code).toBe("branch-not-found");
    }
    expect(requests).toBe(0);
  });

  test("enforces the object ceiling without buffering the upload-pack response", async () => {
    const selected = commit({ tree: tree([]) });
    const rejectedPack = buildPack([
      {
        kind: "object",
        type: "blob",
        bytes: new Uint8Array(),
        declaredSize: MAX_OBJECT_BYTES + 1,
      },
    ]).bytes;
    const responseBytes = concat(pktLine("NAK\n"), rejectedPack, new Uint8Array(4 * 1_024 * 1_024));
    let pulled = 0;
    const fetchRemote: RemoteFetch = async (input, init) => {
      const request = new Request(input, init);
      return request.method === "GET"
        ? new Response(exactBuffer(advertisement({ head: selected.oid, branch: "main" })), {
            headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
          })
        : new Response(
            streamOf(responseBytes, {
              chunkSize: 64,
              onPull: (count) => {
                pulled = count;
              },
            }),
            { headers: { "Content-Type": "application/x-git-upload-pack-result" } },
          );
    };
    const opened = storage();
    const repository = new RepositoryStore(opened.db, opened.kv);
    await repository.initialize({
      defaultBranch: "main",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    try {
      await repository.importBranch({ url: "https://git.example/project.git" }, fetchRemote);
      throw new Error("Accepted an oversized object.");
    } catch (error) {
      if (!(error instanceof PackError)) throw error;
      expect(error.code).toBe("object-too-large");
    }

    expect(pulled).toBeLessThan(responseBytes.length);
    expect((await repository.describe())?.defaultBranch).toBe("main");
    expect(await new Response(await repository.advertiseReceivePack()).text()).not.toContain(
      "refs/heads/",
    );
  });

  test("never publishes a branch when storage is exhausted", async () => {
    const snapshot = tree([]);
    const selected = commit({ tree: snapshot });
    const pack = buildPack(
      [snapshot, selected].map((object) => ({
        kind: "object" as const,
        type: object.type,
        bytes: object.bytes,
      })),
    ).bytes;
    const opened = storage();
    let failed = false;
    const exhaustedKv: SyncKv = {
      get: <T>(key: string): T | undefined => opened.kv.get<T>(key),
      put: <T>(key: string, value: T): void => {
        if (!failed && key.startsWith(`o:${selected.oid}:`)) {
          failed = true;
          throw createSqliteFullError();
        }
        opened.kv.put(key, value);
      },
      delete: (key: string): void => opened.kv.delete(key),
    };
    const repository = new RepositoryStore(opened.db, exhaustedKv);
    await repository.initialize({
      defaultBranch: "main",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    await expect(
      repository.importBranch(
        { url: "https://git.example/project.git" },
        smartHttpFixture({
          advertisement: advertisement({ head: selected.oid, branch: "trunk" }),
          pack,
          requests: [],
        }),
      ),
    ).rejects.toBeInstanceOf(RepositoryStorageExhaustedError);

    const recovery = new RepositoryStore(opened.db, opened.kv);
    expect(await recovery.readObject(snapshot.oid)).not.toBeNull();
    expect(await recovery.readObject(selected.oid)).toBeNull();
    expect((await recovery.describe())?.defaultBranch).toBe("main");
    expect(await new Response(await recovery.advertiseReceivePack()).text()).not.toContain(
      "refs/heads/",
    );
  });

  test("never exposes a remote query through an upstream failure", async () => {
    const opened = storage();
    const repository = new RepositoryStore(opened.db, opened.kv);
    await repository.initialize({
      defaultBranch: "main",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    try {
      await repository.importBranch(
        { url: "https://git.example/project.git?access_token=top-secret" },
        async (input) => {
          throw new Error(`fetch failed for ${input.toString()}`);
        },
      );
      throw new Error("Accepted a failed upstream request.");
    } catch (error) {
      if (!(error instanceof RemoteBranchError)) throw error;
      expect(error.code).toBe("upstream-unavailable");
      expect(error.message).not.toContain("top-secret");
      expect(error.message).not.toContain("access_token");
    }
  });

  test("does not ask a remote for depth it did not advertise", async () => {
    const selected = commit({ tree: tree([]) });
    let requests = 0;
    const fetchRemote: RemoteFetch = async (input, init) => {
      requests += 1;
      const request = new Request(input, init);
      if (request.method !== "GET") {
        throw new Error("Sent deepen to a remote without shallow support.");
      }
      return new Response(
        exactBuffer(advertisement({ head: selected.oid, branch: "main", supportsShallow: false })),
        { headers: { "Content-Type": "application/x-git-upload-pack-advertisement" } },
      );
    };
    const opened = storage();
    const repository = new RepositoryStore(opened.db, opened.kv);
    await repository.initialize({
      defaultBranch: "main",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    try {
      await repository.importBranch(
        { url: "https://git.example/project.git", depth: 1 },
        fetchRemote,
      );
      throw new Error("Accepted a remote without shallow support.");
    } catch (error) {
      if (!(error instanceof RemoteBranchError)) throw error;
      expect(error.code).toBe("invalid-advertisement");
    }
    expect(requests).toBe(1);
  });

  test("follows no more than three redirects", async () => {
    let requests = 0;
    const opened = storage();
    const repository = new RepositoryStore(opened.db, opened.kv);
    await repository.initialize({
      defaultBranch: "main",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    try {
      await repository.importBranch({ url: "https://git.example/project.git" }, async (input) => {
        requests += 1;
        return new Response(null, { status: 302, headers: { Location: input.toString() } });
      });
      throw new Error("Followed an unbounded redirect chain.");
    } catch (error) {
      if (!(error instanceof RemoteBranchError)) throw error;
      expect(error.code).toBe("upstream-unavailable");
    }
    expect(requests).toBe(4);
  });
});
