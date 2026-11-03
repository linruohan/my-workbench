import {
  BUILTIN_MODEL_REF,
  BUILTIN_PROVIDER_ID,
  mergeBuiltinModels,
  parseModelRef,
  selectOcFreeModels,
  OC_FREE_MODELS_URL,
  type OcFreeModel,
} from "@wb/domain";
import { hostFetch } from "./host-fetch";
import { readProviderStore, writeProviderStore } from "./providers";

const CATALOG_TIMEOUT_MS = 30_000;

type FetchImpl = (
  url: string,
  init?: RequestInit & { timeoutMs?: number },
) => Promise<Response>;

let inflight: Promise<number> | null = null;

/** Read the OpenCode catalog and replace the builtin provider's free models. */
export function refreshOcFreeModels(fetchImpl: FetchImpl = hostFetch): Promise<number> {
  if (inflight) return inflight;
  inflight = fetchOcFreeModels(fetchImpl)
    .then((found) => {
      installOcFreeModels(found);
      return found.length;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function fetchOcFreeModels(
  fetchImpl: FetchImpl = hostFetch,
): Promise<OcFreeModel[]> {
  let response: Response;
  try {
    response = await fetchImpl(OC_FREE_MODELS_URL, {
      method: "GET",
      headers: { accept: "application/json" },
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
  const found = selectOcFreeModels(payload);
  if (!found.length) throw new Error("没有获取到免费模型");
  return found;
}

export function installOcFreeModels(found: readonly OcFreeModel[]): void {
  const store = readProviderStore();
  const index = store.providers.findIndex((item) => item.id === BUILTIN_PROVIDER_ID);
  if (index < 0) return;
  const provider = store.providers[index]!;
  const models = mergeBuiltinModels(provider.models, found);
  store.providers[index] = { ...provider, models };
  const parsed = parseModelRef(store.defaultModelRef);
  if (parsed?.providerId === BUILTIN_PROVIDER_ID && !models[parsed.modelId]) {
    store.defaultModelRef = BUILTIN_MODEL_REF;
  }
  writeProviderStore(store);
}
