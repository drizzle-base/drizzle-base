#!/bin/bash
# THROWAWAY SPIKE (P2) — write cost of each capture method, interleaved rounds (a shared, noisy Mac).
set -u
PSQL="docker exec -i drizzlebase-pg18 psql -U postgres -d spike -q -v ON_ERROR_STOP=1"
T=${T:-6}
for round in 1 2 3; do
  for v in none row stmt returning logical; do
    $PSQL -f /tmp/bench/setup_base.sql >/dev/null 2>&1 && $PSQL -f /tmp/bench/v_$v.sql >/dev/null 2>&1 || { echo "setup failed $v"; exit 1; }
    for wl in upd1 ins1 bulk; do
      f=$wl; [ "$v" = returning ] && f=${wl}_ret
      c=8; [ "$wl" = bulk ] && c=4
      out=$(docker exec drizzlebase-pg18 pgbench -U postgres -n -c $c -j 4 -T $T -f /tmp/bench/$f.pgb spike 2>&1)
      tps=$(echo "$out" | sed -n 's/^tps = \([0-9.]*\).*/\1/p' | head -1)
      lat=$(echo "$out" | sed -n 's/^latency average = \([0-9.]*\) ms/\1/p')
      echo "round=$round variant=$v wl=$wl tps=$tps lat_ms=$lat"
    done
    if [ "$v" = logical ]; then
      s=$(date +%s)
      n=$($PSQL -Atc "select count(*) from pg_logical_slot_get_changes('bench', null, null)")
      echo "round=$round variant=logical drain_changes=$n drain_s=$(( $(date +%s) - s ))"
    fi
    if [ "$v" = row ] || [ "$v" = stmt ]; then
      echo "round=$round variant=$v outbox_rows=$($PSQL -Atc 'select count(*) from _outbox') outbox_size=$($PSQL -Atc "select pg_size_pretty(pg_total_relation_size('_outbox'))")"
    fi
  done
done
echo DONE
