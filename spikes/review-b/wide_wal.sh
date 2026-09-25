#!/bin/bash
# Review B probe: WAL bytes per update, REPLICA IDENTITY DEFAULT vs FULL, on rb_wide. 5000 updates per cell.
set -u
P="docker exec -i drizzlebase-pg18 psql -U postgres -d spike -Atq -v ON_ERROR_STOP=1"
for round in 1 2; do
for ri in default full; do
  $P -c "alter table rb_wide replica identity $ri"
  for wl in views status body; do
    case $wl in
      views)  stmt="update rb_wide set views = views + 1 where id = k";;
      status) stmt="update rb_wide set status = 'live', c8 = now() where id = k";;
      body)   stmt="update rb_wide set title = title || '' , meta = meta || '{\"x\":1}' where id = k";;
    esac
    :
    out=$($P <<SQL
select pg_current_wal_lsn() as a \gset
\timing on
do \$\$ declare k int; begin for i in 1..5000 loop k := 1 + (random()*19999)::int; $stmt; end loop; end \$\$;
\timing off
select (pg_current_wal_lsn() - :'a'::pg_lsn)::bigint / 5000;
SQL
)
    ms=$(echo "$out" | sed -n 's/^Time: \([0-9.]*\) ms.*/\1/p')
    b=$(echo "$out" | tail -1)
    echo "round=$round ri=$ri wl=$wl wal_bytes_per_update=$b total_ms=$ms"
  done
done
done
$P -c "alter table rb_wide replica identity default"
