import {
  argmaxRows,
  boxesFromMap,
  ctcDecode,
  detInputSize,
  padBox,
  parseOcrKeys,
  pixelsToNchw,
  scaleBoxes,
  selectOcrBoxes,
  type OcrBox,
} from "@wb/domain";
import { ensurePaddleOcr } from "./ocr-models";

type OrtTensor = { data: Float32Array; dims: readonly number[] };
type OrtSession = {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
};
type OrtModule = {
  env: { wasm: { wasmPaths?: string; numThreads?: number } };
  InferenceSession: {
    create(
      data: Uint8Array,
      options?: { executionProviders?: string[] },
    ): Promise<OrtSession>;
  };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
};

let runtime: Promise<{
  det: OrtSession;
  rec: OrtSession;
  keys: string[];
  ort: OrtModule;
}> | null = null;

function wasmDir(): string {
  const base = import.meta.env.BASE_URL || "/";
  return new URL("ort/", new URL(base, globalThis.location.href)).href;
}

async function readModel(name: string): Promise<Uint8Array> {
  const { invoke } = await import("@tauri-apps/api/core");
  const value: unknown = await invoke("ocr_read_model", { name });
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return Uint8Array.from(value);
  }
  throw new Error("识图模型文件无法读取");
}

async function loadRuntime() {
  const ort = (await import("onnxruntime-web/dist/ort.wasm.min.mjs")) as OrtModule;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = wasmDir();
  const [detBytes, recBytes, keyBytes] = await Promise.all([
    readModel("ch_PP-OCRv4_det_infer.onnx"),
    readModel("ch_PP-OCRv4_rec_infer.onnx"),
    readModel("ppocr_keys_v1.txt"),
  ]);
  const options = { executionProviders: ["wasm"] };
  const [det, rec] = await Promise.all([
    ort.InferenceSession.create(detBytes, options),
    ort.InferenceSession.create(recBytes, options),
  ]);
  return {
    det,
    rec,
    keys: parseOcrKeys(new TextDecoder("utf-8").decode(keyBytes)),
    ort,
  };
}

function sessions() {
  runtime ??= loadRuntime().catch((error: unknown) => {
    runtime = null;
    throw error;
  });
  return runtime;
}

function canvasOf(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法读取图片");
  return context;
}

function drawTensor(
  source: CanvasImageSource,
  width: number,
  height: number,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): Float32Array {
  const context = canvasOf(width, height);
  context.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  return pixelsToNchw(pixels, width, height);
}

async function runTensor(
  session: OrtSession,
  ort: OrtModule,
  data: Float32Array,
  width: number,
  height: number,
): Promise<OrtTensor> {
  const input = session.inputNames[0];
  const output = session.outputNames[0];
  if (!input || !output) throw new Error("识图模型输出无法识别");
  const tensor = new ort.Tensor("float32", data, [1, 3, height, width]);
  const result = await session.run({ [input]: tensor });
  const value = result[output];
  if (!value) throw new Error("识图模型输出无法识别");
  return value;
}

function plane(tensor: OrtTensor): { map: Float32Array; width: number; height: number } {
  const dims = tensor.dims;
  if (dims.length === 4) {
    return { map: tensor.data, width: dims[3] ?? 0, height: dims[2] ?? 0 };
  }
  if (dims.length === 3) {
    return { map: tensor.data, width: dims[2] ?? 0, height: dims[1] ?? 0 };
  }
  throw new Error("识图模型输出无法识别");
}

function recognizeLine(tensor: OrtTensor, keys: readonly string[]): string {
  const dims = tensor.dims;
  const steps = dims.length === 3 ? (dims[1] ?? 0) : (dims[0] ?? 0);
  const classes = dims.length === 3 ? (dims[2] ?? 0) : (dims[1] ?? 0);
  if (steps < 1 || classes < 2) throw new Error("识图模型输出无法识别");
  return ctcDecode(argmaxRows(tensor.data, steps, classes), keys);
}

async function recognizeBitmap(
  bitmap: ImageBitmap,
  loaded: Awaited<ReturnType<typeof sessions>>,
): Promise<string[]> {
  const size = detInputSize(bitmap.width, bitmap.height);
  const detData = drawTensor(
    bitmap,
    size.width,
    size.height,
    0,
    0,
    bitmap.width,
    bitmap.height,
  );
  const det = plane(
    await runTensor(loaded.det, loaded.ort, detData, size.width, size.height),
  );
  const boxes = selectOcrBoxes(boxesFromMap(det.map, det.width, det.height)).flatMap(
    (box) => {
      const scaled = scaleBoxes(
        [box],
        det.width,
        det.height,
        bitmap.width,
        bitmap.height,
      )[0];
      return scaled ? [padBox(scaled, bitmap.width, bitmap.height)] : [];
    },
  );
  const regions: OcrBox[] = boxes.length
    ? boxes
    : [{ x: 0, y: 0, w: bitmap.width, h: bitmap.height }];
  const lines: string[] = [];
  for (const box of regions) {
    const height = 48;
    const width = Math.max(
      16,
      Math.min(640, Math.round(height * (box.w / Math.max(1, box.h)))),
    );
    const data = drawTensor(bitmap, width, height, box.x, box.y, box.w, box.h);
    const text = recognizeLine(
      await runTensor(loaded.rec, loaded.ort, data, width, height),
      loaded.keys,
    ).trim();
    if (text) lines.push(text);
  }
  return lines;
}

export async function recognizeLocalImage(
  blob: Blob,
): Promise<{ ok: true; lines: string[] } | { ok: false; message: string }> {
  const ready = await ensurePaddleOcr();
  if (ready.ok === false) {
    return {
      ok: false,
      message: ready.skipped
        ? "识图模型还没下载到配置目录。请在桌面应用中打开。"
        : ready.message,
    };
  }
  try {
    const bitmap = await createImageBitmap(blob);
    try {
      return { ok: true, lines: await recognizeBitmap(bitmap, await sessions()) };
    } finally {
      bitmap.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : "";
    return { ok: false, message: message || "识图失败" };
  }
}
