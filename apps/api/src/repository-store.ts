import type { CommitInfo } from "@open-relic/contracts";
import { asc, eq, sql } from "drizzle-orm";

import { findMissingObject, linksToFetch, type WalkOptions } from "./connectivity.ts";
import type { SyncSqliteDatabase } from "./db/database.ts";
import type { SyncKv } from "./db/kv.ts";
import {
  REPOSITORY_STATE_ID,
  objects,
  refs,
  repositoryState,
  shallowCommits,
  sweepReachable,
  sweepState,
} from "./db/repository-schema.ts";
import {
  receivePackAdvertisementStream,
  uploadPackAdvertisementStream,
  type AdvertisedRef,
  type UploadProtocolVersion,
} from "./git/advertisement.ts";
import { PktLineError, PktLineReader } from "./git/pkt-line.ts";
import {
  REJECTIONS,
  ATOMIC_CAPABILITY,
  PUSH_OPTIONS_CAPABILITY,
  REPORT_STATUS_CAPABILITY,
  ReceivePackError,
  UNPACK_OK,
  accepted,
  isDelete,
  readPushOptions,
  readReceivePackRequest,
  receivePackResult,
  rejected,
  screenCommands,
  type ReceivePackCommand,
  type RefStatus,
} from "./git/receive-pack.ts";
import { uploadPackResultStream } from "./git/upload-pack.ts";
import {
  BRANCH_REF_PREFIX,
  HEAD_KEY,
  formatHead,
  headBranch,
  parseHead,
  symbolicHead,
  type Head,
} from "./head.ts";
import type { ImportedBranch, ImportJob, ImportJobOutcome } from "./import-operation.ts";
import {
  fetchRemoteBranch,
  type RemoteBranchRequest,
  type RemoteFetch,
} from "./git/remote-branch.ts";
import { ObjectStore, RepositoryStorageExhaustedError } from "./object-store.ts";
import type { ObjectType } from "./object.ts";
import { ObjectParseError } from "./object-parse.ts";
import { PackError, readPack, type PackBase, type PackObject } from "./pack.ts";
import { parseCommit } from "./repository-content.ts";
import { RepositorySweeper, type SweepProgress } from "./sweep.ts";
import { GITLINK_MODE, TREE_MODE, treeEntries, type ParsedTreeEntry } from "./tree-entry.ts";

const TREE_NAME_DECODER = new TextDecoder();

/** The Git side of a `git init --bare`; the registry owns naming. */
export interface RepositoryInit {
  readonly defaultBranch: string;
  /** Stamped by the index, so the object and its index entry share one clock. */
  readonly createdAt: string;
}

export interface RepositorySnapshot {
  /** `null` once HEAD is detached, which Git can arrive at on its own. */
  readonly defaultBranch: string | null;
  readonly createdAt: string;
}

/**
 * What a push leaves behind, as the Worker needs to see it. The report is bytes
 * because the object owns Git and the Worker owns the response; the two fields
 * beside it are the only things about a push the registry has to be told.
 */
export interface ReceivePackOutcome {
  /** The `report-status` body, already framed for the client's capabilities. */
  readonly report: Uint8Array<ArrayBuffer>;
  /** Whether any ref actually moved, which is what makes this a push at all. */
  readonly accepted: boolean;
  /**
   * The branch HEAD points at now, when this push is what retargeted it, so the
   * registry's denormalized copy can follow. `null` when HEAD did not move.
   */
  readonly retargetedTo: string | null;
}

export interface ForkOptions {
  readonly createdAt: string;
  readonly defaultBranchOnly: boolean;
}

export interface ForkState {
  readonly createdAt: string;
  readonly head: string;
  readonly refs: readonly AdvertisedRef[];
}

export interface ForkTarget {
  readonly writeForkObject: (
    object: ForkObject,
    bytes: ReadableStream<Uint8Array>,
  ) => Promise<void>;
  readonly completeFork: (state: ForkState) => Promise<void>;
}

export interface ForkObject {
  readonly oid: string;
  readonly type: ObjectType;
  readonly size: number;
}

export interface ForkOutcome {
  readonly objects: number;
}

