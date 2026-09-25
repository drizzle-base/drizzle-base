// The library's only console writer. LOG_LEVEL = debug | info | warn | error (default info).
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const threshold = LEVELS[(process.env.LOG_LEVEL as Level | undefined) ?? "info"] ?? LEVELS.info;

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
	if (LEVELS[level] < threshold) return;
	const line = JSON.stringify({ level, msg, ...fields });
	if (level === "error" || level === "warn") console.error(line);
	else console.log(line);
}

export const log = {
	debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
	info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
	warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
	error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
