import { afterEach, describe, expect, it } from "vitest";
import {
  clearThreadImageAttachments,
  getImageAttachment,
  putImageAttachment,
  takePendingImageDataUrls,
} from "./image-attachments";

afterEach(() => {
  clearThreadImageAttachments("t1");
});

describe("image attachments", () => {
  it("stores refs and drains pending data URLs once", () => {
    const first = putImageAttachment({
      threadId: "t1",
      path: "a.png",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,aaa",
      bytes: 3,
      width: 1,
      height: 1,
      name: "a.png",
    });
    putImageAttachment({
      threadId: "t1",
      path: "b.png",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,bbb",
      bytes: 3,
      width: 2,
      height: 2,
    });
    expect(getImageAttachment("t1", first.id)?.path).toBe("a.png");
    expect(takePendingImageDataUrls("t1")).toEqual([
      "data:image/png;base64,aaa",
      "data:image/png;base64,bbb",
    ]);
    expect(takePendingImageDataUrls("t1")).toEqual([]);
    expect(getImageAttachment("t1", first.id)?.id).toBe(first.id);
  });
});
