import { parse } from "pgsql-ast-parser";
const s = `select "id", "name", "posts" from (select "users"."id", "users"."name", coalesce(json_agg(json_build_array("users_posts"."id")), '[]'::json) as "posts" from "users" left join lateral (select "users_posts"."id" from "posts" "users_posts" where "users_posts"."author_id" = "users"."id") "users_posts" on true where "users"."age" > $1 and "users"."name" ilike $2 group by "users"."id" order by "users"."id" limit $3) "users"`;
console.log(JSON.stringify(parse(s), null, 1).slice(0, 3000));
