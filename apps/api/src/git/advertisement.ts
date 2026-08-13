/**
 * The opening reply to a Git client over Smart HTTP: the service header, then
 * the refs we hold with our capabilities attached to the first line.
 */

import { ZERO_OID } from "../object.ts";
import { flushPkt, pktLine, pktLineStream } from "./pkt-line.ts";

export const RECEIVE_PACK_SERVICE = "git-receive-pack";

export const RECEIVE_PACK_ADVERTISEMENT_CONTENT_TYPE =
  `application/x-${RECEIVE_PACK_SERVICE}-advertisement` as const;

/** Bumped by hand; the `agent` capability is the only thing that reads it. */
export const SERVICE_VERSION = "0.1.0";

/**
 * Exactly what we honor, and nothing else — an unadvertised capability is how a
 * client learns not to use it. `no-thin` is the one that has to be said out
 * loud: without it a client may send deltas against objects it never packs.
 *
 * Deliberately absent until the work that implements them lands: `delete-refs`,
 * `atomic`, `push-options`, `report-status-v2`.
 */
export const RECEIVE_PACK_CAPABILITIES: readonly string[] = [
  "report-status",
  "side-band-64k",
  "ofs-delta",
  "no-thin",
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
