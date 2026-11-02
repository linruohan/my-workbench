import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DialogContext,
  type AlertOptions,
  type ConfirmOptions,
  type DialogApi,
  type PromptOptions,
} from "./dialog-context";
import { IconClose } from "./icons";

export type { AlertOptions, ConfirmOptions, DialogApi, PromptOptions };

type AlertRequest = {
  kind: "alert";
  title: string;
  message: string;
  confirmLabel: string;
  resolve: () => void;
};

type ConfirmRequest = {
  kind: "confirm";
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
};

type PromptRequest = {
  kind: "prompt";
  title: string;
  label: string;
  initialValue: string;
  confirmLabel: string;
  cancelLabel: string;
  resolve: (value: string | null) => void;
};

type DialogRequest = AlertRequest | ConfirmRequest | PromptRequest;

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error("useDialog 需要 DialogProvider");
  }
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const active = queue[0] ?? null;

  const enqueue = useCallback((request: DialogRequest) => {
    setQueue((current) => [...current, request]);
  }, []);

  const finish = useCallback(() => {
    setQueue((current) => current.slice(1));
  }, []);

  const api = useMemo<DialogApi>(
    () => ({
      alert: (opts) =>
        new Promise<void>((resolve) => {
          const normalized =
            typeof opts === "string"
              ? { message: opts }
              : opts;
          enqueue({
            kind: "alert",
            title: normalized.title ?? "提示",
            message: normalized.message,
            confirmLabel: normalized.confirmLabel ?? "知道了",
            resolve: () => {
              finish();
              resolve();
            },
          });
        }),
      confirm: (opts) =>
        new Promise<boolean>((resolve) => {
          const normalized =
            typeof opts === "string"
              ? { message: opts }
              : opts;
          enqueue({
            kind: "confirm",
            title: normalized.title ?? "请确认",
            message: normalized.message,
            confirmLabel: normalized.confirmLabel ?? "确定",
            cancelLabel: normalized.cancelLabel ?? "取消",
            danger: normalized.danger,
            resolve: (ok) => {
              finish();
              resolve(ok);
            },
          });
        }),
      prompt: (opts) =>
        new Promise<string | null>((resolve) => {
          enqueue({
            kind: "prompt",
            title: opts.title,
            label: opts.label,
            initialValue: opts.initialValue ?? "",
            confirmLabel: opts.confirmLabel ?? "确定",
            cancelLabel: opts.cancelLabel ?? "取消",
            resolve: (value) => {
              finish();
              resolve(value);
            },
          });
        }),
    }),
    [enqueue, finish],
  );

  return (
    <DialogContext.Provider value={api}>
      {children}
      {active ? <DialogHost request={active} /> : null}
    </DialogContext.Provider>
  );
}

function DialogHost({ request }: { request: DialogRequest }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(
    request.kind === "prompt" ? request.initialValue : "",
  );

  useEffect(() => {
    if (request.kind !== "prompt") return;
    setValue(request.initialValue);
    const frame = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [request]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (request.kind === "confirm") request.resolve(false);
      else if (request.kind === "prompt") request.resolve(null);
      else request.resolve();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request]);

  const cancel = () => {
    if (request.kind === "confirm") request.resolve(false);
    else if (request.kind === "prompt") request.resolve(null);
    else request.resolve();
  };

  const submit = () => {
    if (request.kind === "alert") {
      request.resolve();
      return;
    }
    if (request.kind === "confirm") {
      request.resolve(true);
      return;
    }
    const next = value.trim();
    if (!next) return;
    request.resolve(next);
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={cancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && request.kind !== "prompt") {
            e.preventDefault();
            submit();
          }
          if (e.key === "Enter" && request.kind === "prompt") {
            e.preventDefault();
            submit();
          }
        }}
      >
        <header className="modal__header">
          <h2>{request.title}</h2>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={cancel}>
            <IconClose size={16} />
          </button>
        </header>

        <div className="modal__body">
          {request.kind === "prompt" ? (
            <div className="field">
              <label className="field__label" htmlFor={inputId}>
                {request.label}
              </label>
              <input
                ref={inputRef}
                id={inputId}
                className="date-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          ) : (
            <p className="modal__message">{request.message}</p>
          )}
        </div>

        <footer className="modal__footer">
          {request.kind !== "alert" ? (
            <button type="button" className="btn" onClick={cancel}>
              {request.cancelLabel}
            </button>
          ) : null}
          <button
            type="button"
            className={
              request.kind === "confirm" && request.danger
                ? "btn btn--danger"
                : "btn btn--primary"
            }
            disabled={request.kind === "prompt" && !value.trim()}
            onClick={submit}
            autoFocus={request.kind !== "prompt"}
          >
            {request.confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