export type ResolvedContentFailure =
  | "corrupt"
  | "file-not-found"
  | "revision-not-found"
  | "wrong-object-type";

export type RepositoryHistoryResult =
  | { readonly ok: true; readonly commits: readonly CommitInfo[] }
  | { readonly ok: false; readonly reason: ResolvedContentFailure };

export type RepositoryFileResult =
  | { readonly ok: true; readonly bytes: ReadableStream<Uint8Array> }
  | { readonly ok: false; readonly reason: ResolvedContentFailure };

export class ForkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForkError";
  }
}

export interface RepositoryObjectClient {
  readonly initialize: (init: RepositoryInit) => Promise<RepositorySnapshot>;
  readonly describe: () => Promise<RepositorySnapshot | null>;
  readonly advertiseReceivePack: () => Promise<ReadableStream<Uint8Array>>;
  readonly advertiseUploadPack: (
    protocolVersion: UploadProtocolVersion,
  ) => Promise<ReadableStream<Uint8Array>>;
  readonly uploadPack: (body: ReadableStream<Uint8Array>) => Promise<ReadableStream<Uint8Array>>;
  readonly receivePack: (body: ReadableStream<Uint8Array>) => Promise<ReceivePackOutcome>;
  readonly copyForkTo: (target: ForkTarget, options: ForkOptions) => Promise<ForkOutcome>;
  readonly writeForkObject: (
    object: ForkObject,
    bytes: ReadableStream<Uint8Array>,
  ) => Promise<void>;
  readonly completeFork: (state: ForkState) => Promise<void>;
  readonly readObject: (oid: string) => Promise<PackBase | null>;
  readonly readBlob: (oid: string) => Promise<ReadableStream<Uint8Array> | null>;
  readonly readHistory: (
    revision: string | null,
    limit: number,
    offset: number,
  ) => Promise<RepositoryHistoryResult>;
  readonly readFile: (revision: string | null, path: string) => Promise<RepositoryFileResult>;
  readonly hasObject: (oid: string) => Promise<boolean>;
  readonly importBranch: (request: RemoteBranchRequest) => Promise<ImportedBranch>;
  readonly resetImport: (init: RepositoryInit) => Promise<void>;
  readonly scheduleImport: (job: ImportJob) => Promise<ImportJobOutcome>;
  readonly sweep: () => Promise<SweepProgress>;
  readonly destroy: () => Promise<void>;
}

export {
  RemoteBranchError,
  type RemoteBranchRequest,
  type RemoteFetch,
} from "./git/remote-branch.ts";
export { type ImportedBranch, type ImportJob, type ImportJobOutcome } from "./import-operation.ts";

/** The wire strings live with the wire; this is where callers found them. */
export { REJECTIONS } from "./git/receive-pack.ts";

/**
 * A command that survived every check, waiting on the one transaction that
 * applies them all.
 */
interface PendingUpdate {
  readonly at: number;
  readonly command: ReceivePackCommand;
}

/**
 * `RepositoryObject` is a thin Durable Object shell around this class, which is
 * what lets the tests run the real queries against the real migrations without
 * a Workers runtime.
 *
 * HEAD lives in KV rather than SQL because it is a Git file (ADR-0003). Both
 * halves are the same SQLite database inside the object, so the row and the
 * file commit in the same storage turn.
 */
export class RepositoryStore {
  readonly #db: SyncSqliteDatabase;
  readonly #kv: SyncKv;
  readonly #objects: ObjectStore;
  readonly #sweeper: RepositorySweeper;
  #operation = Promise.resolve();

  constructor(db: SyncSqliteDatabase, kv: SyncKv) {
    this.#db = db;
    this.#kv = kv;
    this.#objects = new ObjectStore(db, kv);
    this.#sweeper = new RepositorySweeper(db, this.#objects);
  }

