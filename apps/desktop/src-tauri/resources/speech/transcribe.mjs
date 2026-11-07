/**
 * One-shot SenseVoice transcription worker.
 * Usage: node transcribe.mjs <config.json>
 * config: { model, tokens, vad, language, wavPath, threads? }
 * Prints one JSON line: { text, audioSeconds, inferenceSeconds }
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SAMPLE_RATE = 16_000;
const WINDOW = 512;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function validateWave(audio) {
  if (
    audio.length < 46 ||
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
    const audioSeconds = validateWave(audio);
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

function main() {
  const raw = process.argv[2];
  if (!raw) fail("缺少配置参数");
  const config = JSON.parse(raw);
  for (const key of ["model", "tokens", "vad", "wavPath"]) {
    if (typeof config[key] !== "string" || !config[key]) {
      fail(`配置缺少 ${key}`);
    }
  }
  const language =
    typeof config.language === "string" && config.language ? config.language : "auto";
  const threads =
    Number.isFinite(config.threads) && config.threads >= 1 ? Math.floor(config.threads) : 2;
  const modulePaths = Array.isArray(config.modulePaths)
    ? config.modulePaths.filter((item) => typeof item === "string" && item)
    : [];
  const sherpa = resolveSherpa(modulePaths);
  const transcribe = createTranscriber(sherpa, {
    model: config.model,
    tokens: config.tokens,
    vad: config.vad,
    threads,
  });
  const audio = readFileSync(config.wavPath);
  const result = transcribe(audio, language);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();
