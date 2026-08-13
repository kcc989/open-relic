import { describe, expect, test } from "bun:test";

import { tokenFromRequest } from "../src/git/authorization.ts";

const TOKEN = "art_v1_0123456789abcdef0123456789abcdef01234567?expires=1760000000";
const TOKEN_SECRET = TOKEN.split("?expires=")[0]!;
const request = (authorization?: string) =>
  new Request(
    "http://local.test/git/acme/demo.git/info/refs",
    authorization === undefined ? {} : { headers: { Authorization: authorization } },
  );

describe("Git token presentation", () => {
  test("reads a bearer token", () => {
    expect(tokenFromRequest(request(`Bearer ${TOKEN}`))).toBe(TOKEN);
  });

  test("reads the token as an HTTP Basic password", () => {
    expect(tokenFromRequest(request(`Basic ${btoa(`x:${TOKEN_SECRET}`)}`))).toBe(TOKEN_SECRET);
  });

  test("allows a different Basic username because the password is the credential", () => {
    expect(tokenFromRequest(request(`Basic ${btoa(`git:${TOKEN_SECRET}`)}`))).toBe(TOKEN_SECRET);
  });

  for (const [label, authorization] of [
    ["no authorization", undefined],
    ["another scheme", `Digest ${TOKEN}`],
    ["malformed Basic", "Basic not-base64!"],
    ["Basic without a password", `Basic ${btoa("x")}`],
    ["Basic without a username", `Basic ${btoa(`:${TOKEN_SECRET}`)}`],
  ] as const) {
    test(`refuses ${label}`, () => {
      expect(tokenFromRequest(request(authorization))).toBeNull();
    });
  }
});
