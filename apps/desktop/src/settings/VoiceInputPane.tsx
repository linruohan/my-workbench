import { useEffect, useRef, useState } from "react";
import { SPEECH_LANGUAGES, SPEECH_PROVIDER_NAME, type SpeechLanguage } from "@wb/domain";
import {
  ensureSenseVoice,
  micLockOwnerId,
  probeMicrophones,
  readSpeechStatus,
  Recording,
  subscribeMicLock,
  systemDefaultOptionLabel,
  warmSenseVoice,
  type MicrophoneDevice,
} from "../voice";
import type { AppPrefs } from "../lib/prefs";

const PREVIEW_LOCK_ID = "voice-preview";

type Props = {
  prefs: AppPrefs;
  onPatch: (partial: Partial<AppPrefs>) => void;
};

export function VoiceInputPane({ prefs, onPatch }: Props) {
  const enabled = prefs.voiceInputEnabled;
  const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
  const [defaultLabel, setDefaultLabel] = useState("");
  const [level, setLevel] = useState(0);
  const [phase, setPhase] = useState("unprepared");
  const [message, setMessage] = useState("正在检查本地资源…");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const previewRef = useRef<Recording | null>(null);
  const rafRef = useRef(0);

  const refreshStatus = async () => {
    const status = await readSpeechStatus();
    setPhase(status.phase);
    setMessage(status.message);
    return status;
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      const status = await readSpeechStatus();
      if (!live) return;
      setPhase(status.phase);
      setMessage(status.message);
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void probeMicrophones().then((choices) => {
      if (!live) return;
      setDefaultLabel(choices.defaultLabel);
      setDevices(choices.devices);
      const selected = prefs.voiceInputDeviceId.trim();
      if (selected && !choices.devices.some((device) => device.deviceId === selected)) {
        // Saved device disappeared — fall back to the OS default input.
        onPatch({ voiceInputDeviceId: "" });
      }
    });
    return () => {
      live = false;
    };
    // Only re-probe when voice input is turned on; device changes reuse the list.
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
      // Dictation owns the mic — wait until the lock is free.
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
      // Only resume preview after a foreign owner released the mic.
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
    setBusy(true);
    void ensureSenseVoice().then((result) => {
      if (!live) return;
      setBusy(false);
      if (result.ok === true) {
        setPhase(result.phase);
        setMessage("本地资源已准备，识别引擎保持热备。");
        void warmSenseVoice();
        return;
      }
      setPhase(result.phase);
      setMessage(result.message);
    });
    return () => {
      live = false;
    };
  }, [enabled]);

  const prepare = async () => {
    setBusy(true);
    setMessage("正在准备本地资源…");
    setPhase("loading");
    const result = await ensureSenseVoice();
    setBusy(false);
    if (result.ok === true) {
      setPhase("ready");
      setMessage("本地资源已准备，识别引擎保持热备。");
      void warmSenseVoice();
      await refreshStatus();
      return;
    }
    setPhase(result.phase);
    setMessage(result.message);
  };

  return (
    <section className="settings__pane">
      <header className="settings__pane-head">
        <h1 className="settings__title">语音输入</h1>
        <span className="settings__pill">实验性</span>
      </header>
      <p className="settings__row-desc" style={{ marginBottom: "1rem" }}>
        在本机使用 SenseVoice 转写录音，首次使用需安装依赖。识别在运行本机完成。
      </p>

      <div className="settings__card voice-settings">
        <div className="settings__row">
          <div>
            <div className="settings__row-title">启用语音输入</div>
            <div className="settings__row-desc">
              打开后可在 Agent 输入框使用麦克风，并展开初始化与设置
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
                <div className="settings__row-title">识别服务</div>
                <div className="settings__row-desc">当前仅支持本机 SenseVoice</div>
              </div>
              <select
                className="settings__select"
                aria-label="识别服务"
                value="sensevoice"
                disabled
              >
                <option value="sensevoice">{SPEECH_PROVIDER_NAME}</option>
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
              音频在本机识别。模型下载需要网络，可在常规设置中配置 HTTP 代理。
            </p>

            <div className="voice-settings__status">
              <button
                type="button"
                className="voice-settings__status-head"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                <div>
                  <div className="settings__row-title">{SPEECH_PROVIDER_NAME}</div>
                  <div
                    className={
                      phase === "ready"
                        ? "voice-settings__badge is-ready"
                        : "voice-settings__badge"
                    }
                  >
                    {phase === "ready" ? "✓ " : ""}
                    {message}
                  </div>
                </div>
                <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
              </button>
              {expanded ? (
                <div className="voice-settings__status-body">
                  <p>
                    {phase === "ready"
                      ? "模型文件已就绪。启用后会预热常驻识别进程，避免每次冷启动。"
                      : "需要下载约 240MB 的 INT8 模型与 VAD；若本机已有 DSH 缓存会优先导入。"}
                  </p>
                  <button
                    type="button"
                    className="settings__save"
                    disabled={busy || phase === "ready"}
                    onClick={() => void prepare()}
                  >
                    {busy ? "准备中…" : phase === "ready" ? "已就绪" : "开始准备"}
                  </button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
