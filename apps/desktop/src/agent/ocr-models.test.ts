import { describe, expect, it } from "vitest";
import { ensurePaddleOcr } from "./ocr-models";

describe("ensurePaddleOcr", () => {
  it("does not download outside the desktop shell", async () => {
    const result = await ensurePaddleOcr({ tauri: false });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.skipped).toBe(true);
  });

  it("surfaces a host download error", async () => {
    const result = await ensurePaddleOcr({
      tauri: true,
      proxy: "",
      invoke: async () => ({
        dir: "C:\\Users\\me\\AppData\\Roaming\\my-workbench\\models\\paddleocr",
        ready: false,
        error: "下载超时",
      }),
    });
    expect(result).toEqual({ ok: false, skipped: false, message: "下载超时" });
  });

  it("accepts a completed download", async () => {
    const result = await ensurePaddleOcr({
      tauri: true,
      proxy: "",
      invoke: async (_command, args) => {
        const files = args.files as Array<{ name: string }>;
        expect(files.map((file) => file.name)).toContain("PP-OCRv6_det_small.onnx");
        return { dir: "D:\\config\\models\\paddleocr", ready: true, error: null };
      },
    });
    expect(result).toEqual({ ok: true, dir: "D:\\config\\models\\paddleocr" });
  });
});
