import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/render";
import { ModelsPane } from "./ModelsPane";

vi.mock("./oc-models", () => ({
  refreshOcFreeModels: vi.fn(async () => 0),
}));

vi.mock("./ocr-models", () => ({
  ensurePaddleOcr: vi.fn(async () => ({
    ok: true,
    dir: "D:\\config\\models\\paddleocr",
  })),
}));

vi.mock("./ocr-engine", () => ({
  recognizeLocalImage: vi.fn(async () => ({ ok: true, lines: ["你好"] })),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("local ocr model", () => {
  it("lists the local OCR model under the workbench and debugs an image", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ModelsPane />);

    expect(screen.getByRole("heading", { name: "本地模型" })).toBeInTheDocument();
    expect(screen.getByText("PP-OCRv6 small")).toBeInTheDocument();
    expect(await screen.findByText("已就绪")).toBeInTheDocument();

    const file = new File(["png"], "sample.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("调试识图"), file);
    expect(await screen.findByText("识别到：你好")).toBeInTheDocument();
  });
});
