/**
 * Persistent SenseVoice worker (dsh-style).
 * Usage: WB_SPEECH_TOKEN=<64-hex> node transcribe.mjs <config.json>
 * config: { model, tokens, vad, threads?, modulePaths?, maxAudioBytes? }
 *
 * Loads ONNX once, listens on 127.0.0.1, then prints one stdout line:
 *   {"port":N}
 * POST /transcribe?language=auto  Authorization: Bearer <token>  body: WAV bytes
 * → {"text","audioSeconds","inferenceSeconds"}
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const SAMPLE_RATE = 16_000;
const WINDOW = 512;
const LANGUAGES = new Set(["auto", "zh", "en", "yue", "ja", "ko"]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function validateWave(audio, maxAudioBytes) {
  if (audio.length < 46 || audio.length > maxAudioBytes) {
    throw new Error("录音数据无效");
  }
  if (
    audio.toString("ascii", 0, 4) !== "RIFF" ||
    audio.toString("ascii", 8, 12) !== "WAVE" ||
    audio.toString("ascii", 12, 16) !== "fmt " ||
    audio.readUInt32LE(16) !== 16 ||
    audio.readUInt16LE(20) !== 1 ||
    audio.readUInt16LE(22) !== 1 ||
    audio.readUInt32LE(24) !== SAMPLE_RATE ||
    audio.readUInt32LE(28) !== 32_000 ||
    audio.readUInt16LE(32) !== 2 ||
    audio.readUInt16LE(34) !== 16 ||
    audio.toString("ascii", 36, 40) !== "data" ||
    audio.readUInt32LE(4) !== audio.length - 8 ||
    audio.readUInt32LE(40) !== audio.length - 44 ||
    (audio.length - 44) % 2 !== 0
  ) {
    throw new Error("Audio must be a canonical 16 kHz mono PCM16 WAV recording");
  }
  return (audio.length - 44) / 32_000;
}

function resolveSherpa(modulePaths) {
  const errors = [];
  for (const base of modulePaths) {
    try {
      const require = createRequire(pathToFileURL(`${base}/`).href);
      return require("sherpa-onnx-node");
    } catch (error) {
      errors.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    return createRequire(import.meta.url)("sherpa-onnx-node");
  } catch (error) {
    errors.push(`cwd: ${error instanceof Error ? error.message : String(error)}`);
    fail(`无法加载 sherpa-onnx-node\n${errors.join("\n")}`);
  }
}

function createTranscriber(sherpa, config) {
  const nativeConfig = {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: config.model,
        language: "auto",
        useInverseTextNormalization: 1,
      },
      tokens: config.tokens,
      numThreads: config.threads,
      provider: "cpu",
      debug: 0,
    },
  };
  const recognizer = new sherpa.OfflineRecognizer(nativeConfig);
  const detector = new sherpa.Vad(
    {
      sileroVad: {
        model: config.vad,
        threshold: 0.5,
        minSilenceDuration: 0.5,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 30,
        windowSize: WINDOW,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: config.threads,
      provider: "cpu",
      debug: 0,
    },
    32,
  );

  return (audio, language) => {
    if (!LANGUAGES.has(language)) throw new Error("不支持的识别语言");
    const audioSeconds = validateWave(audio, config.maxAudioBytes);
    const pcm = new DataView(audio.buffer, audio.byteOffset + 44, audio.byteLength - 44);
    const samples = Float32Array.from(
      { length: pcm.byteLength / 2 },
      (_, i) => pcm.getInt16(i * 2, true) / 32768,
    );
    nativeConfig.modelConfig.senseVoice.language = language;
    recognizer.setConfig(nativeConfig);
    detector.reset();
    const started = performance.now();
    const texts = [];
    const onsetPadding = Math.round(0.3 * SAMPLE_RATE);
    let isFirstSegment = true;
    const drain = () => {
      while (!detector.isEmpty()) {
        const segment = detector.front(false);
        let speech = segment.samples;
        if (isFirstSegment) {
          isFirstSegment = false;
          const from = Math.max(0, segment.start - onsetPadding);
          if (from < segment.start) {
            const restored = new Float32Array(segment.start - from + speech.length);
            restored.set(samples.subarray(from, segment.start));
            restored.set(speech, segment.start - from);
            speech = restored;
          }
        }
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: speech });
        recognizer.decode(stream);
        texts.push(recognizer.getResult(stream).text.trim());
        detector.pop();
      }
    };
    for (let offset = 0; offset < samples.length; offset += WINDOW) {
      detector.acceptWaveform(samples.subarray(offset, offset + WINDOW));
      drain();
    }
    detector.flush();
    drain();
    return {
      text: texts.filter(Boolean).join(" ").trim(),
      audioSeconds,
      inferenceSeconds: (performance.now() - started) / 1000,
    };
  };
}

function startRecognitionServer(token, maxAudioBytes, transcribe) {
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer((request, response) => {
    const reply = (status, value) => {
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    };
    const authorization = Buffer.from(request.headers.authorization ?? "");
    if (
      authorization.length !== expected.length ||
      !timingSafeEqual(authorization, expected)
    ) {
      request.resume();
      reply(401, { error: "Unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      reply(200, { ok: true });
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/transcribe") {
      request.resume();
      reply(404, { error: "Unknown endpoint" });
      return;
    }
    const length = Number(request.headers["content-length"]);
    if (!Number.isSafeInteger(length) || length < 46 || length > maxAudioBytes) {
      request.resume();
      reply(413, { error: "录音数据无效" });
      return;
    }
    const chunks = [];
    let received = 0;
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxAudioBytes) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const audio = Buffer.concat(chunks);
        const language = url.searchParams.get("language") || "auto";
        reply(200, transcribe(audio, language));
      } catch (error) {
        reply(400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    request.on("error", () => {
      reply(400, { error: "录音读取失败" });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

async function main() {
  const raw = process.argv[2];
  if (!raw) fail("缺少配置参数");
  const config = JSON.parse(raw);
  for (const key of ["model", "tokens", "vad"]) {
    if (typeof config[key] !== "string" || !config[key]) {
      fail(`配置缺少 ${key}`);
    }
  }
  const token = process.env.WB_SPEECH_TOKEN;
  delete process.env.WB_SPEECH_TOKEN;
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
    fail("缺少有效的 WB_SPEECH_TOKEN");
  }
  const threads =
    Number.isFinite(config.threads) && config.threads >= 1 ? Math.floor(config.threads) : 2;
  const maxAudioBytes =
    Number.isFinite(config.maxAudioBytes) && config.maxAudioBytes >= 46
      ? Math.floor(config.maxAudioBytes)
      : 4 * 1024 * 1024;
  const modulePaths = Array.isArray(config.modulePaths)
    ? config.modulePaths.filter((item) => typeof item === "string" && item)
    : [];
  const sherpa = resolveSherpa(modulePaths);
  const transcribe = createTranscriber(sherpa, {
    model: config.model,
    tokens: config.tokens,
    vad: config.vad,
    threads,
    maxAudioBytes,
  });
  const { port } = await startRecognitionServer(token, maxAudioBytes, transcribe);
  process.stdout.write(`${JSON.stringify({ port })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => {
    process.exit(1);
  });
});
