create trigger _cap_i after insert on bench referencing new table as n for each statement execute function _cap_ins();
create trigger _cap_u after update on bench referencing old table as o new table as n for each statement execute function _cap_upd();
