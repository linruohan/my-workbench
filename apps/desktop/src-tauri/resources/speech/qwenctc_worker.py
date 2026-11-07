#!/usr/bin/env python3
"""
Persistent QwenCTC (Qwen3-ASR + CTC) worker for my-workbench.

Uses the vendored qwen_ctc runtime (pure CTC by default).
Usage:
  WB_SPEECH_TOKEN=<64-hex> python qwenctc_worker.py <config.json>

config:
  {
    "modelDir": ".../AppData/.../models/qwenctc",
    "codeRoot": ".../resources/speech/runtimes",
    "maxAudioBytes": 4194304
  }

Loads models once, listens on 127.0.0.1, then prints: {"port":N}
POST /transcribe?language=auto  Authorization: Bearer <token>  body: WAV bytes
"""

from __future__ import annotations

import json
import os
import struct
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SAMPLE_RATE = 16_000
LANG_MAP = {
    "auto": True,
    "zh": True,
    "en": True,
    "yue": True,
    "ja": True,
    "ko": True,
}


def fail(message: str) -> None:
    sys.stderr.write(f"{message}\n")
    sys.stderr.flush()
    raise SystemExit(1)


def resolve_file(model_dir: Path, candidates: list[str]) -> Path:
    for name in candidates:
        path = model_dir / name
        if path.is_file():
            return path
    fail(f"QwenCTC 模型缺少文件：在 {model_dir} 未找到 {candidates[0]}")


def resolve_model_files(model_dir: Path) -> dict[str, Path | str]:
    encoder = resolve_file(
        model_dir,
        [
            "Qwen3-ASR-Encoder.q4.onnx",
            "Qwen3-ASR-Encoder.onnx",
        ],
    )
    ctc = resolve_file(
        model_dir,
        [
            "Qwen3-ASR-CTC.fp16.onnx",
            "Qwen3-ASR-CTC.q4f16.onnx",
            "Qwen3-ASR-CTC.hqqf16.onnx",
            "Qwen3-ASR-CTC.v1.fp16.onnx",
            "Qwen3-ASR-CTC.onnx",
        ],
    )
    tokens = resolve_file(model_dir, ["tokens.txt"])
    preprocessor = model_dir
    if not (preprocessor / "preprocessor_config.json").is_file():
        fail(f"QwenCTC 缺少 preprocessor_config.json: {preprocessor}")
    return {
        "encoder": encoder,
        "ctc": ctc,
        "tokens": tokens,
        "preprocessor": preprocessor,
    }


def boot_engine(code_root: Path, model_dir: Path):
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
    qwen_pkg = code_root / "qwen_ctc"
    if not qwen_pkg.is_dir():
        fail(f"找不到 QwenCTC 推理代码: {qwen_pkg}")
    sys.path.insert(0, str(code_root))
    from qwen_ctc import create_qwen_ctc_engine

    files = resolve_model_files(model_dir)
    # Pure CTC: faster warm / lower memory for short PTT utterances.
    return create_qwen_ctc_engine(
        encoder_onnx_path=str(files["encoder"]),
        ctc_onnx_path=str(files["ctc"]),
        tokens_path=str(files["tokens"]),
        preprocessor_path=str(files["preprocessor"]),
        decoder_gguf_path="",
        enable_ctc=True,
        num_threads=4,
        provider="cpu",
        verbose=False,
    )


def validate_wave(audio: bytes, max_audio_bytes: int) -> float:
    if len(audio) < 46 or len(audio) > max_audio_bytes:
        raise ValueError("录音数据无效")
    if (
        audio[0:4] != b"RIFF"
        or audio[8:12] != b"WAVE"
        or audio[12:16] != b"fmt "
        or struct.unpack_from("<I", audio, 16)[0] != 16
        or struct.unpack_from("<H", audio, 20)[0] != 1
        or struct.unpack_from("<H", audio, 22)[0] != 1
        or struct.unpack_from("<I", audio, 24)[0] != SAMPLE_RATE
        or struct.unpack_from("<I", audio, 28)[0] != 32_000
        or struct.unpack_from("<H", audio, 32)[0] != 2
        or struct.unpack_from("<H", audio, 34)[0] != 16
        or audio[36:40] != b"data"
        or struct.unpack_from("<I", audio, 4)[0] != len(audio) - 8
        or struct.unpack_from("<I", audio, 40)[0] != len(audio) - 44
        or (len(audio) - 44) % 2 != 0
    ):
        raise ValueError("Audio must be a canonical 16 kHz mono PCM16 WAV recording")
    return (len(audio) - 44) / 32_000


