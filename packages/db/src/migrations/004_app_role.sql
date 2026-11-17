-- 004 — application role
--
-- Row-level security does not apply to a table's owner, and migrations/seed need owner rights. So the
-- API and worker operate as a dedicated non-owner role: every request transaction switches to it,
-- which makes the policies in 002_rls.sql load-bearing rather than decorative.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bankbuddy_app') then
    create role bankbuddy_app nologin;
  end if;
end $$;

grant usage on schema public to bankbuddy_app;
grant select, insert, update, delete on all tables in schema public to bankbuddy_app;
grant usage, select on all sequences in schema public to bankbuddy_app;

alter default privileges in schema public grant select, insert, update, delete on tables to bankbuddy_app;
alter default privileges in schema public grant usage, select on sequences to bankbuddy_app;

-- Audit rows are readable by the role but never rewritable: the trigger in 003 refuses anyway.
revoke update, delete on audit_events from bankbuddy_app;