  /**
   * Idempotent, because creating a repository is an index write followed by
   * this one and a retry must not reset a repository that already exists. The
   * row marks the object initialized, so HEAD is written only when the insert
   * claimed it — otherwise a retry naming a different branch would retarget a
   * HEAD that has already answered for itself.
   */
  async initialize(init: RepositoryInit): Promise<RepositorySnapshot> {
    const inserted = await this.#db
      .insert(repositoryState)
      .values({
        id: REPOSITORY_STATE_ID,
        createdAt: init.createdAt,
      })
      .onConflictDoNothing()
      .returning({ createdAt: repositoryState.createdAt });

    if (inserted.length > 0) {
      this.#kv.put(HEAD_KEY, formatHead(symbolicHead(init.defaultBranch)));
    }

    const stored = await this.describe();
    return stored ?? init;
  }

  async describe(): Promise<RepositorySnapshot | null> {
    const rows = await this.#db
      .select()
      .from(repositoryState)
      .where(eq(repositoryState.id, REPOSITORY_STATE_ID))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return null;
    }

    return { defaultBranch: this.#defaultBranch(), createdAt: row.createdAt };
  }

  /**
   * The push side of the Git protocol's opening reply, encoded here rather than
   * in the Worker because the refs it lists are only consistent from inside the
   * object that owns them.
   *
   * A stream, so a repository with many refs is not assembled in memory on its
   * way to the client.
   */
  async advertiseReceivePack(): Promise<ReadableStream<Uint8Array>> {
    return receivePackAdvertisementStream(await this.#refs());
  }

  /** The fetch advertisement includes HEAD so a clone knows what to check out. */
  async advertiseUploadPack(
    protocolVersion: UploadProtocolVersion,
  ): Promise<ReadableStream<Uint8Array>> {
    const shallow = [...(await this.#shallow())].sort();
    return uploadPackAdvertisementStream(
      await this.#uploadRefs(),
      this.#head(),
      protocolVersion,
      shallow,
    );
  }

  /** A fetch response is pulled object by object rather than assembled here. */
  async uploadPack(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
    const advertisedOids = new Set((await this.#uploadRefs()).map((ref) => ref.oid));
    const head = this.#head();
    if (head?.kind === "detached") {
      advertisedOids.add(head.oid);
    }

    return uploadPackResultStream(body, this.#objects, advertisedOids, await this.#shallow());
  }

  async importBranch(
    request: RemoteBranchRequest,
    fetchRemote: RemoteFetch = globalThis.fetch,
    before: Promise<void> = Promise.resolve(),
  ): Promise<ImportedBranch> {
    return this.#exclusive(async () => {
      await before;
      const fetched = await fetchRemoteBranch(request, fetchRemote);
      const summary = await readPack(fetched.pack, this.#objects);

      // A remote advertisement carries repository-wide grafts. Keep only the
      // advertised boundaries that arrived with this one selected branch.
      const importedShallow: string[] = [];
      for (const oid of new Set(fetched.shallow)) {
        const object = await this.#objects.read(oid);
        if (object?.type === "commit") {
          importedShallow.push(oid);
        }
      }

      const missing = await findMissingObject(fetched.oid, this.#objects, {
        verified: new Set(),
        visited: new Set(),
        shallow: new Set(importedShallow),
      });
      if (missing !== null) {
        throw new PackError("truncated", `The imported branch is missing object ${missing}.`);
      }

      await this.#db.transaction((tx) => {
        tx.delete(refs).run();
        tx.delete(shallowCommits).run();
        tx.insert(refs)
          .values({ name: `${BRANCH_REF_PREFIX}${fetched.branch}`, objectId: fetched.oid })
          .run();
        if (importedShallow.length > 0) {
          tx.insert(shallowCommits)
            .values(importedShallow.map((oid) => ({ oid })))
            .run();
        }
        this.#kv.put(HEAD_KEY, formatHead(symbolicHead(fetched.branch)));
        tx.update(repositoryState)
          .set({ refVersion: sql`${repositoryState.refVersion} + 1` })
          .where(eq(repositoryState.id, REPOSITORY_STATE_ID))
          .run();
      });

      return {
        branch: fetched.branch,
        oid: fetched.oid,
        shallow: importedShallow,
        objects: summary.objectCount,
      };
    });
  }

  /**
   * Restart an incomplete import from an empty bare repository. There is no
   * per-object cursor: completed and partial objects from the failed attempt
   * are reclaimed before the remote is asked again.
   */
  async resetImport(init: RepositoryInit): Promise<void> {
    await this.#exclusive(async () => {
      const stored = await this.#db.select({ oid: objects.oid }).from(objects);
      for (const object of stored) {
        await this.#objects.reclaim(object.oid);
      }

      await this.#db.transaction((tx) => {
        tx.delete(refs).run();
        tx.delete(shallowCommits).run();
        tx.delete(sweepReachable).run();
        tx.delete(sweepState).run();
        tx.delete(repositoryState).run();
        tx.insert(repositoryState)
          .values({ id: REPOSITORY_STATE_ID, createdAt: init.createdAt })
          .run();
        this.#kv.put(HEAD_KEY, formatHead(symbolicHead(init.defaultBranch)));
      });
    });
  }

  /**
   * A push, start to finish: the client's ref update commands, the pack behind
   * them, a walk that confirms the pack was complete, and then one transaction
   * that moves the refs.
   *
   * The order is the whole design. Objects are written before anything is
   * checked, because the pack streams through once and holding it back would
   * mean holding it in memory. A ref is the only thing that makes an object
   * reachable, so objects a failed push left behind are a storage cost rather
   * than a correctness problem — sweeping them is separate work.
   */
  async receivePack(
    body: ReadableStream<Uint8Array>,
    before: Promise<void> = Promise.resolve(),
  ): Promise<ReceivePackOutcome> {
    return this.#exclusive(async () => {
      await before;
      return this.#receivePack(body);
    });
  }

  /**
   * Copy one stable, reachable source snapshot while excluding pushes and
   * sweeps. The target receives one resolved object at a time, so the copy's
   * memory is bounded by the largest object rather than by repository size.
   */
  async copyForkTo(
    target: ForkTarget,
    options: ForkOptions,
    afterSnapshot: () => Promise<void> = async () => {},
  ): Promise<ForkOutcome> {
    return this.#exclusive(async () => {
      const headContents = this.#kv.get(HEAD_KEY);
      if (headContents === undefined) {
        throw new ForkError("The source repository has no readable HEAD.");
      }

      const head = parseHead(headContents);
      if (head === null) {
        throw new ForkError("The source repository has an unreadable HEAD.");
      }
      const capturedRefs = await this.#refs();
      const copiedRefs = options.defaultBranchOnly
        ? head.kind === "symbolic"
          ? capturedRefs.filter((ref) => ref.name === head.ref)
          : []
        : capturedRefs;
      const pending = copiedRefs.map((ref) => ref.oid);
      if (head.kind === "detached") {
        pending.push(head.oid);
      }

      // Tests use this seam to land a concurrent push after the snapshot was
      // chosen. The operation gate keeps that push queued until the copy ends.
      await afterSnapshot();

      const copied = new Set<string>();
      while (pending.length > 0) {
        const oid = pending.pop()!;
        if (copied.has(oid)) {
          continue;
        }

        const object = await this.#objects.read(oid);
        if (object === null) {
          throw new ForkError(`Reachable source object ${oid} is missing.`);
        }
        copied.add(oid);

        for (const link of linksToFetch(object.type, object.bytes)) {
          pending.push(link.oid);
        }

        const transferable =
          object.bytes.buffer instanceof ArrayBuffer
            ? new Uint8Array(object.bytes.buffer, object.bytes.byteOffset, object.bytes.byteLength)
            : new Uint8Array(object.bytes);

        await target.writeForkObject(
          { oid, type: object.type, size: object.bytes.length },
          new ReadableStream<Uint8Array>({
            type: "bytes",
            start(controller) {
              // workerd rejects zero-length chunks in byte streams. Closing
              // without enqueueing still represents an empty Git object.
              if (transferable.byteLength > 0) {
                controller.enqueue(transferable);
              }
              controller.close();
            },
          }),
        );
      }

      await target.completeFork({
        createdAt: options.createdAt,
        head: headContents,
        refs: copiedRefs,
      });

      return { objects: copied.size };
    });
  }

  /** The target side of a fork; it owns fresh object rows and chunk values. */
  async writeForkObject(object: ForkObject, bytes: ReadableStream<Uint8Array>): Promise<void> {
    const contents = new Uint8Array(object.size);
    const reader = bytes.getReader();
    let at = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        if (at + next.value.length > contents.length) {
          await reader.cancel("Fork object exceeded its declared size.");
          throw new ForkError(`Fork object ${object.oid} exceeded its declared size.`);
        }
        contents.set(next.value, at);
        at += next.value.length;
      }
    } finally {
      reader.releaseLock();
    }

    if (at !== contents.length) {
      throw new ForkError(
        `Fork object ${object.oid} held ${at} bytes where it declared ${object.size}.`,
      );
    }
    await this.#objects.write({ ...object, bytes: contents, delta: null } satisfies PackObject);
  }

  /**
   * Make copied Git data visible inside the target only after every reachable
   * object arrived. The registry keeps the name unavailable until after this.
   */
  async completeFork(state: ForkState): Promise<void> {
    await this.#exclusive(async () => {
      await this.#db.transaction((tx) => {
        tx.insert(repositoryState)
          .values({ id: REPOSITORY_STATE_ID, createdAt: state.createdAt })
          .onConflictDoNothing()
          .run();
        for (const ref of state.refs) {
          tx.insert(refs).values({ name: ref.name, objectId: ref.oid }).onConflictDoNothing().run();
        }
        this.#kv.put(HEAD_KEY, state.head);
      });
    });
  }

  /** Advance one durable sweep batch without racing receive-pack or destruction. */
  async sweep(
    batchSize?: number,
    after: (progress: SweepProgress) => Promise<void> = async () => {},
  ): Promise<SweepProgress> {
    return this.#exclusive(async () => {
      const progress = await this.#sweeper.step(batchSize);
      await after(progress);
      return progress;
    });
  }

  /** Keep deletion ordered after any active push or sweep, including its alarm re-arm. */
  async destroyStorage(remove: () => Promise<void>): Promise<void> {
    await this.#exclusive(remove);
  }

  async #receivePack(body: ReadableStream<Uint8Array>): Promise<ReceivePackOutcome> {
    const lines = new PktLineReader(body);

    let commands: readonly ReceivePackCommand[];
    let capabilities: readonly string[];
    try {
      ({ commands, capabilities } = await readReceivePackRequest(lines));
      if (capabilities.includes(PUSH_OPTIONS_CAPABILITY)) {
        await readPushOptions(lines, capabilities);
      }
    } catch (error) {
      if (error instanceof ReceivePackError) {
        await lines.cancel();
        return this.#refuse(error.message, error.capabilities);
      }
      if (error instanceof PktLineError) {
        // The framing itself was wrong, so nothing was negotiated either.
        await lines.cancel();
        return this.#refuse(error.message, [REPORT_STATUS_CAPABILITY]);
      }
      throw error;
    }

    const current = await this.#refMap();
    const messages: string[] = [];

    // Only rejections are recorded: a command with no entry here was applied,
    // which makes the report total by construction rather than by invariant.
    const rejections = new Map<number, RefStatus>();
    const pending: PendingUpdate[] = [];

    screenCommands(commands, current).forEach((reason, at) => {
      const command = commands[at]!;
      if (reason === null) {
        pending.push({ at, command });
      } else {
        rejections.set(at, rejected(command.name, reason));
      }
    });

    // A push with nothing but deletes carries no pack, so waiting for one would
    // wait for a body the client has already finished sending.
    if (commands.some((command) => !isDelete(command))) {
      try {
        await readPack(lines.rest(), this.#objects);
      } catch (error) {
        if (!(error instanceof PackError) && !(error instanceof RepositoryStorageExhaustedError)) {
          throw error;
        }

        // No ref can be singled out: every one of them was riding on this pack.
        return this.#refuse(
          error.message,
          capabilities,
          commands.map((command) => rejected(command.name, REJECTIONS.unpacker)),
        );
      }
    } else {
      await lines.cancel();
    }

    const walk = {
      verified: new Set(current.values()),
      visited: new Set<string>(),
      shallow: await this.#shallow(),
    };
    const updates: PendingUpdate[] = [];

    for (const update of pending) {
      const verdict = await this.#verify(update.command, walk);

      if (verdict === null) {
        updates.push(update);
        continue;
      }

      rejections.set(update.at, rejected(update.command.name, verdict.reason));
      if (verdict.message !== undefined) {
        messages.push(verdict.message);
      }
    }

    if (capabilities.includes(ATOMIC_CAPABILITY) && rejections.size > 0) {
      return {
        report: receivePackResult(
          {
            unpack: UNPACK_OK,
            refs: commands.map(
              (command, at) => rejections.get(at) ?? rejected(command.name, REJECTIONS.atomic),
            ),
            messages,
          },
          capabilities,
        ),
        accepted: false,
        retargetedTo: null,
      };
    }

    const retargetedTo = this.#retarget(current, updates);
    if (updates.length > 0) {
      await this.#applyUpdates(updates, retargetedTo);
    }

    return {
      report: receivePackResult(
        {
          unpack: UNPACK_OK,
          refs: commands.map((command, at) => rejections.get(at) ?? accepted(command.name)),
          messages,
        },
        capabilities,
      ),
      accepted: updates.length > 0,
      retargetedTo,
    };
  }

  /** `null` when the repository does not hold that object. */
  readObject(oid: string): Promise<PackBase | null> {
    return this.#objects.read(oid);
  }

  /** Blob bytes cross the RPC boundary chunk by chunk, never as one 32 MiB value. */
  readBlob(oid: string): Promise<ReadableStream<Uint8Array> | null> {
    return this.#objects.readStream(oid, "blob");
  }

  async readHistory(
    revision: string | null,
    limit: number,
    offset: number,
  ): Promise<RepositoryHistoryResult> {
    const resolved = await this.#resolveCommit(revision);
    if (!resolved.ok) {
      return resolved;
    }
    if (resolved.oid === null) {
      return { ok: true, commits: [] };
    }

    const commits: CommitInfo[] = [];
    const pending = [resolved.oid];
    const visited = new Set<string>();
    const shallow = await this.#shallow();

    while (pending.length > 0 && commits.length < offset + limit) {
      const oid = pending.shift()!;
      if (visited.has(oid)) {
        continue;
      }
      visited.add(oid);

      const object = await this.#objects.read(oid);
      if (object === null) {
        return { ok: false, reason: "corrupt" };
      }
      if (object.type !== "commit") {
        return { ok: false, reason: "wrong-object-type" };
      }

      let parsed: CommitInfo;
      try {
        parsed = parseCommit(oid, object.bytes);
      } catch (error) {
        if (error instanceof ObjectParseError) {
          return { ok: false, reason: "corrupt" };
        }
        throw error;
      }
      commits.push(parsed);
      if (!shallow.has(oid)) {
        pending.push(...parsed.parents);
      }
    }

    return { ok: true, commits: commits.slice(offset) };
  }

  async readFile(revision: string | null, path: string): Promise<RepositoryFileResult> {
    const resolved = await this.#resolveCommit(revision);
    if (!resolved.ok) {
      return resolved;
    }
    if (resolved.oid === null) {
      return { ok: false, reason: "revision-not-found" };
    }

    const commit = await this.#objects.read(resolved.oid);
    if (commit === null || commit.type !== "commit") {
      return { ok: false, reason: "corrupt" };
    }

    let treeOid: string;
    try {
      treeOid = parseCommit(resolved.oid, commit.bytes).treeHash;
    } catch (error) {
      if (error instanceof ObjectParseError) {
        return { ok: false, reason: "corrupt" };
      }
      throw error;
    }

    const segments = path.split("/");
    if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
      return { ok: false, reason: "file-not-found" };
    }

    for (const [at, segment] of segments.entries()) {
      const tree = await this.#objects.read(treeOid);
      if (tree === null || tree.type !== "tree") {
        return { ok: false, reason: "corrupt" };
      }

      let entry: ParsedTreeEntry | undefined;
      try {
        for (const candidate of treeEntries(tree.bytes)) {
          if (TREE_NAME_DECODER.decode(candidate.name) === segment) {
            entry = candidate;
            break;
          }
        }
      } catch (error) {
        if (error instanceof ObjectParseError) {
          return { ok: false, reason: "corrupt" };
        }
        throw error;
      }
      if (entry === undefined) {
        return { ok: false, reason: "file-not-found" };
      }

      const last = at === segments.length - 1;
      if (!last) {
        if (entry.mode !== TREE_MODE) {
          return { ok: false, reason: "file-not-found" };
        }
        treeOid = entry.oid;
        continue;
      }

      if (entry.mode === TREE_MODE || entry.mode === GITLINK_MODE) {
        return { ok: false, reason: "wrong-object-type" };
      }
      const bytes = await this.#objects.readStream(entry.oid, "blob");
      return bytes === null ? { ok: false, reason: "corrupt" } : { ok: true, bytes };
    }

    return { ok: false, reason: "file-not-found" };
  }

  hasObject(oid: string): Promise<boolean> {
    return this.#objects.has(oid);
  }

  /** Byte order by full ref name, which is the order Git advertises in. */
  async #refs(): Promise<readonly AdvertisedRef[]> {
    const rows = await this.#db.select().from(refs).orderBy(asc(refs.name));

    return rows.map((row) => ({ name: row.name, oid: row.objectId }));
  }

  async #refMap(): Promise<ReadonlyMap<string, string>> {
    return new Map((await this.#refs()).map((ref) => [ref.name, ref.oid]));
  }

  async #resolveCommit(
    revision: string | null,
  ): Promise<
    | { readonly ok: true; readonly oid: string | null }
    | { readonly ok: false; readonly reason: ResolvedContentFailure }
  > {
    const refMap = await this.#refMap();
    const head = this.#head();
    let oid: string | undefined;

    if (revision === null) {
      if (head?.kind === "detached") {
        oid = head.oid;
      } else if (head !== null) {
        oid = refMap.get(head.ref);
        if (oid === undefined) {
          return { ok: true, oid: null };
        }
      }
    } else if (/^[0-9a-f]{40}$/.test(revision)) {
      oid = revision;
    } else {
      oid = refMap.get(`${BRANCH_REF_PREFIX}${revision}`) ?? refMap.get(`refs/tags/${revision}`);
    }

    if (oid === undefined) {
      return { ok: false, reason: "revision-not-found" };
    }

    const visited = new Set<string>();
    while (!visited.has(oid)) {
      visited.add(oid);
      const object = await this.#objects.read(oid);
      if (object === null) {
        return { ok: false, reason: "revision-not-found" };
      }
      if (object.type === "commit") {
        return { ok: true, oid };
      }
      if (object.type !== "tag") {
        return { ok: false, reason: "wrong-object-type" };
      }

      try {
        const [target] = linksToFetch(object.type, object.bytes);
        if (target === undefined) {
          return { ok: false, reason: "corrupt" };
        }
        oid = target.oid;
      } catch (error) {
        if (error instanceof ObjectParseError) {
          return { ok: false, reason: "corrupt" };
        }
        throw error;
      }
    }

    return { ok: false, reason: "corrupt" };
  }

  async #shallow(): Promise<ReadonlySet<string>> {
    return new Set(
      (await this.#db.select({ oid: shallowCommits.oid }).from(shallowCommits)).map(
        ({ oid }) => oid,
      ),
    );
  }

  /** Upload-pack peels an annotated tag immediately after the tag ref itself. */
  async #uploadRefs(): Promise<readonly AdvertisedRef[]> {
    const advertised: AdvertisedRef[] = [];

    for (const ref of await this.#refs()) {
      advertised.push(ref);
      if (!ref.name.startsWith("refs/tags/")) {
        continue;
      }

      const peeled = await this.#peelTag(ref.oid);
      if (peeled !== null) {
        advertised.push({ name: `${ref.name}^{}`, oid: peeled });
      }
    }

    return advertised;
  }

  async #peelTag(oid: string): Promise<string | null> {
    const visited = new Set<string>();
    let current = oid;
    let annotated = false;

    while (!visited.has(current)) {
      visited.add(current);
      const object = await this.#objects.read(current);
      if (object === null) {
        return null;
      }
      if (object.type !== "tag") {
        return annotated ? current : null;
      }

      annotated = true;
      const [target] = linksToFetch(object.type, object.bytes);
      if (target === undefined) {
        return null;
      }
      current = target.oid;
    }

    return null;
  }

  /**
   * A push that moved nothing, because we could not read far enough into it to
   * say otherwise. `refs` is empty when the failure came before any ref was
   * named, and every command when it came with the pack they all rode on.
   */
  #refuse(
    detail: string,
    capabilities: readonly string[],
    refs: readonly RefStatus[] = [],
  ): ReceivePackOutcome {
    return {
      report: receivePackResult(
        {
          unpack: detail,
          refs,
          messages: [`open-relic could not read the push: ${detail}`],
        },
        capabilities,
      ),
      accepted: false,
      retargetedTo: null,
    };
  }

  /**
   * The question that needs the objects themselves: is everything the push
   * claims actually here. `null` is a command with nothing left to object to.
   */
  async #verify(
    command: ReceivePackCommand,
    walk: WalkOptions,
  ): Promise<{ reason: string; message?: string } | null> {
    if (isDelete(command)) {
      return null;
    }

    const missing = await findMissingObject(command.newOid, this.#objects, walk);

    if (missing !== null) {
      return {
        reason: REJECTIONS.missingObjects,
        message: `${command.name} needs ${missing}, which the push did not carry.`,
      };
    }

    return null;
  }

  /**
   * HEAD follows a push only in the one case where leaving it alone is plainly
   * wrong: a repository that held no refs at all, and a push that gave it
   * exactly one branch. That is `git init && git push -u origin master` against
   * a repository created with a different default, where a HEAD naming a branch
   * nobody will ever push is a repository no clone can check out.
   *
   * Any other push leaves it alone. Which branch a repository is *for* is not
   * something a push is entitled to decide once there is anything to decide
   * between.
   */
  #retarget(
    current: ReadonlyMap<string, string>,
    updates: readonly PendingUpdate[],
  ): string | null {
    if (current.size > 0) {
      return null;
    }

    const branches = updates
      .map((update) => update.command.name)
      .filter((name) => name.startsWith(BRANCH_REF_PREFIX));

    const [only] = branches;
    if (only === undefined || branches.length > 1) {
      return null;
    }

    const branch = only.slice(BRANCH_REF_PREFIX.length);
    return formatHead(symbolicHead(branch)) === this.#kv.get(HEAD_KEY) ? null : branch;
  }

  /**
   * One transaction for every ref the push moved, and for HEAD along with them.
   * The body is synchronous because the driver is: a transaction that yielded
   * would commit before it finished, and the KV write would land in a storage
   * turn of its own rather than this one.
   */
  async #applyUpdates(
    updates: readonly PendingUpdate[],
    retargetedTo: string | null,
  ): Promise<void> {
    await this.#db.transaction((tx) => {
      for (const { command } of updates) {
        if (isDelete(command)) {
          tx.delete(refs).where(eq(refs.name, command.name)).run();
          continue;
        }

        tx.insert(refs)
          .values({ name: command.name, objectId: command.newOid })
          .onConflictDoUpdate({
            target: refs.name,
            set: { objectId: command.newOid },
          })
          .run();
      }

      if (retargetedTo !== null) {
        this.#kv.put(HEAD_KEY, formatHead(symbolicHead(retargetedTo)));
      }

      tx.update(repositoryState)
        .set({ refVersion: sql`${repositoryState.refVersion} + 1` })
        .where(eq(repositoryState.id, REPOSITORY_STATE_ID))
        .run();
    });
  }

  /**
   * Durable Objects may interleave RPC events after an await. This gate spans
   * the whole push and one sweep step, so no sweep can observe the dangerous
   * interval after object writes and before the ref transaction.
   */
  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operation;
    let release = (): void => {};
    this.#operation = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** Missing or unreadable contents read the same as a detached HEAD. */
  #defaultBranch(): string | null {
    const head = this.#head();
    return head === null ? null : headBranch(head);
  }

  #head(): Head | null {
    const contents = this.#kv.get(HEAD_KEY);
    return contents === undefined ? null : parseHead(contents);
  }
}
