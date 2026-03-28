import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import SanctionsChecker from "./SnowflakeSanctionsChecker"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SanctionsChecker />
  </StrictMode>
);
