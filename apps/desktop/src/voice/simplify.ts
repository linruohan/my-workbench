import { Converter } from "opencc-js/t2cn";

/**
 * 繁转简转换器。
 *
 * Qwen 系 ASR 对中文常常输出繁体字（例如「漢字」「臺灣」），
 * 这里统一在转写结果出口做一次 OpenCC t2s 转换，保证回填的是简体。
 */
const convert = Converter({ from: "t", to: "cn" });

/**
 * 把转写文本里的繁体字转成简体。
 * 不含汉字时直接返回，避免无意义的字典扫描。
 */
export function toSimplifiedChinese(text: string): string {
  if (!text) return text;
  if (!/[\u3400-\u9fff]/.test(text)) return text;
  return convert(text);
}
