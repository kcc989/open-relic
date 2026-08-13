import { ERROR_CODES } from "@open-relic/contracts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createGitTestApp, type TestApp } from "./support/app.ts";
import { errorCode } from "./support/envelope.ts";

const INFO_REFS = "http://local.test/git/acme/demo.git/info/refs";
const ADVERTISE = `${INFO_REFS}?service=git-receive-pack`;

const MAIN = "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678";
const NEXT = "abcdef0123456789abcdef0123456789abcdef01";

let harness: TestApp;

const advertise = (url = ADVERTISE, token: string | null = harness.repositoryToken) =>
  harness.app.request(
    new Request(url, token === null ? {} : { headers: { Authorization: `Bearer ${token}` } }),
  );

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

  test("does not let a token for one repository probe another", async () => {
    const live = [...harness.objects.liveIds];

    const response = await advertise(
      "http://local.test/git/acme/nope.git/info/refs?service=git-receive-pack",
    );

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(ERROR_CODES.forbidden);
    expect(harness.objects.liveIds).toEqual(live);
  });

  test("does not let a token for one namespace probe another", async () => {
    const live = [...harness.objects.liveIds];

    const response = await advertise(
      "http://local.test/git/nope/demo.git/info/refs?service=git-receive-pack",
    );

    expect(response.status).toBe(401);
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

describe("without a token", () => {
  test("refuses the request outright", async () => {
    const response = await advertise(ADVERTISE, null);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="Open Relic Git"');
    expect(await errorCode(response)).toBe(ERROR_CODES.forbidden);
  });

  test("refuses before the repository is resolved, so nothing leaks whether it exists", async () => {
    const response = await advertise(
      "http://local.test/git/acme/nope.git/info/refs?service=git-receive-pack",
      null,
    );

    expect(response.status).toBe(401);
  });
});

describe("the other services on the advertisement path", () => {
  test("advertises upload-pack refs and honestly falls back from protocol v2", async () => {
    const [durableObjectId] = harness.objects.mintedIds;
    await harness.objects.seedRefs(durableObjectId!, { "refs/heads/main": MAIN });

    const response = await harness.app.request(
      new Request(`${INFO_REFS}?service=git-upload-pack`, {
        headers: {
          Authorization: `Bearer ${harness.repositoryToken}`,
          "Git-Protocol": "version=2",
        },
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-git-upload-pack-advertisement",
    );
    expect(body).toStartWith("001e# service=git-upload-pack\n0000");
    expect(body).toContain(`${MAIN} HEAD\0`);
    expect(body).toContain(`${MAIN} refs/heads/main\n`);
    expect(body).toContain("symref=HEAD:refs/heads/main");
    expect(body).not.toContain("version 2");
  });

  test("honors an explicit protocol v1 request", async () => {
    const [durableObjectId] = harness.objects.mintedIds;
    await harness.objects.seedRefs(durableObjectId!, { "refs/heads/main": MAIN });

    const response = await harness.app.request(
      new Request(`${INFO_REFS}?service=git-upload-pack`, {
        headers: {
          Authorization: `Bearer ${harness.repositoryToken}`,
          "Git-Protocol": "version=1",
        },
      }),
    );

    expect(await response.text()).toStartWith("001e# service=git-upload-pack\n0000000eversion 1\n");
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
