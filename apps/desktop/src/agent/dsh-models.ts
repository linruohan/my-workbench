import {
  BUILTIN_MODEL_REF,
  DSH_FREE_MODELS_URL,
  DSH_FREE_PROVIDER_ID,
  dshFreeProvider,
  dshGatewayHeaders,
  dshModelCaps,
  parseModelRef,
  selectDshFreeModels,
  type DshFreeModel,
} from "@wb/domain";
import { dshSessionFor } from "./dsh-session";
import { hostFetch } from "./host-fetch";
import { readProviderStore, writeProviderStore } from "./providers";

const CATALOG_TIMEOUT_MS = 30_000;

type FetchImpl = (
  url: string,
  init?: RequestInit & { timeoutMs?: number },
) => Promise<Response>;

let inflight: Promise<number> | null = null;

/** Read the free-lane listing and replace the DSH provider's models. */
export function refreshDshFreeModels(fetchImpl: FetchImpl = hostFetch): Promise<number> {
  if (inflight) return inflight;
  inflight = fetchDshFreeModels(fetchImpl)
    .then((found) => {
      installDshFreeModels(found);
      return found.length;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function fetchDshFreeModels(
  fetchImpl: FetchImpl = hostFetch,
): Promise<DshFreeModel[]> {
  let response: Response;
  try {
    response = await fetchImpl(DSH_FREE_MODELS_URL, {
      method: "GET",
      headers: dshGatewayHeaders(dshSessionFor("catalog"), "application/json"),
      timeoutMs: CATALOG_TIMEOUT_MS,
    });
  } catch {
    throw new Error("网络错误");
  }
  if (!response.ok) throw new Error(`模型目录返回 ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("模型目录格式无法识别");
  }
  const found = selectDshFreeModels(payload);
  if (!found.length) throw new Error("没有获取到免费模型");
  return found;
}

export function installDshFreeModels(found: readonly DshFreeModel[]): void {
  const store = readProviderStore();
  const models = dshModelCaps(found);
  const provider = dshFreeProvider(models);
  const index = store.providers.findIndex((item) => item.id === DSH_FREE_PROVIDER_ID);
  if (index < 0) store.providers.push(provider);
  else store.providers[index] = provider;
  const parsed = parseModelRef(store.defaultModelRef);
  if (parsed?.providerId === DSH_FREE_PROVIDER_ID && !models[parsed.modelId]) {
    store.defaultModelRef = BUILTIN_MODEL_REF;
  }
  writeProviderStore(store);
}
