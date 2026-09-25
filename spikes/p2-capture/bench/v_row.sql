create trigger _cap after insert or update or delete on bench for each row execute function _cap_row();
