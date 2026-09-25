-- Review B probe: a realistic "wide" row. 20 columns, 4 secondary indexes, a ~2 KB jsonb, a ~6 KB TOASTed text.
drop table if exists rb_wide;
create table rb_wide(
  id bigint primary key, owner_id bigint not null, status text not null, title text not null, slug text not null,
  body text, meta jsonb not null, views int not null default 0, score numeric(12,2) not null default 0,
  c1 text, c2 text, c3 text, c4 text, c5 int, c6 int, c7 bool, c8 timestamptz not null default now(),
  c9 timestamptz, c10 uuid not null default gen_random_uuid(), updated_at timestamptz not null default now());
insert into rb_wide(id, owner_id, status, title, slug, body, meta, c1, c2, c3, c4, c5, c6, c7)
select g, g % 1000, (array['draft','live','archived'])[1 + g % 3], 'title ' || md5(g::text), 'slug-' || md5((g*7)::text),
  (select string_agg(md5((g*1000+k)::text), '') from generate_series(1, 190) k),          -- ~6 KB, incompressible -> TOAST
  (select jsonb_object_agg('k' || k, md5((g*100+k)::text)) from generate_series(1, 45) k), -- ~2 KB jsonb
  md5('a'||g), md5('b'||g), md5('c'||g), md5('d'||g), g % 97, g % 13, g % 2 = 0
from generate_series(1, 20000) g;
create index on rb_wide(owner_id); create index on rb_wide(status, c8); create index on rb_wide(slug); create index on rb_wide(c10);
vacuum analyze rb_wide;
