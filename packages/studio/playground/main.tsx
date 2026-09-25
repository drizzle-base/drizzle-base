import "../src/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Studio } from "../src";
import { createBrowserLog, createMockDataSource, demoDataset } from "../src/mock";
import { DevPanel } from "./dev-panel";

const latencyMs = Number(new URLSearchParams(location.search).get("latency") ?? "0");
const log = createBrowserLog("playground");
const dataSource = createMockDataSource({ dataset: demoDataset(1), log, latencyMs, seed: Date.now() });
window.__dzbMock = dataSource;

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");
createRoot(root).render(
  <StrictMode>
    <div className="flex h-full flex-col">
      <DevPanel source={dataSource} log={log} latencyMs={latencyMs} />
      <div className="min-h-0 flex-1">
        <Studio dataSource={dataSource} />
      </div>
    </div>
  </StrictMode>,
);
