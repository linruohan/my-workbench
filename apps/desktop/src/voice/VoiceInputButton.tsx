import { useEffect, useId, useRef, useState } from "react";
import { IconMic } from "../shell/icons";
import { Recording, recordingErrorMessage, transcribeRecording } from "./speech-engine";
import { useVoiceInput } from "./VoiceInputContext";

type Phase = "idle" | "recording" | "transcribing";

type Props = {
  disabled?: boolean;
  className?: string;
  onInsert: (text: string) => void;
  /** Focus the target field when recording begins (and keep focus across clicks). */
  onArm?: () => void;
  /** Override context status callback (e.g. local toast). */
  onStatus?: (message: string | null) => void;
};

export function VoiceInputButton({
  disabled = false,
  className,
  onInsert,
  onArm,
  onStatus,
}: Props) {
  const voice = useVoiceInput();
  const reactId = useId();
  const lockId = `voice-dictation:${reactId}`;
  const [phase, setPhase] = useState<Phase>("idle");
  const [level, setLevel] = useState(0);
  const recordingRef = useRef<Recording | null>(null);
  const rafRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const onArmRef = useRef(onArm);
  onArmRef.current = onArm;

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      void recordingRef.current?.dispose();
      recordingRef.current = null;
    };
  }, []);

  if (!voice.enabled) return null;

  const report = (message: string | null) => {
    voice.setStatus(message);
    onStatus?.(message);
  };

  const busy = phase !== "idle";
  const title = !voice.ready
    ? "语音资源未就绪，点击打开设置"
    : phase === "recording"
      ? "点击结束录音"
      : phase === "transcribing"
        ? "正在转写…"
        : "语音输入";

  const tick = () => {
    const recording = recordingRef.current;
    if (!recording) return;
    setLevel(recording.amplitude());
    rafRef.current = requestAnimationFrame(tick);
  };

  const stopRecording = async () => {
    cancelAnimationFrame(rafRef.current);
    const recording = recordingRef.current;
    recordingRef.current = null;
    setLevel(0);
    if (!recording) {
      setPhase("idle");
      return;
    }
    setPhase("transcribing");
    report("正在转写…");
    try {
      const wav = await recording.stop();
      const result = await transcribeRecording(wav, voice.language);
      if (result.ok === false) {
        report(result.message);
        setPhase("idle");
        onArmRef.current?.();
        return;
      }
      if (result.text) {
        onInsert(result.text);
        voice.markReady();
        report(null);
      } else {
        report("没有识别到语音");
        onArmRef.current?.();
      }
    } catch (error) {
      report(recordingErrorMessage(error));
      onArmRef.current?.();
    } finally {
      setPhase("idle");
    }
  };

  const startRecording = async () => {
    // Focus the target field first so caret is ready when text lands.
    onArmRef.current?.();
    // Warm the persistent worker while the user speaks (dsh keeps it loaded).
    void import("./speech-models").then(({ warmSenseVoice }) => warmSenseVoice());
    if (!voice.ready) {
      report("正在准备语音资源…");
      const { ensureSenseVoice } = await import("./speech-models");
      const prepared = await ensureSenseVoice();
      if (prepared.ok === false) {
        report(prepared.message);
        voice.openSettings?.();
        return;
      }
      voice.markReady();
    }
    const recording = new Recording(voice.deviceId || undefined, lockId);
    recordingRef.current = recording;
    setPhase("recording");
    report("正在录音…点击麦克风结束");
    try {
      await recording.start((error) => {
        report(recordingErrorMessage(error));
        if (phaseRef.current === "recording") void stopRecording();
      });
      if (recordingRef.current !== recording) return;
      onArmRef.current?.();
      rafRef.current = requestAnimationFrame(tick);
    } catch (error) {
      recordingRef.current = null;
      setPhase("idle");
      report(recordingErrorMessage(error));
      await recording.dispose();
      onArmRef.current?.();
    }
  };

  const classes = [
    "voice-btn",
    phase === "recording" ? "is-recording" : "",
    phase === "transcribing" ? "is-busy" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={classes}
      aria-label={title}
      title={title}
      disabled={disabled || phase === "transcribing"}
      // Keep focus on the text field so caret survives start/stop clicks.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (phase === "recording") void stopRecording();
        else if (phase === "idle") void startRecording();
      }}
    >
      <IconMic size={16} className="voice-btn__icon" />
      {phase === "recording" ? (
        <span className="voice-btn__level" aria-hidden="true">
          <span style={{ transform: `scaleY(${0.25 + Math.min(1, level * 8)})` }} />
          <span style={{ transform: `scaleY(${0.35 + Math.min(1, level * 10)})` }} />
          <span style={{ transform: `scaleY(${0.2 + Math.min(1, level * 6)})` }} />
        </span>
      ) : null}
      {busy ? null : <span className="sr-only">语音输入</span>}
    </button>
  );
}
