// suiChain.mjs — Sui on-chain ownership + signature verification.
// Ported from voxxstake/backend/src/services/sui.ts (same @mysten/sui transport
// layer: gRPC primary + GraphQL fallback). No MongoDB/Express dependency so it
// drop-in works inside voss's plain Node server.mjs.
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeStructTag } from "@mysten/sui/utils";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";

// VOXX NFT object type — copied verbatim from voxxstake types/index.ts.
export const VOXX_TYPE =
  "0xdca282f30ff2acc0083c5c90969ae97c59a638a6a50ab9112f7ea17507cdd2b7::voxx__inc_::Nft";

const suiNetwork = (process.env.SUI_NETWORK || "mainnet").toLowerCase();
const defaultGrpc =
  suiNetwork === "mainnet"
    ? "https://sui.grpc.ankr.com:443"
    : `https://fullnode.${suiNetwork}.sui.io:443`;
const configuredGrpc = (process.env.SUI_GRPC_URL || "").trim();
const grpcUrl = configuredGrpc || defaultGrpc;
const graphqlUrl =
  process.env.SUI_GRAPHQL_URL || `https://graphql.${suiNetwork}.sui.io/graphql`;

const GRAPHQL_CLIENT = new SuiGraphQLClient({ url: graphqlUrl, network: suiNetwork });
const DATA_CLIENTS = [
  { label: `gRPC ${grpcUrl}`, client: new SuiGrpcClient({ baseUrl: grpcUrl, network: suiNetwork }) },
  { label: `GraphQL ${graphqlUrl}`, client: GRAPHQL_CLIENT },
];
const grpcDisabledUntil = new Map();
const GRPC_FAILURE_COOLDOWN_MS = 60_000;

function fromBase64(value) {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

async function withDataFailover(operation) {
  let lastError = null;
  for (let i = 0; i < DATA_CLIENTS.length; i += 1) {
    if ((grpcDisabledUntil.get(i) || 0) > Date.now()) continue;
    const endpoint = DATA_CLIENTS[i];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      let timeoutId;
      try {
        const timeout = new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort();
            reject(new Error(`Sui data timeout after 15000ms: ${endpoint.label}`));
          }, 15000);
        });
        const result = await Promise.race([
          operation(endpoint.client, controller.signal),
          timeout,
        ]);
        grpcDisabledUntil.delete(i);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, Math.min(250 * 2 ** (attempt - 1), 2000)));
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }
    if (i < DATA_CLIENTS.length - 1) {
      grpcDisabledUntil.set(i, Date.now() + GRPC_FAILURE_COOLDOWN_MS);
    }
  }
  throw lastError || new Error("All Sui data endpoints failed");
}

// gRPC Core exposes Move JSON at `json` and Display data at `display.output`.
function wrapGrpcObject(object) {
  const display = object.display || null;
  return {
    data: {
      objectId: object.objectId,
      type: object.type,
      owner: object.owner,
      display: { data: display?.output || null },
      content: { fields: object.json || {} },
    },
  };
}

export function extractImageUrl(objData) {
  if (!objData) return null;
  const displayData = objData.display?.data || {};
  if (displayData.image_url) {
    const url = String(displayData.image_url);
    return url.startsWith("ipfs://")
      ? url.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/")
      : url;
  }
  const fields = objData.content?.fields || {};
  for (const f of ["media_url", "url", "image_url"]) {
    if (fields[f]) {
      const url = String(fields[f]);
      return url.startsWith("ipfs://")
        ? url.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/")
        : url;
    }
  }
  return null;
}

export function extractNftName(objData, objectId) {
  if (!objData) return `VOXX #${objectId.slice(-6)}`;
  const displayData = objData.display?.data || {};
  if (displayData.name) return String(displayData.name);
  const fields = objData.content?.fields || {};
  if (fields.name) return String(fields.name);
  return `VOXX #${objectId.slice(-6)}`;
}

async function getDirectlyOwnedObjects(address, typeFilter) {
  const all = [];
  let cursor = null;
  while (true) {
    const result = await withDataFailover((client, signal) =>
      client.core.listOwnedObjects({
        owner: address,
        type: typeFilter,
        cursor: cursor || undefined,
        include: { json: true, display: true },
        signal,
      })
    );
    for (const object of result.objects || []) {
      all.push(wrapGrpcObject(object));
    }
    if (!result.hasNextPage || !result.cursor) break;
    cursor = result.cursor;
  }
  return all;
}

export async function getOwnedVoxxNfts(address) {
  const objects = await getDirectlyOwnedObjects(address, VOXX_TYPE);
  const seen = new Set();
  const out = [];
  for (const object of objects) {
    const data = object.data || {};
    const objectId = data.objectId;
    if (!objectId || seen.has(objectId)) continue;
    seen.add(objectId);
    out.push({
      object_id: objectId,
      name: extractNftName(data, objectId),
      image_url: extractImageUrl(data),
    });
  }
  return out;
}

const ZKLOGIN_FLAG = 0x05;

// Verify a Sui personal-message signature. Mirrors voxxstake verifySignature.
export async function verifySignature(address, _nonce, signatureB64, bytesB64) {
  try {
    const signatureBytes = fromBase64(signatureB64);
    const messageBytes = fromBase64(bytesB64);
    const isZkLogin = signatureBytes.length > 0 && signatureBytes[0] === ZKLOGIN_FLAG;
    await verifyPersonalMessageSignature(messageBytes, signatureB64, {
      address,
      ...(isZkLogin ? { client: GRAPHQL_CLIENT } : {}),
    });
    return true;
  } catch (error) {
    console.error(
      "Signature verification failed:",
      error instanceof Error ? error.message : error
    );
    return false;
  }
}
