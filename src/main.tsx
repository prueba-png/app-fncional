import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LoginGate } from "./components/LoginGate";
import { initTheme } from "./lib/theme";
import "./styles.css";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LoginGate>
      <App />
    </LoginGate>
  </StrictMode>,
);
