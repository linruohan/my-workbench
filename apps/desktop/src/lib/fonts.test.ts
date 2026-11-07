import { describe, expect, it } from "vitest";
import { TYPE } from "@wb/theme";
import {
  applyUiFont,
  buildFontOptions,
  fontFamilyLabel,
  fontMatchesQuery,
  fontOptionLabel,
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
    expect(
      buildFontOptions([
        { family: "Zebra", aliases: [] },
        { family: "Arial", aliases: [] },
      ]),
    ).toEqual([
      ["", SYSTEM_DEFAULT_LABEL],
      ["Zebra", "Zebra"],
      ["Arial", "Arial"],
    ]);
  });

  it("matches file-stem aliases against localized family names", () => {
    const font = {
      family: "霞鹜文楷 GB",
      aliases: ["LXGWWenKaiGB"],
    };
    expect(fontMatchesQuery(font, "lxgw")).toBe(true);
    expect(fontMatchesQuery(font, "霞鹜")).toBe(true);
    expect(fontMatchesQuery(font, "missing")).toBe(false);
    expect(fontOptionLabel(font)).toContain("LXGWWenKaiGB");
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
