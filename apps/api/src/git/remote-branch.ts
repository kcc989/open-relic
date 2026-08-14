import { validateBranchName } from "@open-relic/contracts";

import { concat } from "../bytes.ts";
import { isObjectId } from "../object.ts";
import { PktLineError, PktLineReader, flushPkt, pktLine } from "./pkt-line.ts";

const decoder = new TextDecoder();

const UPLOAD_PACK_SERVICE = "git-upload-pack";
const ADVERTISEMENT_CONTENT_TYPE = `application/x-${UPLOAD_PACK_SERVICE}-advertisement`;
const RESULT_CONTENT_TYPE = `application/x-${UPLOAD_PACK_SERVICE}-result`;
const BRANCH_REF_PREFIX = "refs/heads/";
/** Git treats this signed 32-bit maximum as infinite depth. */
const INFINITE_DEPTH = 0x7fffffff;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

export type RemoteFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RemoteBranchRequest {
  readonly url: string;
  readonly branch?: string;
  readonly depth?: number;
}

export interface FetchedRemoteBranch {
  readonly branch: string;
  readonly oid: string;
  readonly shallow: readonly string[];
  readonly pack: ReadableStream<Uint8Array>;
}

export class RemoteBranchError extends Error {
  readonly code:
    | "invalid-url"
    | "invalid-depth"
    | "branch-not-found"
    | "invalid-advertisement"
    | "upstream-unavailable";

  constructor(code: RemoteBranchError["code"], message: string) {
    super(message);
    this.name = "RemoteBranchError";
    this.code = code;
  }
}

interface Advertisement {
  readonly refs: ReadonlyMap<string, string>;
  readonly capabilities: ReadonlySet<string>;
  readonly shallow: readonly string[];
}

interface SelectedBranch {
  readonly branch: string;
  readonly oid: string;
}

const remoteUrl = (value: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RemoteBranchError("invalid-url", "The remote URL is invalid.");
  }

  if (parsed.protocol !== "https:") {
    throw new RemoteBranchError("invalid-url", "The remote must use HTTPS.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new RemoteBranchError("invalid-url", "The remote URL must not contain user information.");
  }
  if (!isPublicHost(parsed.hostname)) {
    throw new RemoteBranchError("invalid-url", "The remote URL must name a public host.");
  }
  return parsed;
};

const ipv4Octets = (hostname: string): readonly number[] | null => {
  const pieces = hostname.split(".");
  if (pieces.length !== 4 || pieces.some((piece) => !/^\d{1,3}$/.test(piece))) {
    return null;
  }
  const octets = pieces.map(Number);
  return octets.some((octet) => octet > 255) ? null : octets;
};

const publicIpv4 = (octets: readonly number[]): boolean => {
  const first = octets[0]!;
  const second = octets[1]!;
  return (
    first !== 0 &&
    first !== 10 &&
    first !== 127 &&
    !(first === 169 && second === 254) &&
    !(first === 172 && second >= 16 && second <= 31) &&
    !(first === 192 && second === 168)
  );
};

const ipv6Words = (hostname: string): readonly number[] | null => {
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (!bare.includes(":")) return null;

  const halves = bare.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  if ([...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [
    ...left.map((word) => Number.parseInt(word, 16)),
    ...Array(missing).fill(0),
    ...right.map((word) => Number.parseInt(word, 16)),
  ];
};

const publicIpv6 = (words: readonly number[]): boolean => {
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const uniqueLocal = (words[0]! & 0xfe00) === 0xfc00;
  const linkLocal = (words[0]! & 0xffc0) === 0xfe80;
  const mappedIpv4 =
    words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
      ? [words[6]! >>> 8, words[6]! & 0xff, words[7]! >>> 8, words[7]! & 0xff]
      : null;

  return (
    !allZero &&
    !loopback &&
    !uniqueLocal &&
    !linkLocal &&
    (mappedIpv4 === null || publicIpv4(mappedIpv4))
  );
};

const isPublicHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return false;
  const ipv4 = ipv4Octets(normalized);
  if (ipv4 !== null) return publicIpv4(ipv4);
  const ipv6 = ipv6Words(normalized);
  return ipv6 === null || publicIpv6(ipv6);
};

const fetchWithRedirects = async (
  initial: URL,
  init: RequestInit,
  fetchRemote: RemoteFetch,
): Promise<Response> => {
  let current = initial;

  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      response = await fetchRemote(current, {
        ...init,
        credentials: "omit",
        redirect: "manual",
      });
    } catch {
      // A platform fetch error may include the complete URL. Its query is
      // sensitive, so replace it rather than allowing it to reach a caller's log.
      throw new RemoteBranchError("upstream-unavailable", "The Git remote could not be reached.");
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new RemoteBranchError(
        "upstream-unavailable",
        "The Git remote redirected too many times.",
      );
    }

    const location = response.headers.get("Location");
    if (location === null) {
      throw new RemoteBranchError(
        "upstream-unavailable",
        "The Git remote sent an invalid redirect.",
      );
    }

    let redirected: URL;
    try {
      redirected = new URL(location, current);
    } catch {
      throw new RemoteBranchError(
        "upstream-unavailable",
        "The Git remote sent an invalid redirect.",
      );
    }
    current = remoteUrl(redirected.toString());
  }
};

