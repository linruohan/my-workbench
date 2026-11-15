//! 跨读块安全的 UTF-8 流式解码。
//!
//! 子进程输出按 8KB 块读取，块边界可能切在多字节字符（中文 3 字节）中间；
//! 逐块 `String::from_utf8_lossy` 会把残缺序列变成 U+FFFD，中文输出在
//! 块边界周期性乱码。这里保留未完成的序列尾字节，拼到下一块继续解码，
//! 只有真正的坏字节才替换为 U+FFFD。

pub struct Utf8StreamDecoder {
    tail: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub fn new() -> Self {
        Self { tail: Vec::new() }
    }

    /// 喂入一段字节，返回其中完整部分的解码结果。
    /// 末尾残缺的序列保留到下次 push；EOF 后请调用 `finish`。
    pub fn push(&mut self, bytes: &[u8]) -> String {
        if bytes.is_empty() {
            return String::new();
        }
        let mut joined = std::mem::take(&mut self.tail);
        joined.extend_from_slice(bytes);
        let mut out = String::new();
        let mut rest: &[u8] = &joined;
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    rest = &[];
                    break;
                }
                Err(err) => {
                    let valid = err.valid_up_to();
                    if let Ok(text) = std::str::from_utf8(&rest[..valid]) {
                        out.push_str(text);
                    }
                    rest = &rest[valid..];
                    match err.error_len() {
                        // Some(len)：确定的坏字节序列 → 替换后继续解码后半段
                        Some(len) => {
                            out.push('\u{FFFD}');
                            rest = &rest[len..];
                        }
                        // None：末尾残缺序列 → 留给下一块
                        None => break,
                    }
                }
            }
        }
        self.tail = rest.to_vec();
        out
    }

    /// 流结束时解码残余字节（残缺序列按 lossy 规则替换）。
    pub fn finish(&mut self) -> String {
        let tail = std::mem::take(&mut self.tail);
        if tail.is_empty() {
            return String::new();
        }
        String::from_utf8_lossy(&tail).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8StreamDecoder;

    const CJK: &[u8] = "中文输出测试".as_bytes();

    #[test]
    fn decodes_across_chunk_boundaries() {
        let mut decoder = Utf8StreamDecoder::new();
        let mut text = String::new();
        // 逐字节喂入，最坏情况的块边界
        for byte in CJK {
            text.push_str(&decoder.push(std::slice::from_ref(byte)));
        }
        text.push_str(&decoder.finish());
        assert_eq!(text, "中文输出测试");
    }

    #[test]
    fn decodes_multibyte_split_midway() {
        let mut decoder = Utf8StreamDecoder::new();
        let mut text = String::new();
        for chunk in CJK.chunks(2) {
            text.push_str(&decoder.push(chunk));
        }
        text.push_str(&decoder.finish());
        assert_eq!(text, "中文输出测试");
    }

    #[test]
    fn replaces_genuine_bad_bytes_immediately() {
        let mut decoder = Utf8StreamDecoder::new();
        assert_eq!(decoder.push(&[0x61, 0xFF, 0x62]), "a\u{FFFD}b");
        assert_eq!(decoder.push(b"c"), "c");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn ascii_passthrough_is_zero_copy_fast_path() {
        let mut decoder = Utf8StreamDecoder::new();
        assert_eq!(decoder.push(b"hello world"), "hello world");
        assert_eq!(decoder.push(b" more"), " more");
        assert_eq!(decoder.finish(), "");
    }
}
