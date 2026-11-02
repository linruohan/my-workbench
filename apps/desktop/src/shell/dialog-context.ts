import { createContext } from "react";

export type AlertOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
};

export type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export type PromptOptions = {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

export type DialogApi = {
  alert: (opts: AlertOptions | string) => Promise<void>;
  confirm: (opts: ConfirmOptions | string) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
};

/** Isolated so Fast Refresh of Dialogs UI does not remint the context object. */
export const DialogContext = createContext<DialogApi | null>(null);
