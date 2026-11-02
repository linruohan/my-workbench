import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { DialogProvider } from "./shell/Dialogs";
import { ThemeProvider } from "./theme/ThemeProvider";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <DialogProvider>
        <App />
      </DialogProvider>
    </ThemeProvider>
  </StrictMode>,
);
