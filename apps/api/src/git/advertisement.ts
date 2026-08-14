/**
 * The opening reply to a Git client over Smart HTTP: the service header, then
 * the refs we hold with our capabilities attached to the first line.
 */

import type { Head } from "../head.ts";
import { ZERO_OID } from "../object.ts";
import { flushPkt, pktLine, pktLineStream } from "./pkt-line.ts";

export const RECEIVE_PACK_SERVICE = "git-receive-pack";

export const RECEIVE_PACK_ADVERTISEMENT_CONTENT_TYPE =
  `application/x-${RECEIVE_PACK_SERVICE}-advertisement` as const;

export const UPLOAD_PACK_SERVICE = "git-upload-pack";

export const UPLOAD_PACK_ADVERTISEMENT_CONTENT_TYPE =
  `application/x-${UPLOAD_PACK_SERVICE}-advertisement` as const;

export const UPLOAD_PACK_RESULT_CONTENT_TYPE =
  `application/x-${UPLOAD_PACK_SERVICE}-result` as const;

export type UploadProtocolVersion = 0 | 1 | 2;

/** Bumped by hand; the `agent` capability is the only thing that reads it. */
export const SERVICE_VERSION = "0.1.0";

/**
 * Exactly what we honor, and nothing else. Thin packs need no capability of
 * their own: not advertising `no-thin` lets a client delta against objects the
 * repository already holds.
 */
export const RECEIVE_PACK_CAPABILITIES: readonly string[] = [
  "report-status",
  "report-status-v2",
  "delete-refs",
  "side-band-64k",
  "atomic",
  "ofs-delta",
  "push-options",
  "object-format=sha1",
  `agent=open-relic/${SERVICE_VERSION}`,
];

/**
 * The ref name a server sends when it has no refs at all, so that a client
 * still learns the capabilities. An empty ref list would be indistinguishable
 * from a broken server.
 */
export const NO_REFS_REF_NAME = "capabilities^{}";

/** A ref as it goes on the wire: a name and the object it points at. */
export interface AdvertisedRef {
  readonly name: string;
  readonly oid: string;
}

const refLine = (ref: AdvertisedRef, capabilities?: readonly string[]): Uint8Array =>
  pktLine(
    capabilities === undefined
      ? `${ref.oid} ${ref.name}\n`
      : `${ref.oid} ${ref.name}\0${capabilities.join(" ")}\n`,
  );

/**
 * Note what is *not* here: HEAD. Git's own receive-pack advertises the ref
 * store and nothing else — HEAD belongs to the upload-pack advertisement, which
 * carries it so that a clone knows what to check out.
 *
 * Nor are annotated tags peeled. That too is upload-pack's; a pushing client
 * has no use for the tagged object's id.
 */
export function* receivePackAdvertisement(refs: readonly AdvertisedRef[]): Generator<Uint8Array> {
  // The service header is the Smart HTTP handshake: it is what tells the client
  // this is a smart server rather than a directory of files.
  yield pktLine(`# service=${RECEIVE_PACK_SERVICE}\n`);
  yield flushPkt();

  const [first, ...rest] = refs;

  if (first === undefined) {
    yield refLine({ name: NO_REFS_REF_NAME, oid: ZERO_OID }, RECEIVE_PACK_CAPABILITIES);
  } else {
    yield refLine(first, RECEIVE_PACK_CAPABILITIES);
    for (const ref of rest) {
      yield refLine(ref);
    }
  }

  yield flushPkt();
}

export const receivePackAdvertisementStream = (
  refs: readonly AdvertisedRef[],
): ReadableStream<Uint8Array> => pktLineStream(receivePackAdvertisement(refs));

export const uploadPackCapabilities = (
  head: Head | null,
  shallow: readonly string[] = [],
): readonly string[] => [
  "multi_ack_detailed",
  "thin-pack",
  "side-band-64k",
  "ofs-delta",
  ...(shallow.length === 0 ? [] : ["shallow"]),
  "object-format=sha1",
  `agent=open-relic/${SERVICE_VERSION}`,
  ...(head?.kind === "symbolic" ? [`symref=HEAD:${head.ref}`] : []),
];

/** Protocol-v2 commands and command features Open Relic actually honors. */
export const UPLOAD_PACK_V2_CAPABILITIES: readonly string[] = [
  `agent=open-relic/${SERVICE_VERSION}`,
  "ls-refs=unborn",
  "fetch",
  "object-format=sha1",
];

const uploadHeadRef = (
  refs: readonly AdvertisedRef[],
  head: Head | null,
): AdvertisedRef | undefined => {
  if (head === null) {
    return undefined;
  }

  const oid =
    head.kind === "detached"
      ? head.oid
      : refs.find((candidate) => candidate.name === head.ref)?.oid;

  return oid === undefined ? undefined : { name: "HEAD", oid };
};

/**
 * Protocol v1 adds its version marker to the original ref advertisement. V2
 * advertises commands instead; refs move to a subsequent `ls-refs` request.
 */
export function* uploadPackAdvertisement(
  refs: readonly AdvertisedRef[],
  head: Head | null,
  protocolVersion: UploadProtocolVersion,
  shallow: readonly string[] = [],
): Generator<Uint8Array> {
  if (protocolVersion === 2) {
    yield pktLine("version 2\n");
    for (const capability of UPLOAD_PACK_V2_CAPABILITIES) {
      yield pktLine(`${capability}\n`);
    }
    yield flushPkt();
    return;
  }

  yield pktLine(`# service=${UPLOAD_PACK_SERVICE}\n`);
  yield flushPkt();
  if (protocolVersion === 1) {
    yield pktLine("version 1\n");
  }

  const advertisedHead = uploadHeadRef(refs, head);
  const [first, ...rest] = advertisedHead === undefined ? refs : [advertisedHead, ...refs];
  const capabilities = uploadPackCapabilities(head, shallow);

  if (first === undefined) {
    yield refLine({ name: NO_REFS_REF_NAME, oid: ZERO_OID }, capabilities);
  } else {
    yield refLine(first, capabilities);
    for (const ref of rest) {
      yield refLine(ref);
    }
  }

  for (const oid of shallow) {
    yield pktLine(`shallow ${oid}\n`);
  }

  yield flushPkt();
}

export const uploadPackAdvertisementStream = (
  refs: readonly AdvertisedRef[],
  head: Head | null,
  protocolVersion: UploadProtocolVersion,
  shallow: readonly string[] = [],
): ReadableStream<Uint8Array> =>
  pktLineStream(uploadPackAdvertisement(refs, head, protocolVersion, shallow));
