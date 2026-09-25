-- REVIEW-A probe: REPLICA IDENTITY FULL + publication + generated columns (PG 18).
-- docker exec -i drizzlebase-pg18 psql -U postgres -d spike < gen_cols.sql
drop publication if exists review_a_pub; drop table if exists g1, g2;
create table g1(id int primary key, a int, s int generated always as (a*10) stored); alter table g1 replica identity full; insert into g1 values(1,1);
create table g2(id int primary key, a int, v int generated always as (a*100) virtual); alter table g2 replica identity full; insert into g2 values(1,1);
create publication review_a_pub for table g1, g2;
update g1 set a = 2;   -- stored, publish_generated_columns = none (default)
update g2 set a = 2;   -- virtual
delete from g2;
alter publication review_a_pub set (publish_generated_columns = stored);
update g1 set a = 3;   -- stored, now published
update g2 set a = 3;   -- virtual: no option publishes it
drop publication review_a_pub; drop table g1, g2;
