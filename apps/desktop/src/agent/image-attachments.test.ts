import { afterEach, describe, expect, it } from "vitest";
import {
  clearThreadImageAttachments,
  getImageAttachment,
  PENDING_IMAGE_MAX_COUNT,
  putImageAttachment,
  takePendingImageDataUrls,
  takePendingImages,
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

  it("offloads older pending images beyond the per-turn count budget", () => {
    for (let i = 0; i < PENDING_IMAGE_MAX_COUNT + 2; i += 1) {
      putImageAttachment({
        threadId: "t1",
        path: `shot-${i}.png`,
        mediaType: "image/png",
        dataUrl: `data:image/png;base64,${"Y".repeat(8)}${i}`,
        bytes: 8,
        width: 1,
        height: 1,
        name: `shot-${i}.png`,
      });
    }
    const taken = takePendingImages("t1");
    expect(taken.dataUrls).toHaveLength(PENDING_IMAGE_MAX_COUNT);
    expect(taken.offloaded).toHaveLength(2);
    expect(taken.offloaded[0]?.path).toBe("shot-0.png");
    expect(taken.offloaded[0]?.reason).toBe("count");
    expect(taken.attached[0]?.path).toBe("shot-2.png");
  });
});
