import { useEffect, useRef, useState } from "react";
import {
  SPEECH_ENGINES,
  SPEECH_LANGUAGES,
  speechEngineDownloadGuide,
  type SpeechEngineId,
  type SpeechLanguage,
} from "@wb/domain";
import {
  cancelSpeechDownload,
  ensureSpeechEngine,
  micLockOwnerId,
  probeMicrophones,
  readSpeechStatus,
  Recording,
  subscribeMicLock,
  subscribeSpeechDownloadProgress,
  systemDefaultOptionLabel,
  warmSpeechEngine,
  type MicrophoneDevice,
  type SpeechDownloadProgress,
} from "../voice";
import type { AppPrefs } from "../lib/prefs";

const PREVIEW_LOCK_ID = "voice-preview";

type Props = {
  prefs: AppPrefs;
  onPatch: (partial: Partial<AppPrefs>) => void;
};

export function VoiceInputPane({ prefs, onPatch }: Props) {
  const enabled = prefs.voiceInputEnabled;
  const engine = prefs.voiceInputEngine;
  const engineMeta =
    SPEECH_ENGINES.find((item) => item.id === engine) ?? SPEECH_ENGINES[0];
  const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
  const [defaultLabel, setDefaultLabel] = useState("");
  const [level, setLevel] = useState(0);
  const [phase, setPhase] = useState("unprepared");
  const [message, setMessage] = useState("正在检查本地资源…");
  const [modelDir, setModelDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [progress, setProgress] = useState<SpeechDownloadProgress | null>(null);
  const previewRef = useRef<Recording | null>(null);
  const rafRef = useRef(0);

  const engineOptions = { engine: prefs.voiceInputEngine };

  const readyMessage =
    engine === "funasr"
      ? "Fun-ASR-Nano-GGUF 已就绪，识别引擎保持热备。"
      : engine === "qwenctc"
        ? "QwenCTC 已就绪，识别引擎保持热备。"
        : "本地资源已准备，识别引擎保持热备。";

  const refreshStatus = async () => {
    const status = await readSpeechStatus(engineOptions);
    setPhase(status.phase);
    setMessage(status.message);
    setModelDir(status.dir);
    return status;
  };

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    void subscribeSpeechDownloadProgress((next) => {
      if (!live) return;
      if (next.engine && next.engine !== prefs.voiceInputEngine) return;
      setProgress(next);
      if (next.message) setMessage(next.message);
      if (next.phase === "downloading" || next.phase === "extracting") {
        setPhase("loading");
        setBusy(true);
        setExpanded(true);
      }
      if (next.phase === "done") {
        setProgress({ ...next, percent: 100 });
      }
      if (next.phase === "cancelled") {
        setBusy(false);
        setPhase("cancelled");
        setMessage(next.message || "已终止下载");
        setProgress(null);
      }
    }).then((stop) => {
      if (!live) {
        stop();
        return;
      }
      unlisten = stop;
    });
    return () => {
      live = false;
      unlisten?.();
    };
  }, [prefs.voiceInputEngine]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const status = await readSpeechStatus(engineOptions);
      if (!live) return;
      setPhase(status.phase);
      setMessage(status.message);
      setModelDir(status.dir);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- object identity intentionally ignored
  }, [prefs.voiceInputEngine]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void probeMicrophones().then((choices) => {
      if (!live) return;
      setDefaultLabel(choices.defaultLabel);
      setDevices(choices.devices);
      const selected = prefs.voiceInputDeviceId.trim();
      if (selected && !choices.devices.some((device) => device.deviceId === selected)) {
        onPatch({ voiceInputDeviceId: "" });
      }
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prefs/onPatch intentionally omitted
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      cancelAnimationFrame(rafRef.current);
      void previewRef.current?.dispose();
      previewRef.current = null;
      setLevel(0);
      return;
    }

    let live = true;
    let restartTimer = 0;
    let lastForeignOwner: string | null = null;

    const stopPreview = () => {
      cancelAnimationFrame(rafRef.current);
      const current = previewRef.current;
      previewRef.current = null;
      setLevel(0);
      if (current) void current.dispose();
    };

    const startPreview = () => {
      if (!live) return;
      const owner = micLockOwnerId();
      if (owner && owner !== PREVIEW_LOCK_ID) return;
      stopPreview();
      const recording = new Recording(
        prefs.voiceInputDeviceId || undefined,
        PREVIEW_LOCK_ID,
      );
      previewRef.current = recording;
      const tick = () => {
        if (!live || previewRef.current !== recording) return;
        setLevel(recording.amplitude());
        rafRef.current = requestAnimationFrame(tick);
      };
      void recording
        .preview()
        .then(() => {
          if (!live || previewRef.current !== recording) return;
          rafRef.current = requestAnimationFrame(tick);
        })
        .catch(() => {
          if (previewRef.current === recording) previewRef.current = null;
          setLevel(0);
        });
    };

    startPreview();
    const unsubscribe = subscribeMicLock(() => {
      if (!live) return;
      window.clearTimeout(restartTimer);
      const owner = micLockOwnerId();
      if (owner && owner !== PREVIEW_LOCK_ID) {
        lastForeignOwner = owner;
        cancelAnimationFrame(rafRef.current);
        previewRef.current = null;
        setLevel(0);
        return;
      }
      if (owner === PREVIEW_LOCK_ID) {
        lastForeignOwner = null;
        return;
      }
      if (!lastForeignOwner) return;
      lastForeignOwner = null;
      restartTimer = window.setTimeout(() => startPreview(), 120);
    });

    return () => {
      live = false;
      window.clearTimeout(restartTimer);
      unsubscribe();
      stopPreview();
    };
  }, [enabled, prefs.voiceInputDeviceId]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setBusy(false);
    setProgress(null);
    setMessage("正在检查本地资源…");
    void readSpeechStatus(engineOptions).then((status) => {
      if (!live) return;
      setPhase(status.phase);
      setMessage(status.ready ? readyMessage : status.message);
      setModelDir(status.dir);
      if (status.ready) {
        void warmSpeechEngine(engineOptions);
      }
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- object identity intentionally ignored
  }, [enabled, prefs.voiceInputEngine]);

  const prepare = async () => {
    setBusy(true);
    setExpanded(true);
    setProgress(null);
    setMessage("正在准备本地资源…");
    setPhase("loading");
    const result = await ensureSpeechEngine(engineOptions);
    setBusy(false);
    if (result.ok === true) {
      setPhase("ready");
      setMessage(readyMessage);
      setModelDir(result.dir);
      setProgress((prev) =>
        prev ? { ...prev, phase: "done", percent: 100, message: readyMessage } : null,
      );
      void warmSpeechEngine(engineOptions);
      await refreshStatus();
      return;
    }
    setPhase(result.phase);
    setMessage(
      result.phase === "cancelled"
        ? "已终止下载"
        : result.message.split("\n")[0] || result.message,
    );
    setProgress(null);
  };

  const stopPrepare = async () => {
    setMessage("正在终止下载…");
    await cancelSpeechDownload();
  };

  const guide = speechEngineDownloadGuide(engine, modelDir);
  const progressPercent = (() => {
    if (progress && progress.total > 0) {
      const raw = Math.floor((progress.current / progress.total) * 100);
      if (progress.current > 0 && raw < 1) return 1;
      return Math.max(0, Math.min(100, raw));
    }
    return Math.max(0, Math.min(100, progress?.percent ?? 0));
  })();
  const progressLabel =
    progress == null
      ? busy
        ? "准备中…"
        : ""
      : progress.count > 1
        ? `${progress.message || "下载中"}（${progress.index}/${progress.count}）`
        : progress.message || "下载中…";
  const downloadDir =
    modelDir.trim() ||
    `%APPDATA%\\my-workbench\\models\\${
      engine === "funasr" ? "funasr" : engine === "qwenctc" ? "qwenctc" : "sensevoice"
    }`;

  return (
    <section className="settings__pane">
      <header className="settings__pane-head">
        <h1 className="settings__title">语音输入</h1>
        <span className="settings__pill">实验性</span>
      </header>
      <p className="settings__row-desc" style={{ marginBottom: "1rem" }}>
        在本机转写录音，可切换 SenseVoice、FunASR 或 QwenCTC。切换引擎时只检查本地 models
        目录是否可用；缺文件时需点击「开始准备」再下载。启用后两种方式同时可用：输入框旁的麦克风按钮，以及全局
        CapsLock 按住说话（任意可输入处，含其它窗口）。
      </p>

      <div className="settings__card voice-settings">
        <div className="settings__row">
          <div>
            <div className="settings__row-title">启用语音输入</div>
            <div className="settings__row-desc">
              麦克风按钮：在输入框内按住说话；CapsLock：任意输入框按住说话，松开转写回写
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="启用语音输入"
            className={enabled ? "toggle is-on" : "toggle"}
            onClick={() => onPatch({ voiceInputEnabled: !enabled })}
          >
            <span className="toggle__thumb" />
          </button>
        </div>

        {enabled ? (
          <>
            <div className="voice-settings__hero" aria-hidden="true">
              <div className="voice-settings__hero-copy">
                <strong>说出来，记下来</strong>
                <span>在本机把语音变成文字</span>
              </div>
              <div className="voice-settings__hero-card">
                <span className="voice-settings__wave">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <span>转写结果</span>
              </div>
            </div>

            <div className="settings__row settings__row--stack">
              <div className="settings__row-main">
                <div className="settings__row-title">输入设备</div>
                <div className="settings__row-desc">
                  默认跟随系统麦克风；也可指定具体输入设备
                </div>
              </div>
              <div className="voice-settings__device">
                <select
                  className="settings__select voice-settings__device-select"
                  aria-label="输入设备"
                  value={prefs.voiceInputDeviceId}
                  onChange={(event) =>
                    onPatch({ voiceInputDeviceId: event.target.value })
                  }
                >
                  <option value="">{systemDefaultOptionLabel(defaultLabel)}</option>
                  {devices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
                <span
                  className="voice-settings__meter"
                  aria-hidden="true"
                  title="输入电平"
                >
                  {Array.from({ length: 8 }, (_, index) => {
                    const threshold = (index + 1) / 10;
                    const on = level >= threshold;
                    return (
                      <i
                        key={index}
                        className={on ? "is-on" : undefined}
                        style={{ animationDelay: `${index * 40}ms` }}
                      />
                    );
                  })}
                </span>
              </div>
            </div>

            <label className="settings__row settings__row--stack">
              <div className="settings__row-main">
                <div className="settings__row-title">识别引擎</div>
                <div className="settings__row-desc">{engineMeta.hint}</div>
              </div>
              <select
                className="settings__select"
                aria-label="识别引擎"
                value={prefs.voiceInputEngine}
                disabled={busy}
                onChange={(event) =>
                  onPatch({
                    voiceInputEngine: event.target.value as SpeechEngineId,
                  })
                }
              >
                {SPEECH_ENGINES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="settings__row settings__row--stack">
              <div className="settings__row-main">
                <div className="settings__row-title">识别语言</div>
                <div className="settings__row-desc">可自动检测，或指定语种提示</div>
              </div>
              <select
                className="settings__select"
                aria-label="识别语言"
                value={prefs.voiceInputLanguage}
                onChange={(event) =>
                  onPatch({
                    voiceInputLanguage: event.target.value as SpeechLanguage,
                  })
                }
              >
                {SPEECH_LANGUAGES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>

            <p className="settings__footnote">
              {engine === "funasr"
                ? "FunASR 首次使用会下载约 800MB 模型到本机配置目录，并需本机 Python。"
                : engine === "qwenctc"
                  ? "QwenCTC 以纯 CTC 模式运行；权重下载到本机配置目录，并需本机 Python 与 onnxruntime / transformers / loguru。"
                  : "音频在本机识别。SenseVoice 模型下载需要网络，可在常规设置中配置 HTTP 代理。"}
            </p>

            <div className="voice-settings__status">
              <button
                type="button"
                className="voice-settings__status-head"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                <div>
                  <div className="settings__row-title">{engineMeta.label}</div>
                  <div
                    className={
                      phase === "ready"
                        ? "voice-settings__badge is-ready"
                        : "voice-settings__badge"
                    }
                  >
                    {phase === "ready" ? "✓ " : busy ? "↓ " : ""}
                    {message.split("\n")[0]}
                  </div>
                  {busy || (progress && progress.phase !== "done") ? (
                    <div className="voice-settings__progress-row">
                      <div
                        className="voice-settings__progress"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progressPercent}
                        aria-label={progressLabel || "下载进度"}
                      >
                        <div
                          className="voice-settings__progress-bar"
                          style={{ width: `${progressPercent}%` }}
                        />
                        <span className="voice-settings__progress-text">
                          {progressLabel || "准备中…"}
                          {progress ? ` ${progressPercent}%` : ""}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="voice-settings__cancel"
                        onClick={(event) => {
                          event.stopPropagation();
                          void stopPrepare();
                        }}
                      >
                        终止
                      </button>
                    </div>
                  ) : null}
                </div>
                <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
              </button>
              {expanded ? (
                <div className="voice-settings__status-body">
                  <p>
                    {engine === "funasr"
                      ? phase === "ready"
                        ? "模型已就绪。启用后会预热 Python 常驻进程，避免每次冷启动。"
                        : "先检查本地模型目录；缺文件时请点击「开始准备」下载 Fun-ASR-Nano-GGUF 与 llama 运行库。"
                      : engine === "qwenctc"
                        ? phase === "ready"
                          ? "模型已就绪。启用后会预热 Python 常驻进程。"
                          : "先检查本地模型目录；缺文件时请点击「开始准备」从 Hugging Face（qwen-ctc / a7avg5）下载。"
                        : phase === "ready"
                          ? "模型文件已就绪。启用后会预热常驻识别进程，避免每次冷启动。"
                          : "先检查本地模型目录；缺文件时请点击「开始准备」下载约 240MB 的 INT8 模型与 VAD。"}
                  </p>
                  <p className="voice-settings__dir">
                    下载目录：
                    <code>{downloadDir}</code>
                  </p>
                  {phase !== "ready" ? (
                    <pre className="voice-settings__guide">{guide}</pre>
                  ) : null}
                  {busy ? (
                    <button
                      type="button"
                      className="voice-settings__cancel voice-settings__cancel--block"
                      onClick={() => void stopPrepare()}
                    >
                      终止下载
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="settings__save"
                      disabled={phase === "ready"}
                      onClick={() => void prepare()}
                    >
                      {phase === "ready" ? "已就绪" : "开始准备"}
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
