import { ERROR_CODES } from "@open-relic/contracts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ApiEnv } from "../../../alchemy.run.ts";
import { ANONYMOUS_WRITE_VARIABLE } from "../src/git/authorization.ts";
import { createGitTestApp, type TestApp } from "./support/app.ts";
import { errorCode } from "./support/envelope.ts";

const INFO_REFS = "http://local.test/git/acme/demo.git/info/refs";
const ADVERTISE = `${INFO_REFS}?service=git-receive-pack`;

// SAFETY: these tests only read ALLOW_ANONYMOUS_WRITE from the Worker env.
const ANONYMOUS_WRITE_ALLOWED = {
  [ANONYMOUS_WRITE_VARIABLE]: "true",
} as ApiEnv;

const MAIN = "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678";
const NEXT = "abcdef0123456789abcdef0123456789abcdef01";

let harness: TestApp;

const advertise = (url = ADVERTISE, env: ApiEnv = ANONYMOUS_WRITE_ALLOWED) =>
  harness.app.request(url, undefined, env);

beforeEach(async () => {
  harness = await createGitTestApp();
});

afterEach(() => {
  harness.close();
});

describe("GET /git/:namespace/:repo.git/info/refs?service=git-receive-pack", () => {
  test("answers a freshly created repository with the zero-id capabilities line", async () => {
    const response = await advertise();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-git-receive-pack-advertisement",
    );
    expect(response.headers.get("cache-control")).toBe("no-cache, max-age=0, must-revalidate");
    expect(await response.text()).toBe(
      "001f# service=git-receive-pack\n" +
        "0000" +
        "0095" +
        `${"0".repeat(40)} capabilities^{}\0` +
        "report-status side-band-64k ofs-delta no-thin object-format=sha1 agent=open-relic/0.1.0\n" +
        "0000",
    );
  });

  test("lists the repository's refs, in name order, capabilities on the first", async () => {
    const [durableObjectId] = harness.objects.mintedIds;
    await harness.objects.seedRefs(durableObjectId!, {
      "refs/heads/next": NEXT,
      "refs/heads/main": MAIN,
    });

    const body = await (await advertise()).text();

    expect(body).toBe(
      "001f# service=git-receive-pack\n" +
        "0000" +
        "0095" +
        `${MAIN} refs/heads/main\0` +
        "report-status side-band-64k ofs-delta no-thin object-format=sha1 agent=open-relic/0.1.0\n" +
        "003d" +
        `${NEXT} refs/heads/next\n` +
        "0000",
    );
  });

  test("404s an unknown repository without waking a repository object", async () => {
    const live = [...harness.objects.liveIds];

    const response = await advertise(
      "http://local.test/git/acme/nope.git/info/refs?service=git-receive-pack",
    );

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe(ERROR_CODES.notFound);
    expect(harness.objects.liveIds).toEqual(live);
  });

  test("404s an unknown namespace without waking a repository object", async () => {
    const live = [...harness.objects.liveIds];

    const response = await advertise(
      "http://local.test/git/nope/demo.git/info/refs?service=git-receive-pack",
    );

    expect(response.status).toBe(404);
    expect(harness.objects.liveIds).toEqual(live);
  });

  test("404s a URL without the .git suffix", async () => {
    const response = await advertise(
      "http://local.test/git/acme/demo/info/refs?service=git-receive-pack",
    );

    // The route does not match at all: a repository has one clone URL, and the
    // suffix-less spelling is not it.
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe(ERROR_CODES.notFound);
  });
});

describe("without the anonymous-write configuration", () => {
  // SAFETY: a Worker deployed without the binding has an empty env object at runtime.
  const unconfigured = {} as ApiEnv;

  test("refuses the request outright", async () => {
    const response = await advertise(ADVERTISE, unconfigured);

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe(ERROR_CODES.forbidden);
  });

  test("refuses before the repository is resolved, so nothing leaks whether it exists", async () => {
    const response = await advertise(
      "http://local.test/git/acme/nope.git/info/refs?service=git-receive-pack",
      unconfigured,
    );

    expect(response.status).toBe(403);
  });
});

describe("the other services on the advertisement path", () => {
  test("upload-pack is still a stub", async () => {
    const response = await advertise(`${INFO_REFS}?service=git-upload-pack`);

    expect(response.status).toBe(501);
    expect(await errorCode(response)).toBe(ERROR_CODES.notImplemented);
  });

  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["no service at all", INFO_REFS],
    ["a service we do not speak", `${INFO_REFS}?service=git-archive`],
    ["an empty service", `${INFO_REFS}?service=`],
  ];

  for (const [label, url] of rejected) {
    test(`400s ${label}`, async () => {
      const response = await advertise(url);

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe(ERROR_CODES.invalidInput);
    });
  }
});
