import { describe, expect, test } from "bun:test";

import {
  RECEIVE_PACK_CAPABILITIES,
  receivePackAdvertisement,
  receivePackAdvertisementStream,
  type AdvertisedRef,
} from "../src/git/advertisement.ts";
import { ZERO_OID } from "../src/object.ts";

const decoder = new TextDecoder();

const advertise = (refs: readonly AdvertisedRef[]): string =>
  [...receivePackAdvertisement(refs)].map((line) => decoder.decode(line)).join("");

const MAIN = "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678";
const TAG = "abcdef0123456789abcdef0123456789abcdef01";

describe("the receive-pack advertisement", () => {
  test("opens with the service header and a flush", () => {
    expect(advertise([])).toStartWith("001f# service=git-receive-pack\n0000");
  });

  test("is the zero-id capabilities line when the repository has no refs", () => {
    // Written out rather than assembled from the same constants the encoder
    // uses: this is the byte-for-byte advertisement a freshly created
    // repository sends, and an empty body would leave a client unable to tell
    // it from a server that failed to answer.
    expect(advertise([])).toBe(
      "001f# service=git-receive-pack\n" +
        "0000" +
        "0095" +
        `${ZERO_OID} capabilities^{}\0` +
        "report-status side-band-64k ofs-delta no-thin object-format=sha1 agent=open-relic/0.1.0\n" +
        "0000",
    );
  });

  test("advertises exactly the capabilities we honor", () => {
    expect(RECEIVE_PACK_CAPABILITIES).toEqual([
      "report-status",
      "side-band-64k",
      "ofs-delta",
      "no-thin",
      "object-format=sha1",
      "agent=open-relic/0.1.0",
    ]);
  });

  test("hangs the capabilities off the first ref line and nothing else", () => {
    const body = advertise([
      { name: "refs/heads/main", oid: MAIN },
      { name: "refs/tags/v1", oid: TAG },
    ]);

    expect(body).toContain(`${MAIN} refs/heads/main\0${RECEIVE_PACK_CAPABILITIES.join(" ")}\n`);
    expect(body).toContain(`${TAG} refs/tags/v1\n`);
    expect(body).not.toContain("capabilities^{}");
    // One NUL in the whole advertisement: the capabilities separator.
    expect(body.split("\0")).toHaveLength(2);
  });

  test("ends with a flush", () => {
    expect(advertise([{ name: "refs/heads/main", oid: MAIN }])).toEndWith("0000");
  });

  test("streams the same bytes it generates", async () => {
    const refs = [{ name: "refs/heads/main", oid: MAIN }];

    expect(await new Response(receivePackAdvertisementStream(refs)).text()).toBe(advertise(refs));
  });
});
