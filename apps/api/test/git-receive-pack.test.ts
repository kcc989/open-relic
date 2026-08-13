import { ERROR_CODES, NAMESPACES_PATH } from "@open-relic/contracts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ApiEnv } from "../../../alchemy.run.ts";
import { ANONYMOUS_WRITE_VARIABLE } from "../src/git/authorization.ts";
import { REJECTIONS } from "../src/repository-store.ts";
import { createGitTestApp, type TestApp } from "./support/app.ts";
import { envelope, errorCode } from "./support/envelope.ts";
import { blob, commit, tree, treeEntry } from "./support/git-objects.ts";
import { pushBody, readReport } from "./support/receive-pack.ts";

const NAMESPACES = `http://local.test${NAMESPACES_PATH}`;
const REPO = "http://local.test/git/acme/demo.git";
const PUSH = `${REPO}/git-receive-pack`;
const ADVERTISE = `${REPO}/info/refs?service=git-receive-pack`;

const ANONYMOUS_WRITE_ALLOWED = {
  [ANONYMOUS_WRITE_VARIABLE]: "true",
} as unknown as ApiEnv;

const README = blob("Anvil firmware\n");
const ROOT = tree([treeEntry("README.md", README)]);
const FIRST = commit({ tree: ROOT, message: "First" });
const OBJECTS = [FIRST, ROOT, README];

const MAIN = "refs/heads/main";

let harness: TestApp;

beforeEach(async () => {
  harness = await createGitTestApp();
});

afterEach(() => {
  harness.close();
});

const post = (
  body: BodyInit | null,
  options: { readonly url?: string; readonly env?: ApiEnv; readonly headers?: Record<string, string> } = {},
) =>
  harness.app.request(
    new Request(options.url ?? PUSH, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-receive-pack-request",
        ...options.headers,
      },
      body,
    }),
    undefined,
    options.env ?? ANONYMOUS_WRITE_ALLOWED,
  );

const createMain = () =>
  post(pushBody({ commands: [{ newOid: FIRST.oid, name: MAIN }], objects: OBJECTS }));

const reportOf = async (response: Response) =>
  readReport(new Uint8Array(await response.arrayBuffer()));

describe("POST /git/:namespace/:repo.git/git-receive-pack", () => {
  test("creates the branch, and git ls-remote can then see it", async () => {
    const response = await createMain();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-git-receive-pack-result",
    );
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, max-age=0, must-revalidate",
    );
    expect((await reportOf(response)).lines).toEqual([
      "unpack ok",
      `ok ${MAIN}`,
    ]);

    const advertisement = await harness.app.request(
      ADVERTISE,
      undefined,
      ANONYMOUS_WRITE_ALLOWED,
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
    await post(
      pushBody({ commands: [{ oldOid: FIRST.oid, name: MAIN }] }),
    );

    const body = await envelope<{ last_push_at: string | null }>(
      await harness.app.request(`${NAMESPACES}/acme/repos/demo`),
    );

    expect(body.result?.last_push_at).toBeNull();
  });

  test("rejects a delete per-ref rather than at the HTTP layer", async () => {
    // A push that Git can talk about is answered in Git's protocol; the
    // envelope is for requests that never reached a repository.
    const response = await post(
      pushBody({ commands: [{ oldOid: FIRST.oid, name: MAIN }] }),
    );

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

  test("404s an unknown repository without waking a repository object", async () => {
    const live = [...harness.objects.liveIds];

    const response = await post(pushBody({ commands: [] }), {
      url: "http://local.test/git/acme/nope.git/git-receive-pack",
    });

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe(ERROR_CODES.notFound);
    expect(harness.objects.liveIds).toEqual(live);
  });

  test("400s a push with no body at all", async () => {
    const response = await post(null);

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(ERROR_CODES.invalidInput);
  });
});

describe("without the anonymous-write configuration", () => {
  const unconfigured = {} as ApiEnv;

  test("refuses the push", async () => {
    const response = await post(
      pushBody({
        commands: [{ newOid: FIRST.oid, name: MAIN }],
        objects: OBJECTS,
      }),
      { env: unconfigured },
    );

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe(ERROR_CODES.forbidden);
  });

  test("refuses before the repository is resolved, so nothing leaks whether it exists", async () => {
    const response = await post(pushBody({ commands: [] }), {
      env: unconfigured,
      url: "http://local.test/git/acme/nope.git/git-receive-pack",
    });

    expect(response.status).toBe(403);
  });

  test("moves no refs", async () => {
    await post(
      pushBody({
        commands: [{ newOid: FIRST.oid, name: MAIN }],
        objects: OBJECTS,
      }),
      { env: unconfigured },
    );

    const advertisement = await harness.app.request(
      ADVERTISE,
      undefined,
      ANONYMOUS_WRITE_ALLOWED,
    );
    expect(await advertisement.text()).toContain("capabilities^{}");
  });
});
