-- Review B probe: the P1 schema in its own schema `rb`, so P1's captured SQL runs unmodified.
drop schema if exists rb cascade; create schema rb; set search_path = rb;
create table users(id uuid primary key, name text not null, email text not null, age int, manager_id uuid, deleted bool not null default false, created_at timestamp not null default now());
create table posts(id int primary key, author_id uuid not null, title text not null, published bool not null default false, views int not null default 0, created_at timestamp not null default now());
create index posts_author on posts(author_id, created_at);
create table comments(id int primary key, post_id int not null, author_id uuid not null, body text not null);
create index comments_post on comments(post_id);
insert into users select ('00000000-0000-7000-8000-' || lpad(g::text, 12, '0'))::uuid, 'user ' || g, 'u' || g || '@x.io', 18 + g % 60, null, false, now() - (g || ' min')::interval from generate_series(1, 5000) g;
insert into posts select g, ('00000000-0000-7000-8000-' || lpad((1 + g % 5000)::text, 12, '0'))::uuid, 'post ' || md5(g::text), g % 2 = 0, g % 1000, now() - (g || ' s')::interval from generate_series(1, 50000) g;
insert into comments select g, 1 + g % 50000, ('00000000-0000-7000-8000-' || lpad((1 + g % 5000)::text, 12, '0'))::uuid, repeat(md5(g::text), 3) from generate_series(1, 200000) g;
vacuum analyze users, posts, comments;
