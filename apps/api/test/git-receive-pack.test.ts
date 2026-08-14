import {
  ERROR_CODES,
  NAMESPACES_PATH,
  type CreateRepoResult,
  type CreateTokenResult,
  type TokenScope,
} from "@open-relic/contracts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { REJECTIONS } from "../src/repository-store.ts";
import { createGitTestApp, type TestApp } from "./support/app.ts";
import { envelope, errorCode, result } from "./support/envelope.ts";
import { blob, commit, tree, treeEntry } from "./support/git-objects.ts";
import { pushBody, readReport } from "./support/receive-pack.ts";

const NAMESPACES = `http://local.test${NAMESPACES_PATH}`;
const REPO = "http://local.test/git/acme/demo.git";
const PUSH = `${REPO}/git-receive-pack`;
const ADVERTISE = `${REPO}/info/refs?service=git-receive-pack`;

const README = blob("Anvil firmware\n");
const ROOT = tree([treeEntry("README.md", README)]);
const FIRST = commit({ tree: ROOT, message: "First" });
const OBJECTS = [FIRST, ROOT, README];

const MAIN = "refs/heads/main";

let harness: TestApp;
let now: Date;

beforeEach(async () => {
  now = new Date("2026-08-13T12:00:00.000Z");
  harness = await createGitTestApp({}, () => now);
});

afterEach(() => {
  harness.close();
});

const post = (
  body: BodyInit | null,
  options: {
    readonly url?: string;
    readonly token?: string | null;
    readonly headers?: Record<string, string>;
  } = {},
) => {
  const token = options.token === undefined ? harness.repositoryToken : options.token;
  const headers = new Headers({
    "Content-Type": "application/x-git-receive-pack-request",
  });
  if (token !== null) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }
  return harness.app.request(
    new Request(options.url ?? PUSH, {
      method: "POST",
      headers,
      body,
    }),
  );
};

const createMain = () =>
  post(pushBody({ commands: [{ newOid: FIRST.oid, name: MAIN }], objects: OBJECTS }));

const reportOf = async (response: Response) =>
  readReport(new Uint8Array(await response.arrayBuffer()));

