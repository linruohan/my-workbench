import { describe, expect, it } from "vitest";
import { TYPE } from "@wb/theme";
import {
  applyUiFont,
  buildFontOptions,
  fontFamilyLabel,
  normalizeFontFamily,
  resolveUiFontStack,
  SYSTEM_DEFAULT_LABEL,
} from "./fonts";

describe("fonts", () => {
  it("normalizes safe family names", () => {
    expect(normalizeFontFamily("  Microsoft YaHei  ")).toBe("Microsoft YaHei");
    expect(normalizeFontFamily("")).toBe("");
    expect(normalizeFontFamily('Evil";color:red')).toBe("");
    expect(normalizeFontFamily(null)).toBe("");
  });

  it("builds a Mac-style UI stack with fallbacks", () => {
    expect(resolveUiFontStack("")).toBe(TYPE.fontUi);
    expect(TYPE.fontUi).toContain("-apple-system");
    expect(TYPE.fontUi).toContain("SF Pro Text");
    expect(resolveUiFontStack("Segoe UI")).toBe(`"Segoe UI", ${TYPE.fontUi}`);
  });

  it("labels the system default and family names", () => {
    expect(fontFamilyLabel("")).toBe(SYSTEM_DEFAULT_LABEL);
    expect(fontFamilyLabel("Microsoft YaHei")).toBe("Microsoft YaHei");
  });

  it("puts system default first in select options", () => {
    expect(buildFontOptions(["Zebra", "Arial"])).toEqual([
      ["", SYSTEM_DEFAULT_LABEL],
      ["Zebra", "Zebra"],
      ["Arial", "Arial"],
    ]);
  });

  it("applies and clears the CSS variable", () => {
    applyUiFont("KaiTi");
    expect(document.documentElement.style.getPropertyValue("--wb-font-ui")).toContain(
      "KaiTi",
    );
    applyUiFont("");
    expect(document.documentElement.style.getPropertyValue("--wb-font-ui")).toBe("");
  });
});
