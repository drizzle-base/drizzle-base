alter table bench replica identity full;
select pg_create_logical_replication_slot('bench', 'test_decoding');
