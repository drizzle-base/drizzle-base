# @drizzle-base/studio

A data browser for drizzle-base: browse Postgres tables, and see every committed write — from another tab, from
psql, from Drizzle Studio — arrive without a refresh. Private and in development (STUDIO-00).

The UI is written against `StudioDataSource` (`src/contract`). Today it runs on an in-memory mock (`./mock`) that is
live across browser tabs; later on drizzle-base's admin functions, which must pass the same conformance suite
(`test/conformance.ts`).

    bun run dev        # the playground on http://127.0.0.1:5488 (?latency=300 to slow the mock down)
    bun run test:unit  # bun test + happy-dom
    bun run test:e2e   # Playwright: the two-tab test

## Embedding

    <Studio dataSource={ds} />                                     // keeps its own view
    <Studio dataSource={ds} view={view} onViewChange={setView} />  // controlled: bind it to your router

`encodeView(view)` / `decodeView(search)` turn a view into query parameters (`?v=1&table=public.users&where=role.eq.admin&order=age.desc`)
and back; `change.history` says whether to push or replace. Filter values in a URL end up in history and server
logs: leave `where` out of the URL if that matters for your data. `storageKey` separates saved layouts of different
databases on one origin.

`onDirtyChange(dirty)` reports pending edits, so a host can warn before navigating away; the studio keeps
unsaved edits per table while the person moves around.

It is not Drizzle Studio and not affiliated with Drizzle; `NOTES.md` records what we observed in Drizzle Studio and
which decisions we took from it.
