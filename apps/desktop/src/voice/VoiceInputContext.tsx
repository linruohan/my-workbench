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
import type { SpeechLanguage } from "@wb/domain";
import { ensureSenseVoice, readSpeechStatus } from "./speech-models";

export type VoiceInputConfig = {
  enabled: boolean;
  deviceId: string;
  language: SpeechLanguage;
  openSettings?: () => void;
};

type VoiceInputContextValue = VoiceInputConfig & {
  ready: boolean;
  status: string | null;
  setStatus: (message: string | null) => void;
  markReady: () => void;
};

const VoiceInputContext = createContext<VoiceInputContextValue | null>(null);

const STATUS_CLEAR_MS = 3500;

export function VoiceInputProvider({
  enabled,
  deviceId,
  language,
  openSettings,
  children,
}: VoiceInputConfig & { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [status, setStatusState] = useState<string | null>(null);
  const statusTimer = useRef(0);
  const statusToken = useRef(0);

  const setStatus = useCallback((message: string | null) => {
    window.clearTimeout(statusTimer.current);
    const token = (statusToken.current += 1);
    setStatusState(message);
    if (message == null) return;
    // Keep in-progress hints until replaced; auto-clear terminal messages.
    if (/正在|准备中/.test(message)) return;
    statusTimer.current = window.setTimeout(() => {
      if (statusToken.current === token) setStatusState(null);
    }, STATUS_CLEAR_MS);
  }, []);

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
    void (async () => {
      const statusResult = await readSpeechStatus();
      if (!live) return;
      if (statusResult.ready) {
        setReady(true);
        return;
      }
      const prepared = await ensureSenseVoice();
      if (!live) return;
      if (prepared.ok === true) setReady(true);
    })();
    return () => {
      live = false;
    };
  }, [enabled, setStatus]);

  const value = useMemo<VoiceInputContextValue>(
    () => ({
      enabled,
      deviceId,
      language,
      openSettings,
      ready,
      status,
      setStatus,
      markReady: () => setReady(true),
    }),
    [enabled, deviceId, language, openSettings, ready, status, setStatus],
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
      ready: false,
      status: null,
      setStatus: () => undefined,
      markReady: () => undefined,
    };
  }
  return value;
}