const endpoint = (remote: URL, path: "/info/refs" | "/git-upload-pack"): URL => {
  const result = new URL(remote);
  result.pathname = `${result.pathname.replace(/\/$/, "")}${path}`;
  if (path === "/info/refs") {
    result.searchParams.set("service", UPLOAD_PACK_SERVICE);
  }
  return result;
};

const requireResponse = (response: Response, contentType: string): ReadableStream<Uint8Array> => {
  if (!response.ok || response.body === null) {
    throw new RemoteBranchError("upstream-unavailable", "The Git remote did not answer.");
  }

  const actual = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (actual !== contentType) {
    throw new RemoteBranchError(
      "invalid-advertisement",
      "The remote did not answer with Git Smart HTTP.",
    );
  }

  return response.body;
};

const lineText = (payload: Uint8Array): string => decoder.decode(payload).replace(/\n$/, "");

const readAdvertisement = async (body: ReadableStream<Uint8Array>): Promise<Advertisement> => {
  const lines = new PktLineReader(body);
  const refs = new Map<string, string>();
  const capabilities = new Set<string>();
  const shallow: string[] = [];

  try {
    const service = await lines.next();
    if (
      service.kind !== "line" ||
      lineText(service.payload) !== `# service=${UPLOAD_PACK_SERVICE}`
    ) {
      throw new RemoteBranchError(
        "invalid-advertisement",
        "The remote sent an invalid upload-pack service header.",
      );
    }
    if ((await lines.next()).kind !== "flush") {
      throw new RemoteBranchError(
        "invalid-advertisement",
        "The remote sent an invalid upload-pack advertisement.",
      );
    }

    let first = true;
    let pending = await lines.next();
    if (pending.kind === "line" && lineText(pending.payload) === "version 1") {
      pending = await lines.next();
    }
    for (;;) {
      const line = pending;
      if (line.kind === "flush") {
        break;
      }
      if (line.kind !== "line") {
        throw new RemoteBranchError(
          "invalid-advertisement",
          "The remote ended its upload-pack advertisement early.",
        );
      }

      const text = lineText(line.payload);
      const nul = first ? text.indexOf("\0") : -1;
      const refText = nul === -1 ? text : text.slice(0, nul);
      if (nul !== -1) {
        for (const capability of text.slice(nul + 1).split(" ")) {
          if (capability !== "") capabilities.add(capability);
        }
      }
      first = false;

      const shallowMatch = /^shallow ([0-9a-f]{40})$/.exec(refText);
      if (shallowMatch !== null && isObjectId(shallowMatch[1]!)) {
        shallow.push(shallowMatch[1]!);
        pending = await lines.next();
        continue;
      }

      const match = /^([0-9a-f]{40}) (\S+)$/.exec(refText);
      if (match === null || !isObjectId(match[1]!)) {
        throw new RemoteBranchError(
          "invalid-advertisement",
          "The remote advertised an invalid ref.",
        );
      }
      refs.set(match[2]!, match[1]!);
      pending = await lines.next();
    }
  } catch (error) {
    await lines.cancel();
    if (error instanceof PktLineError) {
      throw new RemoteBranchError("invalid-advertisement", error.message);
    }
    throw error;
  }

  return { refs, capabilities, shallow: [...new Set(shallow)] };
};

const selectBranch = (
  advertisement: Advertisement,
  requested: string | undefined,
): SelectedBranch => {
  let branch = requested;
  if (branch !== undefined && validateBranchName(branch) !== null) {
    throw new RemoteBranchError("branch-not-found", "The requested branch name is invalid.");
  }
  if (branch === undefined) {
    const symref = [...advertisement.capabilities].find((value) =>
      value.startsWith("symref=HEAD:refs/heads/"),
    );
    branch = symref?.slice("symref=HEAD:refs/heads/".length);

    if (branch === undefined) {
      const head = advertisement.refs.get("HEAD");
      if (head !== undefined) {
        branch = [...advertisement.refs]
          .find(([name, oid]) => name.startsWith(BRANCH_REF_PREFIX) && oid === head)?.[0]
          .slice(BRANCH_REF_PREFIX.length);
      }
    }
  }

  const oid =
    branch === undefined ? undefined : advertisement.refs.get(`${BRANCH_REF_PREFIX}${branch}`);
  if (branch !== undefined && validateBranchName(branch) !== null) {
    throw new RemoteBranchError(
      "invalid-advertisement",
      "The remote advertised an invalid default branch.",
    );
  }
  if (branch === undefined || oid === undefined) {
    throw new RemoteBranchError(
      "branch-not-found",
      requested === undefined
        ? "The remote does not advertise a default branch."
        : "The requested branch does not exist on the remote.",
    );
  }

  return { branch, oid } satisfies SelectedBranch;
};

