import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { DialogProvider } from "../shell/Dialogs";
import { ThemeProvider } from "../theme/ThemeProvider";

function Providers(props: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <DialogProvider>{props.children}</DialogProvider>
    </ThemeProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  return render(ui, { wrapper: Providers, ...options });
}
