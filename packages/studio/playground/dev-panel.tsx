import type { MockDataSource, MockLog } from "../src/mock";
import { Button } from "../src/ui/button";

/** Mock-only controls: writes "from outside" (as psql or Drizzle Studio would), and a reset for every tab. */
export function DevPanel({ source, log, latencyMs }: { source: MockDataSource; log: MockLog; latencyMs: number }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/50 px-3 text-xs text-muted-foreground">
      <span className="font-medium">Mock</span>
      <span>latency {latencyMs} ms</span>
      <Button type="button" size="xs" variant="outline" onClick={() => void source.externalWrite()}>
        External write
      </Button>
      <Button type="button" size="xs" variant="ghost" onClick={() => void log.reset()}>
        Reset data
      </Button>
    </div>
  );
}
