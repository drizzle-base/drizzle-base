# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: two-tabs.e2e.ts >> an external write appears in every open tab without a refresh
- Location: e2e/two-tabs.e2e.ts:34:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('gridcell', { name: 'Set by psql', exact: true })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('gridcell', { name: 'Set by psql', exact: true }) with timeout 5000ms
  - waiting for getByRole('gridcell', { name: 'Set by psql', exact: true })

```

```yaml
- text: Mock latency 0 ms
- button "External write"
- button "Reset data"
- navigation "Tables":
  - combobox "Schema": public
  - searchbox "Search tables"
  - list:
    - listitem:
      - button "audit_log": audit_log 50
    - listitem:
      - button "comments": comments 2.00K
    - listitem:
      - button "posts": posts 1.50K
    - listitem:
      - button "users": users 3.00K
    - listitem:
      - button "published_posts"
- main:
  - text: public.users Live
  - button "Previous page" [disabled]
  - text: 1 - 50 of 3000
  - button "Next page"
  - 'button "Theme: system"'
  - grid:
    - row "id uuid email varchar(255) name text role role active boolean score numeric(10, 2) age integer profile jsonb tags text[] avatar bytea birthday date created_at timestamp with time zone updated_at timestamp":
      - columnheader "id uuid"
      - columnheader "email varchar(255)"
      - columnheader "name text"
      - columnheader "role role"
      - columnheader "active boolean"
      - columnheader "score numeric(10, 2)"
      - columnheader "age integer"
      - columnheader "profile jsonb"
      - columnheader "tags text[]"
      - columnheader "avatar bytea"
      - columnheader "birthday date"
      - columnheader "created_at timestamp with time zone"
      - columnheader "updated_at timestamp"
    - 'row "019b76da-abe8-708f-af49-b6f772632716 user1@example.com User 1 editor TRUE 1.30 64 {\"city\":\"Recife\",\"n\":1,\"nested\":{\"a\":false}} [\"t1\",\"x\"] NULL 1977-11-03 2026-01-01 00:01:00.000042+00 2026-01-01 01:00:00"':
      - gridcell "019b76da-abe8-708f-af49-b6f772632716"
      - gridcell "user1@example.com"
      - gridcell "User 1"
      - gridcell "editor"
      - gridcell "TRUE"
      - gridcell "1.30"
      - gridcell "64"
      - 'gridcell "{\"city\":\"Recife\",\"n\":1,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t1\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1977-11-03"
      - gridcell "2026-01-01 00:01:00.000042+00"
      - gridcell "2026-01-01 01:00:00"
    - 'row "019b76da-afd0-79c4-93a8-c3b7cf3c2563 user2@example.com User 2 viewer TRUE 2.60 27 {\"city\":\"Berlin\",\"n\":2,\"nested\":{\"a\":true}} [\"t2\",\"x\"] NULL 1993-09-02 2026-01-01 00:02:00.000127+00 2026-01-01 02:00:00"':
      - gridcell "019b76da-afd0-79c4-93a8-c3b7cf3c2563"
      - gridcell "user2@example.com"
      - gridcell "User 2"
      - gridcell "viewer"
      - gridcell "TRUE"
      - gridcell "2.60"
      - gridcell "27"
      - 'gridcell "{\"city\":\"Berlin\",\"n\":2,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t2\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1993-09-02"
      - gridcell "2026-01-01 00:02:00.000127+00"
      - gridcell "2026-01-01 02:00:00"
    - 'row "019b76da-b3b8-709d-93fb-64afebede10d user3@example.com User 3 admin TRUE 3.90 35 {\"city\":\"Berlin\",\"n\":3,\"nested\":{\"a\":false}} [\"t3\",\"x\"] NULL 1990-12-12 2026-01-01 00:03:00.000935+00 NULL"':
      - gridcell "019b76da-b3b8-709d-93fb-64afebede10d"
      - gridcell "user3@example.com"
      - gridcell "User 3"
      - gridcell "admin"
      - gridcell "TRUE"
      - gridcell "3.90"
      - gridcell "35"
      - 'gridcell "{\"city\":\"Berlin\",\"n\":3,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t3\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1990-12-12"
      - gridcell "2026-01-01 00:03:00.000935+00"
      - gridcell "NULL"
    - 'row "019b76da-b7a0-72af-a2f2-6165a881cd42 user4@example.com User 4 editor TRUE 5.20 36 {\"city\":\"Berlin\",\"n\":4,\"nested\":{\"a\":true}} [\"t0\",\"x\"] NULL 1981-11-28 2026-01-01 00:04:00.000143+00 2026-01-01 04:00:00"':
      - gridcell "019b76da-b7a0-72af-a2f2-6165a881cd42"
      - gridcell "user4@example.com"
      - gridcell "User 4"
      - gridcell "editor"
      - gridcell "TRUE"
      - gridcell "5.20"
      - gridcell "36"
      - 'gridcell "{\"city\":\"Berlin\",\"n\":4,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t0\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1981-11-28"
      - gridcell "2026-01-01 00:04:00.000143+00"
      - gridcell "2026-01-01 04:00:00"
    - 'row "019b76da-bb88-7851-a214-aa1883c4ffd0 user5@example.com User 5 viewer FALSE 6.50 28 {\"city\":\"Recife\",\"n\":5,\"nested\":{\"a\":false}} [\"t1\",\"x\"] NULL 2010-06-03 2026-01-01 00:05:00.000329+00 2026-01-01 05:00:00"':
      - gridcell "019b76da-bb88-7851-a214-aa1883c4ffd0"
      - gridcell "user5@example.com"
      - gridcell "User 5"
      - gridcell "viewer"
      - gridcell "FALSE"
      - gridcell "6.50"
      - gridcell "28"
      - 'gridcell "{\"city\":\"Recife\",\"n\":5,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t1\",\"x\"]"
      - gridcell "NULL"
      - gridcell "2010-06-03"
      - gridcell "2026-01-01 00:05:00.000329+00"
      - gridcell "2026-01-01 05:00:00"
    - 'row "019b76da-bf70-7d14-adcc-312684e4edaa user6@example.com User 6 admin TRUE 7.80 32 {\"city\":\"Lisboa\",\"n\":6,\"nested\":{\"a\":true}} [\"t2\",\"x\"] NULL 1982-08-18 2026-01-01 00:06:00.000204+00 NULL"':
      - gridcell "019b76da-bf70-7d14-adcc-312684e4edaa"
      - gridcell "user6@example.com"
      - gridcell "User 6"
      - gridcell "admin"
      - gridcell "TRUE"
      - gridcell "7.80"
      - gridcell "32"
      - 'gridcell "{\"city\":\"Lisboa\",\"n\":6,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t2\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1982-08-18"
      - gridcell "2026-01-01 00:06:00.000204+00"
      - gridcell "NULL"
    - 'row "019b76da-c358-7ef2-9510-c632d4e86a53 user7@example.com NULL editor TRUE 9.10 50 {\"city\":\"Berlin\",\"n\":7,\"nested\":{\"a\":false}} [\"t3\",\"x\"] NULL 2002-08-16 2026-01-01 00:07:00.00005+00 2026-01-01 07:00:00"':
      - gridcell "019b76da-c358-7ef2-9510-c632d4e86a53"
      - gridcell "user7@example.com"
      - gridcell "NULL"
      - gridcell "editor"
      - gridcell "TRUE"
      - gridcell "9.10"
      - gridcell "50"
      - 'gridcell "{\"city\":\"Berlin\",\"n\":7,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t3\",\"x\"]"
      - gridcell "NULL"
      - gridcell "2002-08-16"
      - gridcell "2026-01-01 00:07:00.00005+00"
      - gridcell "2026-01-01 07:00:00"
    - 'row "019b76da-c740-7aa0-856d-a5590e89a11d user8@example.com User 8 viewer TRUE 10.40 26 {\"city\":\"Berlin\",\"n\":8,\"nested\":{\"a\":true}} [\"t0\",\"x\"] NULL 1981-05-09 2026-01-01 00:08:00.000641+00 2026-01-01 08:00:00"':
      - gridcell "019b76da-c740-7aa0-856d-a5590e89a11d"
      - gridcell "user8@example.com"
      - gridcell "User 8"
      - gridcell "viewer"
      - gridcell "TRUE"
      - gridcell "10.40"
      - gridcell "26"
      - 'gridcell "{\"city\":\"Berlin\",\"n\":8,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t0\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1981-05-09"
      - gridcell "2026-01-01 00:08:00.000641+00"
      - gridcell "2026-01-01 08:00:00"
    - 'row "019b76da-cb28-78e1-912a-086c41ff0d16 user9@example.com User 9 admin TRUE 11.70 54 {\"city\":\"Lisboa\",\"n\":9,\"nested\":{\"a\":false}} [\"t1\",\"x\"] NULL 1985-10-17 2026-01-01 00:09:00.000712+00 NULL"':
      - gridcell "019b76da-cb28-78e1-912a-086c41ff0d16"
      - gridcell "user9@example.com"
      - gridcell "User 9"
      - gridcell "admin"
      - gridcell "TRUE"
      - gridcell "11.70"
      - gridcell "54"
      - 'gridcell "{\"city\":\"Lisboa\",\"n\":9,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t1\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1985-10-17"
      - gridcell "2026-01-01 00:09:00.000712+00"
      - gridcell "NULL"
    - 'row "019b76da-cf10-74f9-8802-932a90106aac user10@example.com User 10 editor FALSE 13.00 56 {\"city\":\"Berlin\",\"n\":10,\"nested\":{\"a\":true}} [\"t2\",\"x\"] \\x69643a3130 2009-05-10 2026-01-01 00:10:00.000022+00 2026-01-01 10:00:00"':
      - gridcell "019b76da-cf10-74f9-8802-932a90106aac"
      - gridcell "user10@example.com"
      - gridcell "User 10"
      - gridcell "editor"
      - gridcell "FALSE"
      - gridcell "13.00"
      - gridcell "56"
      - 'gridcell "{\"city\":\"Berlin\",\"n\":10,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t2\",\"x\"]"
      - gridcell "\\x69643a3130"
      - gridcell "2009-05-10"
      - gridcell "2026-01-01 00:10:00.000022+00"
      - gridcell "2026-01-01 10:00:00"
    - 'row "019b76da-d2f8-7e0d-b895-11a6088ad7c1 user11@example.com User 11 viewer TRUE 14.30 NULL {\"city\":\"Lisboa\",\"n\":11,\"nested\":{\"a\":false}} [\"t3\",\"x\"] NULL 2000-03-14 2026-01-01 00:11:00.000203+00 2026-01-01 11:00:00"':
      - gridcell "019b76da-d2f8-7e0d-b895-11a6088ad7c1"
      - gridcell "user11@example.com"
      - gridcell "User 11"
      - gridcell "viewer"
      - gridcell "TRUE"
      - gridcell "14.30"
      - gridcell "NULL"
      - 'gridcell "{\"city\":\"Lisboa\",\"n\":11,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t3\",\"x\"]"
      - gridcell "NULL"
      - gridcell "2000-03-14"
      - gridcell "2026-01-01 00:11:00.000203+00"
      - gridcell "2026-01-01 11:00:00"
    - 'row "019b76da-d6e0-7c12-bb0c-f5eda79632fa user12@example.com User 12 admin TRUE 15.60 20 {\"city\":\"Lisboa\",\"n\":12,\"nested\":{\"a\":true}} [\"t0\",\"x\"] NULL 1994-04-14 2026-01-01 00:12:00.000156+00 NULL"':
      - gridcell "019b76da-d6e0-7c12-bb0c-f5eda79632fa"
      - gridcell "user12@example.com"
      - gridcell "User 12"
      - gridcell "admin"
      - gridcell "TRUE"
      - gridcell "15.60"
      - gridcell "20"
      - 'gridcell "{\"city\":\"Lisboa\",\"n\":12,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t0\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1994-04-14"
      - gridcell "2026-01-01 00:12:00.000156+00"
      - gridcell "NULL"
    - 'row "019b76da-dac8-7f40-875f-a70a0cf2ae99 user13@example.com User 13 editor TRUE 16.90 42 {\"city\":\"Lisboa\",\"n\":13,\"nested\":{\"a\":false}} [\"t1\",\"x\"] NULL 1993-05-02 2026-01-01 00:13:00.000784+00 2026-01-01 13:00:00"':
      - gridcell "019b76da-dac8-7f40-875f-a70a0cf2ae99"
      - gridcell "user13@example.com"
      - gridcell "User 13"
      - gridcell "editor"
      - gridcell "TRUE"
      - gridcell "16.90"
      - gridcell "42"
      - 'gridcell "{\"city\":\"Lisboa\",\"n\":13,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t1\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1993-05-02"
      - gridcell "2026-01-01 00:13:00.000784+00"
      - gridcell "2026-01-01 13:00:00"
    - 'row "019b76da-deb0-76cb-b32e-6f8a61cac10c user14@example.com NULL viewer TRUE 18.20 64 {\"city\":\"Recife\",\"n\":14,\"nested\":{\"a\":true}} [\"t2\",\"x\"] NULL 1983-02-07 2026-01-01 00:14:00.000745+00 2026-01-01 14:00:00"':
      - gridcell "019b76da-deb0-76cb-b32e-6f8a61cac10c"
      - gridcell "user14@example.com"
      - gridcell "NULL"
      - gridcell "viewer"
      - gridcell "TRUE"
      - gridcell "18.20"
      - gridcell "64"
      - 'gridcell "{\"city\":\"Recife\",\"n\":14,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t2\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1983-02-07"
      - gridcell "2026-01-01 00:14:00.000745+00"
      - gridcell "2026-01-01 14:00:00"
    - 'row "019b76da-e298-7304-8e56-a2aca716e7ef user15@example.com User 15 admin FALSE 19.50 54 {\"city\":\"Recife\",\"n\":15,\"nested\":{\"a\":false}} [\"t3\",\"x\"] NULL 1996-03-25 2026-01-01 00:15:00.000619+00 NULL"':
      - gridcell "019b76da-e298-7304-8e56-a2aca716e7ef"
      - gridcell "user15@example.com"
      - gridcell "User 15"
      - gridcell "admin"
      - gridcell "FALSE"
      - gridcell "19.50"
      - gridcell "54"
      - 'gridcell "{\"city\":\"Recife\",\"n\":15,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t3\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1996-03-25"
      - gridcell "2026-01-01 00:15:00.000619+00"
      - gridcell "NULL"
    - 'row "019b76da-e680-7e5e-a073-087c4ce62885 user16@example.com User 16 editor TRUE 20.80 75 {\"city\":\"Lisboa\",\"n\":16,\"nested\":{\"a\":true}} [\"t0\",\"x\"] NULL 1991-02-28 2026-01-01 00:16:00.000484+00 2026-01-01 16:00:00"':
      - gridcell "019b76da-e680-7e5e-a073-087c4ce62885"
      - gridcell "user16@example.com"
      - gridcell "User 16"
      - gridcell "editor"
      - gridcell "TRUE"
      - gridcell "20.80"
      - gridcell "75"
      - 'gridcell "{\"city\":\"Lisboa\",\"n\":16,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t0\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1991-02-28"
      - gridcell "2026-01-01 00:16:00.000484+00"
      - gridcell "2026-01-01 16:00:00"
    - 'row "019b76da-ea68-7638-8085-832444a9162c user17@example.com User 17 viewer TRUE 22.10 50 {\"city\":\"Recife\",\"n\":17,\"nested\":{\"a\":false}} [\"t1\",\"x\"] NULL 1989-11-24 2026-01-01 00:17:00.000004+00 2026-01-01 17:00:00"':
      - gridcell "019b76da-ea68-7638-8085-832444a9162c"
      - gridcell "user17@example.com"
      - gridcell "User 17"
      - gridcell "viewer"
      - gridcell "TRUE"
      - gridcell "22.10"
      - gridcell "50"
      - 'gridcell "{\"city\":\"Recife\",\"n\":17,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t1\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1989-11-24"
      - gridcell "2026-01-01 00:17:00.000004+00"
      - gridcell "2026-01-01 17:00:00"
    - 'row "019b76da-ee50-759f-8698-6619a8051afe user18@example.com User 18 admin TRUE 23.40 47 {\"city\":\"Berlin\",\"n\":18,\"nested\":{\"a\":true}} [\"t2\",\"x\"] NULL 1990-03-28 2026-01-01 00:18:00.000019+00 NULL"':
      - gridcell "019b76da-ee50-759f-8698-6619a8051afe"
      - gridcell "user18@example.com"
      - gridcell "User 18"
      - gridcell "admin"
      - gridcell "TRUE"
      - gridcell "23.40"
      - gridcell "47"
      - 'gridcell "{\"city\":\"Berlin\",\"n\":18,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t2\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1990-03-28"
      - gridcell "2026-01-01 00:18:00.000019+00"
      - gridcell "NULL"
    - 'row "019b76da-f238-7e05-9dd6-cd9202a7875a user19@example.com User 19 editor TRUE 24.70 64 {\"city\":\"Berlin\",\"n\":19,\"nested\":{\"a\":false}} [\"t3\",\"x\"] NULL 1973-07-01 2026-01-01 00:19:00.000876+00 2026-01-01 19:00:00"':
      - gridcell "019b76da-f238-7e05-9dd6-cd9202a7875a"
      - gridcell "user19@example.com"
      - gridcell "User 19"
      - gridcell "editor"
      - gridcell "TRUE"
      - gridcell "24.70"
      - gridcell "64"
      - 'gridcell "{\"city\":\"Berlin\",\"n\":19,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t3\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1973-07-01"
      - gridcell "2026-01-01 00:19:00.000876+00"
      - gridcell "2026-01-01 19:00:00"
    - 'row "019b76da-f620-75d8-a55d-9d3e6b245b58 user20@example.com User 20 viewer FALSE 26.00 46 {\"city\":\"Lisboa\",\"n\":20,\"nested\":{\"a\":true}} [\"t0\",\"x\"] \\x69643a3230 1999-02-13 2026-01-01 00:20:00.000699+00 2026-01-01 20:00:00"':
      - gridcell "019b76da-f620-75d8-a55d-9d3e6b245b58"
      - gridcell "user20@example.com"
      - gridcell "User 20"
      - gridcell "viewer"
      - gridcell "FALSE"
      - gridcell "26.00"
      - gridcell "46"
      - 'gridcell "{\"city\":\"Lisboa\",\"n\":20,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t0\",\"x\"]"
      - gridcell "\\x69643a3230"
      - gridcell "1999-02-13"
      - gridcell "2026-01-01 00:20:00.000699+00"
      - gridcell "2026-01-01 20:00:00"
    - 'row "019b76da-fa08-71f4-b16a-685beb154280 user21@example.com NULL admin TRUE 27.30 22 {\"city\":\"Recife\",\"n\":21,\"nested\":{\"a\":false}} [\"t1\",\"x\"] NULL 1986-12-26 2026-01-01 00:21:00.000281+00 NULL"':
      - gridcell "019b76da-fa08-71f4-b16a-685beb154280"
      - gridcell "user21@example.com"
      - gridcell "NULL"
      - gridcell "admin"
      - gridcell "TRUE"
      - gridcell "27.30"
      - gridcell "22"
      - 'gridcell "{\"city\":\"Recife\",\"n\":21,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t1\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1986-12-26"
      - gridcell "2026-01-01 00:21:00.000281+00"
      - gridcell "NULL"
    - 'row "019b76da-fdf0-730a-a8fc-679a1a54ce5c user22@example.com User 22 editor TRUE 28.60 NULL {\"city\":\"Berlin\",\"n\":22,\"nested\":{\"a\":true}} [\"t2\",\"x\"] NULL 2010-07-02 2026-01-01 00:22:00.000845+00 2026-01-01 22:00:00"':
      - gridcell "019b76da-fdf0-730a-a8fc-679a1a54ce5c"
      - gridcell "user22@example.com"
      - gridcell "User 22"
      - gridcell "editor"
      - gridcell "TRUE"
      - gridcell "28.60"
      - gridcell "NULL"
      - 'gridcell "{\"city\":\"Berlin\",\"n\":22,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t2\",\"x\"]"
      - gridcell "NULL"
      - gridcell "2010-07-02"
      - gridcell "2026-01-01 00:22:00.000845+00"
      - gridcell "2026-01-01 22:00:00"
    - 'row "019b76db-01d8-7763-beb0-3dac0a9030b1 user23@example.com User 23 viewer TRUE 29.90 71 {\"city\":\"Recife\",\"n\":23,\"nested\":{\"a\":false}} [\"t3\",\"x\"] NULL 1985-10-06 2026-01-01 00:23:00.000043+00 2026-01-01 23:00:00"':
      - gridcell "019b76db-01d8-7763-beb0-3dac0a9030b1"
      - gridcell "user23@example.com"
      - gridcell "User 23"
      - gridcell "viewer"
      - gridcell "TRUE"
      - gridcell "29.90"
      - gridcell "71"
      - 'gridcell "{\"city\":\"Recife\",\"n\":23,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t3\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1985-10-06"
      - gridcell "2026-01-01 00:23:00.000043+00"
      - gridcell "2026-01-01 23:00:00"
    - 'row "019b76db-05c0-7ade-a1ea-950c3ae46fd2 user24@example.com User 24 admin TRUE 31.20 64 {\"city\":\"Recife\",\"n\":24,\"nested\":{\"a\":true}} [\"t0\",\"x\"] NULL 1992-11-13 2026-01-01 00:24:00.000359+00 NULL"':
      - gridcell "019b76db-05c0-7ade-a1ea-950c3ae46fd2"
      - gridcell "user24@example.com"
      - gridcell "User 24"
      - gridcell "admin"
      - gridcell "TRUE"
      - gridcell "31.20"
      - gridcell "64"
      - 'gridcell "{\"city\":\"Recife\",\"n\":24,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t0\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1992-11-13"
      - gridcell "2026-01-01 00:24:00.000359+00"
      - gridcell "NULL"
    - 'row "019b76db-09a8-7136-882f-507350aff3c8 user25@example.com User 25 editor FALSE 32.50 32 {\"city\":\"Berlin\",\"n\":25,\"nested\":{\"a\":false}} [\"t1\",\"x\"] NULL 1972-05-03 2026-01-01 00:25:00.000077+00 2026-01-02 01:00:00"':
      - gridcell "019b76db-09a8-7136-882f-507350aff3c8"
      - gridcell "user25@example.com"
      - gridcell "User 25"
      - gridcell "editor"
      - gridcell "FALSE"
      - gridcell "32.50"
      - gridcell "32"
      - 'gridcell "{\"city\":\"Berlin\",\"n\":25,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t1\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1972-05-03"
      - gridcell "2026-01-01 00:25:00.000077+00"
      - gridcell "2026-01-02 01:00:00"
    - 'row "019b76db-0d90-76da-8457-697bbb0766db user26@example.com User 26 viewer TRUE 33.80 30 {\"city\":\"Berlin\",\"n\":26,\"nested\":{\"a\":true}} [\"t2\",\"x\"] NULL 1999-06-25 2026-01-01 00:26:00.000909+00 2026-01-02 02:00:00"':
      - gridcell "019b76db-0d90-76da-8457-697bbb0766db"
      - gridcell "user26@example.com"
      - gridcell "User 26"
      - gridcell "viewer"
      - gridcell "TRUE"
      - gridcell "33.80"
      - gridcell "30"
      - 'gridcell "{\"city\":\"Berlin\",\"n\":26,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t2\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1999-06-25"
      - gridcell "2026-01-01 00:26:00.000909+00"
      - gridcell "2026-01-02 02:00:00"
    - 'row "019b76db-1178-7f07-8291-9115749124bd user27@example.com User 27 admin TRUE 35.10 46 {\"city\":\"Lisboa\",\"n\":27,\"nested\":{\"a\":false}} [\"t3\",\"x\"] NULL 2010-10-30 2026-01-01 00:27:00.000757+00 NULL"':
      - gridcell "019b76db-1178-7f07-8291-9115749124bd"
      - gridcell "user27@example.com"
      - gridcell "User 27"
      - gridcell "admin"
      - gridcell "TRUE"
      - gridcell "35.10"
      - gridcell "46"
      - 'gridcell "{\"city\":\"Lisboa\",\"n\":27,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t3\",\"x\"]"
      - gridcell "NULL"
      - gridcell "2010-10-30"
      - gridcell "2026-01-01 00:27:00.000757+00"
      - gridcell "NULL"
    - 'row "019b76db-1560-7f13-8899-15ab58bfaecb user28@example.com NULL editor TRUE 36.40 37 {\"city\":\"Berlin\",\"n\":28,\"nested\":{\"a\":true}} [\"t0\",\"x\"] NULL 2002-09-05 2026-01-01 00:28:00.000497+00 2026-01-02 04:00:00"':
      - gridcell "019b76db-1560-7f13-8899-15ab58bfaecb"
      - gridcell "user28@example.com"
      - gridcell "NULL"
      - gridcell "editor"
      - gridcell "TRUE"
      - gridcell "36.40"
      - gridcell "37"
      - 'gridcell "{\"city\":\"Berlin\",\"n\":28,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t0\",\"x\"]"
      - gridcell "NULL"
      - gridcell "2002-09-05"
      - gridcell "2026-01-01 00:28:00.000497+00"
      - gridcell "2026-01-02 04:00:00"
    - 'row "019b76db-1948-7cfe-91d7-626738f80f8a user29@example.com User 29 viewer TRUE 37.70 18 {\"city\":\"Berlin\",\"n\":29,\"nested\":{\"a\":false}} [\"t1\",\"x\"] NULL 2003-05-02 2026-01-01 00:29:00.00078+00 2026-01-02 05:00:00"':
      - gridcell "019b76db-1948-7cfe-91d7-626738f80f8a"
      - gridcell "user29@example.com"
      - gridcell "User 29"
      - gridcell "viewer"
      - gridcell "TRUE"
      - gridcell "37.70"
      - gridcell "18"
      - 'gridcell "{\"city\":\"Berlin\",\"n\":29,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t1\",\"x\"]"
      - gridcell "NULL"
      - gridcell "2003-05-02"
      - gridcell "2026-01-01 00:29:00.00078+00"
      - gridcell "2026-01-02 05:00:00"
    - 'row "019b76db-1d30-7ea0-ba7f-892b28436106 user30@example.com User 30 admin FALSE 39.00 21 {\"city\":\"Lisboa\",\"n\":30,\"nested\":{\"a\":true}} [\"t2\",\"x\"] \\x69643a3330 1976-10-29 2026-01-01 00:30:00.000297+00 NULL"':
      - gridcell "019b76db-1d30-7ea0-ba7f-892b28436106"
      - gridcell "user30@example.com"
      - gridcell "User 30"
      - gridcell "admin"
      - gridcell "FALSE"
      - gridcell "39.00"
      - gridcell "21"
      - 'gridcell "{\"city\":\"Lisboa\",\"n\":30,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t2\",\"x\"]"
      - gridcell "\\x69643a3330"
      - gridcell "1976-10-29"
      - gridcell "2026-01-01 00:30:00.000297+00"
      - gridcell "NULL"
    - 'row "019b76db-2118-7d8f-9558-469771490239 user31@example.com User 31 editor TRUE 40.30 39 {\"city\":\"Recife\",\"n\":31,\"nested\":{\"a\":false}} [\"t3\",\"x\"] NULL 2008-05-21 2026-01-01 00:31:00.000044+00 2026-01-02 07:00:00"':
      - gridcell "019b76db-2118-7d8f-9558-469771490239"
      - gridcell "user31@example.com"
      - gridcell "User 31"
      - gridcell "editor"
      - gridcell "TRUE"
      - gridcell "40.30"
      - gridcell "39"
      - 'gridcell "{\"city\":\"Recife\",\"n\":31,\"nested\":{\"a\":false}}"'
      - gridcell "[\"t3\",\"x\"]"
      - gridcell "NULL"
      - gridcell "2008-05-21"
      - gridcell "2026-01-01 00:31:00.000044+00"
      - gridcell "2026-01-02 07:00:00"
    - 'row "019b76db-2500-7d22-8b9b-3a5fc3454a04 user32@example.com User 32 viewer TRUE 41.60 77 {\"city\":\"Lisboa\",\"n\":32,\"nested\":{\"a\":true}} [\"t0\",\"x\"] NULL 1982-06-26 2026-01-01 00:32:00.000673+00 2026-01-02 08:00:00"':
      - gridcell "019b76db-2500-7d22-8b9b-3a5fc3454a04"
      - gridcell "user32@example.com"
      - gridcell "User 32"
      - gridcell "viewer"
      - gridcell "TRUE"
      - gridcell "41.60"
      - gridcell "77"
      - 'gridcell "{\"city\":\"Lisboa\",\"n\":32,\"nested\":{\"a\":true}}"'
      - gridcell "[\"t0\",\"x\"]"
      - gridcell "NULL"
      - gridcell "1982-06-26"
      - gridcell "2026-01-01 00:32:00.000673+00"
      - gridcell "2026-01-02 08:00:00"