def wav_to_float32(audio: bytes):
    import numpy as np

    pcm = memoryview(audio)[44:]
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    return samples


def transcribe_audio(engine, audio: bytes, language: str, max_audio_bytes: int) -> dict:
    import time

    _ = language  # QwenCTC pure mode has no language hint.
    audio_seconds = validate_wave(audio, max_audio_bytes)
    samples = wav_to_float32(audio)
    stream = engine.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples)
    started = time.perf_counter()
    engine.decode_stream(stream)
    inference_seconds = time.perf_counter() - started
    text = (stream.result.text or "").strip()
    return {
        "text": text,
        "audioSeconds": float(audio_seconds),
        "inferenceSeconds": float(inference_seconds),
    }


def start_server(token: str, max_audio_bytes: int, engine):
    expected = f"Bearer {token}".encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):  # noqa: A003
            return

        def _reply(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            path = urlparse(self.path).path
            if path == "/health":
                self._reply(200, {"ok": True})
                return
            self._reply(404, {"error": "Unknown endpoint"})

        def do_POST(self):  # noqa: N802
            auth = (self.headers.get("Authorization") or "").encode("utf-8")
            if len(auth) != len(expected) or not _timing_safe_eq(auth, expected):
                self._reply(401, {"error": "Unauthorized"})
                return
            url = urlparse(self.path)
            if url.path != "/transcribe":
                self._reply(404, {"error": "Unknown endpoint"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length < 46 or length > max_audio_bytes:
                self._reply(413, {"error": "录音数据无效"})
                return
            audio = self.rfile.read(length)
            language = parse_qs(url.query).get("language", ["auto"])[0] or "auto"
            if language not in LANG_MAP:
                self._reply(400, {"error": "不支持的识别语言"})
                return
            try:
                self._reply(200, transcribe_audio(engine, audio, language, max_audio_bytes))
            except Exception as exc:  # noqa: BLE001
                self._reply(400, {"error": str(exc) or "语音转写失败"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    return server


def _timing_safe_eq(a: bytes, b: bytes) -> bool:
    if len(a) != len(b):
        return False
    result = 0
    for x, y in zip(a, b):
        result |= x ^ y
    return result == 0


def main() -> None:
    if len(sys.argv) < 2:
        fail("缺少配置参数")
    try:
        config = json.loads(sys.argv[1])
    except json.JSONDecodeError:
        fail("配置不是合法 JSON")

    token = os.environ.pop("WB_SPEECH_TOKEN", "")
    if not isinstance(token, str) or len(token) != 64 or any(
        ch not in "0123456789abcdef" for ch in token
    ):
        fail("缺少有效的 WB_SPEECH_TOKEN")

    model_dir = Path(str(config.get("modelDir") or "")).expanduser()
    code_root = Path(str(config.get("codeRoot") or "")).expanduser()
    if not model_dir.is_dir():
        fail(f"QwenCTC 模型目录不存在: {model_dir}")
    if not code_root.is_dir():
        fail(f"CapsWriter GUI 根目录不存在: {code_root}")

    max_audio_bytes = int(config.get("maxAudioBytes") or (4 * 1024 * 1024))
    if max_audio_bytes < 46:
        max_audio_bytes = 4 * 1024 * 1024

    engine = boot_engine(code_root, model_dir)
    server = start_server(token, max_audio_bytes, engine)
    port = server.server_address[1]
    sys.stdout.write(json.dumps({"port": port}) + "\n")
    sys.stdout.flush()
    server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        fail(str(exc) or "QwenCTC worker 启动失败")
