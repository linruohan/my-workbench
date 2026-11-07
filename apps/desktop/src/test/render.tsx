import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { DialogOutlet, DialogProvider } from "../shell/Dialogs";
import { ThemeProvider } from "../theme/ThemeProvider";

type ExtraOptions = {
  /** App already mounts DialogOutlet; set false when rendering `<App />`. */
  dialogOutlet?: boolean;
};

function Providers(props: { children: ReactNode; dialogOutlet: boolean }) {
  return (
    <ThemeProvider>
      <DialogProvider>
        {props.children}
        {props.dialogOutlet ? <DialogOutlet /> : null}
      </DialogProvider>
    </ThemeProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper"> & ExtraOptions,
) {
  const { dialogOutlet = true, ...rest } = options ?? {};
  return render(ui, {
    wrapper: ({ children }) => (
      <Providers dialogOutlet={dialogOutlet}>{children}</Providers>
    ),
    ...rest,
  });
}
