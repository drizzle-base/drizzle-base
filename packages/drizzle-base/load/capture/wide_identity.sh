#!/bin/bash
# WAL per update and tps, REPLICA IDENTITY DEFAULT vs FULL, on a 20-column table with 4 indexes, 2 KB jsonb,
# 6 KB TOAST (spec P-M9). Interleaved rounds: the machine is shared. bash 3.2 safe.
set -u
psql_() { docker exec -i drizzlebase-pg psql -U postgres -d dzb_test -Atq -v ON_ERROR_STOP=1 "$@"; }
docker cp "$(dirname "$0")/wide_upd.pgb" drizzlebase-pg:/tmp/wide_upd.pgb >/dev/null
psql_ < "$(dirname "$0")/wide_setup.sql" >/dev/null
for round in 1 2 3; do
  for ri in default full; do
    psql_ -c "alter table rb_wide replica identity $ri"
    a=$(psql_ -c "select pg_current_wal_lsn()")
    out=$(docker exec drizzlebase-pg pgbench -U postgres -n -c 8 -j 4 -T 6 -f /tmp/wide_upd.pgb dzb_test 2>&1)
    b=$(psql_ -c "select pg_size_pretty(pg_current_wal_lsn() - '$a'::pg_lsn)")
    tps=$(echo "$out" | sed -n 's/^tps = \([0-9.]*\).*/\1/p' | head -1)
    echo "round=$round identity=$ri tps=$tps wal=$b"
  done
done
psql_ -c "drop table rb_wide"