```

# Test source

```ts
  1   | // The realtime promise in a real browser: tabs of one origin share the mock's log, and a write from any of them —
  2   | // or from "outside" — reaches every open page without a refresh. Each test gets a fresh context: empty storage.
  3   | import { expect, type Page as Tab, test } from "@playwright/test";
  4   | import type { Page } from "../src/contract";
  5   | 
  6   | const USERS = { schema: "public", name: "users" };
  7   | 
  8   | async function openUsers(tab: Tab) {
  9   |   await tab.goto("/");
  10  |   await tab.getByRole("button", { name: "users", exact: true }).click();
  11  |   await expect(tab.getByRole("gridcell", { name: "user1@example.com", exact: true })).toBeVisible();
  12  | }
  13  | 
  14  | /** The id of user1, read through the data source like any client would. */
  15  | function user1Id(tab: Tab) {
  16  |   return tab.evaluate(async (users) => {
  17  |     const ds = window.__dzbMock;
  18  |     if (!ds) throw new Error("the playground did not expose __dzbMock");
  19  |     const page = await new Promise<Page>((resolve, reject) => {
  20  |       const stop = ds.subscribePage(
  21  |         { table: users, filters: [{ column: "email", op: "eq", value: "user1@example.com" }], sort: [], limit: 1, offset: 0 },
  22  |         (p) => {
  23  |           stop();
  24  |           resolve(p);
  25  |         },
  26  |         reject,
  27  |       );
  28  |     });
  29  |     // users.id is a uuid: text on the wire.
  30  |     return String(page.rows[0]?.["id"]);
  31  |   }, USERS);
  32  | }
  33  | 
  34  | test("an external write appears in every open tab without a refresh", async ({ context }) => {
  35  |   const a = await context.newPage();
  36  |   const b = await context.newPage();
  37  |   const psql = await context.newPage();
  38  |   await openUsers(a);
  39  |   await openUsers(b);
  40  |   await psql.goto("/");
  41  |   const id = await user1Id(psql);
  42  |   await psql.evaluate(
  43  |     async ({ users, id }) => {
  44  |       await window.__dzbMock?.externalWrite({
  45  |         kind: "update",
  46  |         table: users,
  47  |         changes: [{ key: { id }, values: { name: "Set by psql" } }],
  48  |       });
  49  |     },
  50  |     { users: USERS, id },
  51  |   );
  52  |   for (const tab of [a, b]) {
  53  |     const cell = tab.getByRole("gridcell", { name: "Set by psql", exact: true });
> 54  |     await expect(cell).toBeVisible();
      |                        ^ Error: expect(locator).toBeVisible() failed
  55  |     await expect(cell).toHaveAttribute("data-changed", "true");
  56  |   }
  57  | });
  58  | 
  59  | test("a write in one tab appears in the other", async ({ context }) => {
  60  |   const a = await context.newPage();
  61  |   const b = await context.newPage();
  62  |   await openUsers(a);
  63  |   await openUsers(b);
  64  |   const id = await user1Id(a);
  65  |   await a.evaluate(
  66  |     async ({ users, id }) => {
  67  |       await window.__dzbMock?.updateRows(users, [{ key: { id }, values: { name: "Set in tab A" } }]);
  68  |     },
  69  |     { users: USERS, id },
  70  |   );
  71  |   await expect(b.getByRole("gridcell", { name: "Set in tab A", exact: true })).toBeVisible();
  72  | });
  73  | 
  74  | test("writes from two tabs at once converge: every open page ends with all of them", async ({ context }) => {
  75  |   const a = await context.newPage();
  76  |   const b = await context.newPage();
  77  |   await a.goto("/");
  78  |   await b.goto("/");
  79  |   // Each tab keeps a live subscription open from before the writes; only pushes can bring the other tab's rows.
  80  |   const watch = (tab: Tab) =>
  81  |     tab.evaluate(() => {
  82  |       const ds = window.__dzbMock;
  83  |       if (!ds) throw new Error("no __dzbMock");
  84  |       const w = window as unknown as { __ids?: unknown[] };
  85  |       ds.subscribePage(
  86  |         {
  87  |           table: { schema: "billing", name: "invoices" },
  88  |           filters: [{ column: "status", op: "like", value: "concurrent-%" }],
  89  |           sort: [],
  90  |           limit: 100,
  91  |           offset: 0,
  92  |         },
  93  |         (p) => {
  94  |           w.__ids = p.rows.map((r) => r["id"]);
  95  |         },
  96  |         () => {},
  97  |       );
  98  |     });
  99  |   await watch(a);
  100 |   await watch(b);
  101 |   const insertTen = (tab: Tab, who: string) =>
  102 |     tab.evaluate(async (who) => {
  103 |       const invoices = { schema: "billing", name: "invoices" };
  104 |       for (let i = 0; i < 10; i++) {
  105 |         await window.__dzbMock?.insertRows(invoices, [{ amount_cents: 1, status: `concurrent-${who}-${i}` }]);
  106 |       }
  107 |     }, who);
  108 |   await Promise.all([insertTen(a, "a"), insertTen(b, "b")]);
  109 |   const ids = (tab: Tab) => tab.evaluate(() => (window as unknown as { __ids?: unknown[] }).__ids ?? []);
  110 |   await expect.poll(async () => (await ids(a)).length).toBe(20);
  111 |   await expect.poll(async () => (await ids(b)).length).toBe(20);
  112 |   expect(await ids(a)).toEqual(await ids(b));
  113 |   expect(new Set(await ids(a)).size).toBe(20);
  114 | });
  115 | 
  116 | test("the schema selector switches the sidebar to another schema", async ({ page }) => {
  117 |   await page.goto("/");
  118 |   await page.getByRole("combobox", { name: "Schema" }).click();
  119 |   await page.getByRole("option", { name: "billing" }).click();
  120 |   await page.getByRole("button", { name: "invoices", exact: true }).click();
  121 |   await expect(page.getByRole("columnheader", { name: /amount_cents/ })).toBeVisible();
  122 | });
  123 | 
```