declare module "onnxruntime-web/dist/ort.wasm.min.mjs" {
  export const env: { wasm: { wasmPaths?: string; numThreads?: number } };
  export const InferenceSession: {
    create(
      data: Uint8Array,
      options?: { executionProviders?: string[] },
    ): Promise<{
      inputNames: readonly string[];
      outputNames: readonly string[];
      run(
        feeds: Record<string, unknown>,
      ): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
    }>;
  };
  export class Tensor {
    constructor(type: "float32", data: Float32Array, dims: number[]);
  }
}
