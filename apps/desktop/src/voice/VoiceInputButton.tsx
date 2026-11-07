import { useEffect, useId, useRef, useState } from "react";
import { IconMic } from "../shell/icons";
import { Recording, recordingErrorMessage, transcribeRecording } from "./speech-engine";
import { VOICE_HOLD_MIN_MS } from "./text";
import { useVoiceInput } from "./VoiceInputContext";

type Phase = "idle" | "recording" | "transcribing";

type Props = {
  disabled?: boolean;
  className?: string;
  onInsert: (text: string) => void;
  /** Focus the target field when recording begins (and keep focus across presses). */
  onArm?: () => void;
  /** Override context status callback (e.g. local toast). */
  onStatus?: (message: string | null) => void;
};

type PressState = {
  pointerId: number;
  startedAt: number;
  active: boolean;
};

/**
 * Hold-to-talk mic (CapsWriter-style PTT):
 * press to record, release to transcribe; presses shorter than VOICE_HOLD_MIN_MS cancel.
 */
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
  const pressRef = useRef<PressState | null>(null);
  const finishingRef = useRef(false);
  const onArmRef = useRef(onArm);
  const onInsertRef = useRef(onInsert);
  onArmRef.current = onArm;
  onInsertRef.current = onInsert;

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
      ? "松开结束录音"
      : phase === "transcribing"
        ? "正在转写…"
        : "按住说话";

  const tick = () => {
    const recording = recordingRef.current;
    if (!recording) return;
    setLevel(recording.amplitude());
    rafRef.current = requestAnimationFrame(tick);
  };

  const cancelRecording = async (message: string | null = null) => {
    cancelAnimationFrame(rafRef.current);
    const recording = recordingRef.current;
    recordingRef.current = null;
    setLevel(0);
    setPhase("idle");
    finishingRef.current = false;
    if (recording) await recording.dispose();
    report(message);
    onArmRef.current?.();
  };

  const stopRecording = async () => {
    cancelAnimationFrame(rafRef.current);
    const recording = recordingRef.current;
    recordingRef.current = null;
    setLevel(0);
    if (!recording) {
      setPhase("idle");
      finishingRef.current = false;
      return;
    }
    setPhase("transcribing");
    report("正在转写…");
    try {
      const { warmSenseVoice } = await import("./speech-models");
      await warmSenseVoice().catch(() => false);
      const wav = await recording.stop();
      const result = await transcribeRecording(wav, voice.language);
      if (result.ok === false) {
        report(result.message);
        setPhase("idle");
        onArmRef.current?.();
        return;
      }
      if (result.text) {
        onInsertRef.current(result.text);
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
      finishingRef.current = false;
    }
  };

  const finishPress = async (startedAt: number) => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    const heldMs = performance.now() - startedAt;
    if (heldMs < VOICE_HOLD_MIN_MS) {
      await cancelRecording("按住时间太短");
      return;
    }
    if (recordingRef.current || phaseRef.current === "recording") {
      await stopRecording();
      return;
    }
    // Released before the mic opened — nothing to transcribe.
    finishingRef.current = false;
    setPhase("idle");
    report(null);
    onArmRef.current?.();
  };

  const startRecording = async () => {
    onArmRef.current?.();
    void import("./speech-models").then(({ warmSenseVoice }) => warmSenseVoice());
    if (!voice.ready) {
      report("正在准备语音资源…");
      const { ensureSenseVoice } = await import("./speech-models");
      const prepared = await ensureSenseVoice();
      if (prepared.ok === false) {
        report(prepared.message);
        voice.openSettings?.();
        pressRef.current = null;
        finishingRef.current = false;
        return;
      }
      voice.markReady();
    }
    const press = pressRef.current;
    if (!press?.active) {
      // Released during ensure — apply threshold against original press time.
      if (press) await finishPress(press.startedAt);
      return;
    }

    const recording = new Recording(voice.deviceId || undefined, lockId);
    recordingRef.current = recording;
    setPhase("recording");
    report("正在录音…松开结束");
    try {
      await recording.start((error) => {
        report(recordingErrorMessage(error));
        if (phaseRef.current === "recording") {
          void cancelRecording(recordingErrorMessage(error));
        }
      });
      if (recordingRef.current !== recording) return;
      const current = pressRef.current;
      if (!current?.active) {
        await finishPress(current?.startedAt ?? press.startedAt);
        return;
      }
      onArmRef.current?.();
      rafRef.current = requestAnimationFrame(tick);
    } catch (error) {
      recordingRef.current = null;
      setPhase("idle");
      report(recordingErrorMessage(error));
      await recording.dispose();
      pressRef.current = null;
      finishingRef.current = false;
      onArmRef.current?.();
    }
  };

  const beginPress = (pointerId: number) => {
    if (disabled || phase === "transcribing" || finishingRef.current) return;
    if (pressRef.current?.active) return;
    pressRef.current = {
      pointerId,
      startedAt: performance.now(),
      active: true,
    };
    void startRecording();
  };

  const endPress = (pointerId: number) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== pointerId) return;
    press.active = false;
    void finishPress(press.startedAt).finally(() => {
      if (pressRef.current === press) pressRef.current = null;
    });
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
      onMouseDown={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        beginPress(event.pointerId);
      }}
      onPointerUp={(event) => {
        endPress(event.pointerId);
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // already released
        }
      }}
      onPointerCancel={(event) => {
        endPress(event.pointerId);
      }}
      onLostPointerCapture={(event) => {
        if (pressRef.current?.pointerId === event.pointerId && pressRef.current.active) {
          endPress(event.pointerId);
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        if (event.repeat) return;
        event.preventDefault();
        beginPress(-1);
      }}
      onKeyUp={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        endPress(-1);
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
      {busy ? null : <span className="sr-only">按住说话</span>}
    </button>
  );
}
