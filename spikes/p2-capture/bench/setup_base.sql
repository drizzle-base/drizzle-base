drop table if exists bench, _outbox cascade;
select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name = 'bench';
create table bench(id bigserial primary key, v int not null, t text not null, ts timestamp not null default now());
insert into bench(v, t) select g % 100, md5(g::text) from generate_series(1, 100000) g;
create table _outbox(id bigserial primary key, xid xid8 not null default pg_current_xact_id(), tbl text not null, op text not null, old jsonb, new jsonb);
create or replace function _cap_row() returns trigger language plpgsql as $$
begin
  insert into _outbox(tbl, op, old, new) values (tg_table_name, tg_op,
    case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;
create or replace function _cap_ins() returns trigger language plpgsql as $$
begin insert into _outbox(tbl, op, new) select tg_table_name, 'INSERT', to_jsonb(n) from n; return null; end $$;
create or replace function _cap_upd() returns trigger language plpgsql as $$
begin
  insert into _outbox(tbl, op, old) select tg_table_name, 'UPDATE', to_jsonb(o) from o;
  insert into _outbox(tbl, op, new) select tg_table_name, 'UPDATE', to_jsonb(n) from n;
  return null;
end $$;
vacuum analyze bench;
checkpoint;
