import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SpeechEngineId, SpeechLanguage } from "@wb/domain";
import { useDialog } from "../shell/Dialogs";
import { startCapsLockPtt } from "./caps-lock-ptt";
import {
  readSpeechStatus,
  speechMissingModelMessage,
  warmSpeechEngine,
} from "./speech-models";

export type VoiceInputConfig = {
  enabled: boolean;
  deviceId: string;
  language: SpeechLanguage;
  engine: SpeechEngineId;
  openSettings?: () => void;
};

type VoiceInputContextValue = VoiceInputConfig & {
  ready: boolean;
  status: string | null;
  setStatus: (message: string | null) => void;
  markReady: () => void;
  /** Short status + modal with download guide when models are missing. */
  notifyMissingModel: (engine?: SpeechEngineId, modelDir?: string) => void;
};

const VoiceInputContext = createContext<VoiceInputContextValue | null>(null);

const STATUS_CLEAR_MS = 3500;

export function VoiceInputProvider({
  enabled,
  deviceId,
  language,
  engine,
  openSettings,
  children,
}: VoiceInputConfig & { children: ReactNode }) {
  const dialog = useDialog();
  const [ready, setReady] = useState(false);
  const [status, setStatusState] = useState<string | null>(null);
  const statusTimer = useRef(0);
  const statusToken = useRef(0);
  const missingDialogOpen = useRef(false);

  const setStatus = useCallback((message: string | null) => {
    window.clearTimeout(statusTimer.current);
    const token = (statusToken.current += 1);
    setStatusState(message);
    if (message == null) return;
    // Keep in-progress hints until replaced; auto-clear terminal messages.
    // In-progress hold/transcribe stay until replaced; everything else auto-clears.
    if (/正在|准备中|录音中/.test(message)) return;
    statusTimer.current = window.setTimeout(() => {
      if (statusToken.current === token) setStatusState(null);
    }, STATUS_CLEAR_MS);
  }, []);

  const notifyMissingModel = useCallback(
    (nextEngine?: SpeechEngineId, modelDir?: string) => {
      const useEngine = nextEngine ?? engine;
      setStatus("请先准备语音模型");
      if (missingDialogOpen.current) return;
      missingDialogOpen.current = true;
      const guide = speechMissingModelMessage(useEngine, modelDir);
      void dialog
        .confirm({
          title: "语音模型未就绪",
          message: guide,
          confirmLabel: "去设置准备",
          cancelLabel: "知道了",
        })
        .then((go) => {
          if (go) openSettings?.();
        })
        .finally(() => {
          missingDialogOpen.current = false;
        });
    },
    [dialog, engine, openSettings, setStatus],
  );

  useEffect(() => {
    return () => window.clearTimeout(statusTimer.current);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      setStatus(null);
      return;
    }
    let live = true;
    const options = { engine };
    void (async () => {
      const statusResult = await readSpeechStatus(options);
      if (!live) return;
      if (statusResult.ready) {
        setReady(true);
        void warmSpeechEngine(options);
        return;
      }
      setReady(false);
    })();
    return () => {
      live = false;
    };
  }, [enabled, engine, setStatus]);

  const capsOptsRef = useRef({
    enabled,
    deviceId,
    language,
    engine,
    setStatus,
    markReady: () => setReady(true),
    openSettings,
    notifyMissingModel,
  });
  capsOptsRef.current = {
    enabled,
    deviceId,
    language,
    engine,
    setStatus,
    markReady: () => setReady(true),
    openSettings,
    notifyMissingModel,
  };

  useEffect(() => {
    if (!enabled) return;
    return startCapsLockPtt(() => capsOptsRef.current);
  }, [enabled]);

  const value = useMemo<VoiceInputContextValue>(
    () => ({
      enabled,
      deviceId,
      language,
      engine,
      openSettings,
      ready,
      status,
      setStatus,
      markReady: () => setReady(true),
      notifyMissingModel,
    }),
    [
      enabled,
      deviceId,
      language,
      engine,
      openSettings,
      ready,
      status,
      setStatus,
      notifyMissingModel,
    ],
  );

  return (
    <VoiceInputContext.Provider value={value}>{children}</VoiceInputContext.Provider>
  );
}

export function useVoiceInput(): VoiceInputContextValue {
  const value = useContext(VoiceInputContext);
  if (!value) {
    return {
      enabled: false,
      deviceId: "",
      language: "auto",
      engine: "sensevoice",
      ready: false,
      status: null,
      setStatus: () => undefined,
      markReady: () => undefined,
      notifyMissingModel: () => undefined,
    };
  }
  return value;
}
