/** Browser-owned microphone capture and 16 kHz PCM16 WAV encoding. */

import { acquireMicLock, releaseMicLock } from "./mic-lock";

export class RecordingError extends Error {
  readonly kind:
    | "unavailable"
    | "permission"
    | "empty"
    | "cancelled"
    | "interrupted"
    | "deviceMissing";

  constructor(
    kind:
      | "unavailable"
      | "permission"
      | "empty"
      | "cancelled"
      | "interrupted"
      | "deviceMissing",
  ) {
    super(kind);
    this.kind = kind;
    this.name = "RecordingError";
  }
}

const TARGET_RATE = 16_000;

/** Downsample mono float samples to 16 kHz with linear interpolation. */
export function resampleTo16k(input: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate <= 0 || input.length === 0) return new Float32Array(0);
  if (Math.abs(sampleRate - TARGET_RATE) < 1) return input.slice();
  const ratio = sampleRate / TARGET_RATE;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const src = i * ratio;
    const left = Math.floor(src);
    const right = Math.min(input.length - 1, left + 1);
    const frac = src - left;
    const a = input[left] ?? 0;
    const b = input[right] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export function encodeWave(samples: Float32Array): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

export function audioBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export type MicrophoneDevice = {
  deviceId: string;
  label: string;
  groupId: string;
};

export type MicrophoneChoices = {
  /** Empty id follows the OS default input. */
  defaultLabel: string;
  devices: MicrophoneDevice[];
};

function cleanMicLabel(label: string, index: number): string {
  const trimmed = label.trim();
  if (!trimmed) return `麦克风 ${index + 1}`;
  return (
    trimmed
      .replace(/^Default\s*[-–—]\s*/i, "")
      .replace(/^默认\s*[-–—]\s*/, "")
      .trim() || `麦克风 ${index + 1}`
  );
}

export async function listMicrophones(): Promise<MicrophoneDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: cleanMicLabel(device.label, index),
      groupId: device.groupId,
    }));
}

/**
 * Ask for mic permission, resolve the OS default input name, and list concrete devices.
 * Synthetic browser ids (`default` / `communications`) are omitted from the list.
 */
export async function probeMicrophones(): Promise<MicrophoneChoices> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { defaultLabel: "", devices: [] };
  }
  let defaultLabel = "";
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const track = stream.getAudioTracks()[0];
    defaultLabel = cleanMicLabel(track?.label ?? "", 0);
  } catch {
    // Permission denied or no device — still try enumeration for whatever labels exist.
  } finally {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
  }
  const listed = await listMicrophones();
  const devices = listed.filter(
    (device) => device.deviceId !== "default" && device.deviceId !== "communications",
  );
  if (!defaultLabel) {
    defaultLabel = devices[0]?.label ?? "";
  }
  return { defaultLabel, devices };
}

export function systemDefaultOptionLabel(defaultLabel: string): string {
  return defaultLabel ? `系统默认 (${defaultLabel})` : "系统默认";
}

let recordingSeq = 0;

export class Recording {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private mute: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private chunkSamples = 0;
  private disposed = false;
  private readonly deviceId?: string;
  private readonly lockId: string;
  private sampleRate = TARGET_RATE;

  constructor(deviceId?: string, lockId?: string) {
    this.deviceId = deviceId?.trim() || undefined;
    this.lockId = lockId?.trim() || `rec-${(recordingSeq += 1)}`;
  }

  /** Open the mic for a live level meter without keeping PCM for transcription. */
  async preview(onError?: (error: RecordingError) => void): Promise<void> {
    await this.acquire(false, onError);
  }

  async start(onError?: (error: RecordingError) => void): Promise<void> {
    await this.acquire(true, onError);
  }

  private async acquire(
    record: boolean,
    onError?: (error: RecordingError) => void,
  ): Promise<void> {
    if (this.disposed) throw new RecordingError("cancelled");
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new RecordingError("unavailable");
    }
    await acquireMicLock(this.lockId, () => {
      void this.dispose();
    });
    if (this.disposed) {
      releaseMicLock(this.lockId);
      throw new RecordingError("cancelled");
    }
    try {
      // Empty deviceId follows the OS / browser default input device.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: this.deviceId
          ? {
              deviceId: { exact: this.deviceId },
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }
          : {
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
      });
    } catch (error) {
      releaseMicLock(this.lockId);
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new RecordingError("permission");
      }
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        throw new RecordingError("deviceMissing");
      }
      throw new RecordingError("unavailable");
    }
    if (this.disposed) {
      await this.release();
      throw new RecordingError("cancelled");
    }
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.context = new AudioCtx();
      if (this.context.state === "suspended") {
        await this.context.resume().catch(() => undefined);
      }
      this.sampleRate = this.context.sampleRate || TARGET_RATE;
      this.source = this.context.createMediaStreamSource(this.stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.source.connect(this.analyser);
      if (record) {
        // Keep the graph alive without playing mic audio back through speakers.
        this.mute = this.context.createGain();
        this.mute.gain.value = 0;
        this.processor = this.context.createScriptProcessor(4096, 1, 1);
        this.processor.onaudioprocess = (event) => {
          if (this.disposed) return;
          const input = event.inputBuffer.getChannelData(0);
          this.chunks.push(Float32Array.from(input));
          this.chunkSamples += input.length;
        };
        this.source.connect(this.processor);
        this.processor.connect(this.mute);
        this.mute.connect(this.context.destination);
      }
      for (const track of this.stream.getTracks()) {
        track.addEventListener("ended", () => {
          onError?.(new RecordingError("interrupted"));
        });
      }
    } catch {
      await this.release();
      throw new RecordingError("unavailable");
    }
  }

  amplitude(): number {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = ((data[i] ?? 128) - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / Math.max(1, data.length));
  }

  async stop(maxDurationSeconds = 120): Promise<Uint8Array> {
    if (this.disposed) throw new RecordingError("cancelled");
    const merged = new Float32Array(this.chunkSamples);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    this.chunkSamples = 0;
    const sampleRate = this.sampleRate;
    await this.release();
    const resampled = resampleTo16k(merged, sampleRate);
    const maxSamples = Math.floor(maxDurationSeconds * TARGET_RATE);
    const clipped =
      resampled.length > maxSamples ? resampled.subarray(0, maxSamples) : resampled;
    if (clipped.length < TARGET_RATE * 0.1) throw new RecordingError("empty");
    return encodeWave(clipped);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.release();
  }

  private async release(): Promise<void> {
    try {
      this.processor?.disconnect();
    } catch {
      // ignore
    }
    try {
      this.mute?.disconnect();
    } catch {
      // ignore
    }
    try {
      this.source?.disconnect();
    } catch {
      // ignore
    }
    try {
      this.analyser?.disconnect();
    } catch {
      // ignore
    }
    this.processor = null;
    this.mute = null;
    this.source = null;
    this.analyser = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // ignore
      }
      this.context = null;
    }
    releaseMicLock(this.lockId);
  }
}