describe("POST /git/:namespace/:repo.git/git-receive-pack", () => {
  test("creates the branch, and git ls-remote can then see it", async () => {
    const response = await createMain();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-git-receive-pack-result");
    expect(response.headers.get("cache-control")).toBe("no-cache, max-age=0, must-revalidate");
    expect((await reportOf(response)).lines).toEqual(["unpack ok", `ok ${MAIN}`]);

    const advertisement = await harness.app.request(
      new Request(ADVERTISE, {
        headers: { Authorization: `Bearer ${harness.repositoryToken}` },
      }),
    );
    expect(await advertisement.text()).toContain(`${FIRST.oid} ${MAIN}\0`);
  });

  test("stamps the push onto the repository the REST surface reports", async () => {
    await createMain();

    const body = await envelope<{ last_push_at: string | null }>(
      await harness.app.request(`${NAMESPACES}/acme/repos/demo`),
    );

    expect(body.result?.last_push_at).not.toBeNull();
  });

  test("follows HEAD when a push retargets it, so both halves agree", async () => {
    await post(
      pushBody({
        commands: [{ newOid: FIRST.oid, name: "refs/heads/master" }],
        objects: OBJECTS,
      }),
    );

    const body = await envelope<{ default_branch: string }>(
      await harness.app.request(`${NAMESPACES}/acme/repos/demo`),
    );

    expect(body.result?.default_branch).toBe("master");
  });

  test("leaves the index alone when nothing was accepted", async () => {
    await post(pushBody({ commands: [{ oldOid: FIRST.oid, name: MAIN }] }));

    const body = await envelope<{ last_push_at: string | null }>(
      await harness.app.request(`${NAMESPACES}/acme/repos/demo`),
    );

    expect(body.result?.last_push_at).toBeNull();
  });

  test("rejects a delete per-ref rather than at the HTTP layer", async () => {
    // A push that Git can talk about is answered in Git's protocol; the
    // envelope is for requests that never reached a repository.
    const response = await post(pushBody({ commands: [{ oldOid: FIRST.oid, name: MAIN }] }));

    expect(response.status).toBe(200);
    expect((await reportOf(response)).lines).toEqual([
      "unpack ok",
      `ng ${MAIN} ${REJECTIONS.delete}`,
    ]);
  });

  test("refuses a read-only repository, which is what that flag is for", async () => {
    harness.close();
    harness = await createGitTestApp({ read_only: true });

    const response = await post(
      pushBody({
        commands: [{ newOid: FIRST.oid, name: MAIN }],
        objects: OBJECTS,
      }),
    );

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe(ERROR_CODES.forbidden);
  });

  test("does not let a token for one repository probe another", async () => {
    const live = [...harness.objects.liveIds];

    const response = await post(pushBody({ commands: [] }), {
      url: "http://local.test/git/acme/nope.git/git-receive-pack",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="Open Relic Git"');
    expect(await errorCode(response)).toBe(ERROR_CODES.forbidden);
    expect(harness.objects.liveIds).toEqual(live);
  });

  test("400s a push with no body at all", async () => {
    const response = await post(null);

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(ERROR_CODES.invalidInput);
  });
});

describe("repository-scoped Git token authorization", () => {
  const createToken = async (scope: TokenScope, ttl = 3600): Promise<CreateTokenResult> =>
    result<CreateTokenResult>(
      await harness.app.request(
        new Request(`${NAMESPACES}/acme/tokens`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: "demo", scope, ttl }),
        }),
      ),
    );

  test("refuses the push", async () => {
    const response = await post(
      pushBody({
        commands: [{ newOid: FIRST.oid, name: MAIN }],
        objects: OBJECTS,
      }),
      { token: null },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="Open Relic Git"');
    expect(await errorCode(response)).toBe(ERROR_CODES.forbidden);
  });

  test("refuses before the repository is resolved, so nothing leaks whether it exists", async () => {
    const response = await post(pushBody({ commands: [] }), {
      token: null,
      url: "http://local.test/git/acme/nope.git/git-receive-pack",
    });

    expect(response.status).toBe(401);
  });

  test("moves no refs", async () => {
    await post(
      pushBody({
        commands: [{ newOid: FIRST.oid, name: MAIN }],
        objects: OBJECTS,
      }),
      { token: null },
    );

    const advertisement = await harness.app.request(
      new Request(ADVERTISE, {
        headers: { Authorization: `Bearer ${harness.repositoryToken}` },
      }),
    );
    expect(await advertisement.text()).toContain("capabilities^{}");
  });

  test("refuses a read-scoped token", async () => {
    const token = await createToken("read");

    const response = await post(pushBody({ commands: [] }), { token: token.plaintext });

    expect(response.status).toBe(401);
  });

  test("refuses an expired token", async () => {
    const token = await createToken("write", 60);
    now = new Date(now.getTime() + 61_000);

    const response = await post(pushBody({ commands: [] }), { token: token.plaintext });

    expect(response.status).toBe(401);
  });

  test("refuses a revoked token", async () => {
    const token = await createToken("write");
    await harness.app.request(
      new Request(`${NAMESPACES}/acme/tokens/${token.id}`, { method: "DELETE" }),
    );

    const response = await post(pushBody({ commands: [] }), { token: token.plaintext });

    expect(response.status).toBe(401);
  });

  test("refuses a valid token scoped to another repository", async () => {
    const other = await result<CreateRepoResult>(
      await harness.app.request(
        new Request(`${NAMESPACES}/acme/repos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "other" }),
        }),
      ),
    );

    const response = await post(pushBody({ commands: [] }), { token: other.token });

    expect(response.status).toBe(401);
  });

  test("accepts the token as an HTTP Basic password", async () => {
    const response = await post(
      pushBody({ commands: [{ newOid: FIRST.oid, name: MAIN }], objects: OBJECTS }),
      {
        token: null,
        headers: {
          Authorization: `Basic ${btoa(`x:${harness.repositoryToken?.split("?expires=")[0]}`)}`,
        },
      },
    );

    expect(response.status).toBe(200);
    expect((await reportOf(response)).lines).toEqual(["unpack ok", `ok ${MAIN}`]);
  });
});