const negotiationBody = (
  oid: string,
  capabilities: ReadonlySet<string>,
  depth: number | undefined,
): Uint8Array => {
  const selected = ["ofs-delta"].filter((capability) => capabilities.has(capability));
  return concat(
    pktLine(`want ${oid}${selected.length === 0 ? "" : ` ${selected.join(" ")}`}\n`),
    ...(depth === undefined ? [] : [pktLine(`deepen ${Math.min(depth, INFINITE_DEPTH)}\n`)]),
    flushPkt(),
    pktLine("done\n"),
  );
};

const exactBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

const readPackResponse = async (
  body: ReadableStream<Uint8Array>,
  shallowRequested: boolean,
): Promise<{ readonly shallow: readonly string[]; readonly pack: ReadableStream<Uint8Array> }> => {
  const lines = new PktLineReader(body);
  try {
    const shallow: string[] = [];
    if (shallowRequested) {
      for (;;) {
        const update = await lines.next();
        if (update.kind === "flush") {
          break;
        }
        if (update.kind !== "line") {
          throw new RemoteBranchError(
            "invalid-advertisement",
            "The remote ended its shallow update early.",
          );
        }

        const match = /^shallow ([0-9a-f]{40})$/.exec(lineText(update.payload));
        if (match === null || !isObjectId(match[1]!)) {
          throw new RemoteBranchError(
            "invalid-advertisement",
            "The remote sent an invalid shallow boundary.",
          );
        }
        shallow.push(match[1]!);
      }
    }

    const acknowledgement = await lines.next();
    if (acknowledgement.kind !== "line" || lineText(acknowledgement.payload) !== "NAK") {
      throw new RemoteBranchError(
        "invalid-advertisement",
        "The remote sent an invalid upload-pack result.",
      );
    }
    return { shallow, pack: lines.rest() };
  } catch (error) {
    await lines.cancel();
    if (error instanceof PktLineError) {
      throw new RemoteBranchError("invalid-advertisement", error.message);
    }
    throw error;
  }
};

export const fetchRemoteBranch = async (
  request: RemoteBranchRequest,
  fetchRemote: RemoteFetch = globalThis.fetch,
): Promise<FetchedRemoteBranch> => {
  const remote = remoteUrl(request.url);
  if (request.depth !== undefined && (!Number.isSafeInteger(request.depth) || request.depth < 1)) {
    throw new RemoteBranchError("invalid-depth", "The depth must be a positive integer.");
  }
  if (request.branch !== undefined && validateBranchName(request.branch) !== null) {
    throw new RemoteBranchError("branch-not-found", "The requested branch name is invalid.");
  }
  const advertised = await fetchWithRedirects(
    endpoint(remote, "/info/refs"),
    {
      method: "GET",
      headers: { Accept: ADVERTISEMENT_CONTENT_TYPE, "Git-Protocol": "version=1" },
    },
    fetchRemote,
  );
  const advertisement = await readAdvertisement(
    requireResponse(advertised, ADVERTISEMENT_CONTENT_TYPE),
  );
  if (request.depth !== undefined && !advertisement.capabilities.has("shallow")) {
    throw new RemoteBranchError(
      "invalid-advertisement",
      "The remote does not support shallow fetches.",
    );
  }
  const selected = selectBranch(advertisement, request.branch);
  const negotiation = negotiationBody(selected.oid, advertisement.capabilities, request.depth);

  const uploaded = await fetchWithRedirects(
    endpoint(remote, "/git-upload-pack"),
    {
      method: "POST",
      headers: {
        Accept: RESULT_CONTENT_TYPE,
        "Content-Type": "application/x-git-upload-pack-request",
      },
      body: exactBuffer(negotiation),
    },
    fetchRemote,
  );
  const result = await readPackResponse(
    requireResponse(uploaded, RESULT_CONTENT_TYPE),
    request.depth !== undefined,
  );

  return {
    ...selected,
    shallow: request.depth === undefined ? advertisement.shallow : result.shallow,
    pack: result.pack,
  };
};
