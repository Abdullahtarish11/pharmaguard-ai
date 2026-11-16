-- ============================================================================
-- PharmaGuard AI — سياسات الوصول (RLS) لمشروع Supabase القائم
-- ============================================================================
-- هذا الملف:
--   * لا يُنشئ أي جدول، ولا يحذف، ولا يعيد تسمية أي جدول.
--   * لا يُدخل أي بيانات تجريبية.
--   * يفعّل RLS على الجداول الـ11 الموجودة.
--   * ينشئ سياسات لأدوار: owner / pharmacist / inventory_manager.
--   * يمنع ترقية أي مستخدم نفسه إلى owner (سياسة + trigger).
--   * يضيف دالتين للتشخيص: pg_rls_status() و pg_selftest().
--
-- التشغيل: Supabase → SQL Editor → الصق الملف كاملًا → Run.
-- آمن للتشغيل أكثر من مرة (idempotent).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1) دوال مساعدة: دور المستخدم الحالي وصيدليته (تُقرأ من profiles فقط)
--    SECURITY DEFINER حتى لا تحدث حلقة RLS عند استدعائها من داخل السياسات.
-- ---------------------------------------------------------------------------
do $pg$
declare
  v_id_col    text;
  v_role_col  text;
  v_pharm_col text;
begin
  select c.column_name into v_id_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'profiles'
     and c.column_name in ('id', 'user_id', 'profile_id')
   order by array_position(array['id', 'user_id', 'profile_id'], c.column_name)
   limit 1;

  select c.column_name into v_role_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'profiles'
     and c.column_name in ('role', 'user_role', 'account_role', 'role_name')
   order by array_position(array['role', 'user_role', 'account_role', 'role_name'], c.column_name)
   limit 1;

  select c.column_name into v_pharm_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'profiles'
     and c.column_name in ('pharmacy_id', 'pharmacy', 'store_id', 'pharmacies_id')
   order by array_position(array['pharmacy_id', 'pharmacy', 'store_id', 'pharmacies_id'], c.column_name)
   limit 1;

  if v_id_col is null then
    raise exception 'PharmaGuard: لم يُعثر على عمود المعرّف في جدول profiles (id/user_id/profile_id).';
  end if;

  -- 1.1 دور المستخدم الحالي (مع توحيد الأسماء المرادفة)
  if v_role_col is null then
    raise notice 'PharmaGuard: لا يوجد عمود دور في profiles — ستُعامل كل الحسابات كأدوار غير محددة.';
    execute $fn$
      create or replace function public.pg_role() returns text
      language sql stable security definer set search_path = public, pg_temp
      as $body$ select null::text $body$;
    $fn$;
  else
    execute format($fn$
      create or replace function public.pg_role() returns text
      language sql stable security definer set search_path = public, pg_temp
      as $body$
        select case lower(btrim(p.%1$I::text))
                 when 'owner' then 'owner'
                 when 'pharmacy_owner' then 'owner'
                 when 'pharmacy-owner' then 'owner'
                 when 'pharmacist' then 'pharmacist'
                 when 'inventory' then 'inventory_manager'
                 when 'inventory_manager' then 'inventory_manager'
                 when 'inventory-manager' then 'inventory_manager'
                 when 'stock_manager' then 'inventory_manager'
                 else lower(btrim(p.%1$I::text))
               end
          from public.profiles p
         where p.%2$I::text = auth.uid()::text
         limit 1
      $body$;
    $fn$, v_role_col, v_id_col);
  end if;

  -- 1.2 صيدلية المستخدم الحالي
  if v_pharm_col is null then
    raise notice 'PharmaGuard: لا يوجد عمود صيدلية في profiles — ستكون السياسات على مستوى الدور فقط.';
    execute $fn$
      create or replace function public.pg_pharmacy() returns text
      language sql stable security definer set search_path = public, pg_temp
      as $body$ select null::text $body$;
    $fn$;
  else
    execute format($fn$
      create or replace function public.pg_pharmacy() returns text
      language sql stable security definer set search_path = public, pg_temp
      as $body$
        select p.%1$I::text
          from public.profiles p
         where p.%2$I::text = auth.uid()::text
         limit 1
      $body$;
    $fn$, v_pharm_col, v_id_col);
  end if;
end $pg$;

revoke all on function public.pg_role() from public;
revoke all on function public.pg_pharmacy() from public;
grant execute on function public.pg_role() to authenticated, service_role;
grant execute on function public.pg_pharmacy() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) تفعيل RLS على الجداول الـ11 (بدون أي تغيير في بنيتها)
-- ---------------------------------------------------------------------------
do $pg$
declare
  t text;
  v_tables text[] := array[
    'profiles', 'pharmacies', 'medicines', 'inventory_batches', 'stock_movements',
    'inventory_alerts', 'notifications', 'device_tokens', 'drug_interactions',
    'agent_runs', 'reports'
  ];
begin
  foreach t in array v_tables loop
    if exists (
      select 1 from information_schema.tables
       where table_schema = 'public' and table_name = t
    ) then
      execute format('alter table public.%I enable row level security', t);
      -- الزوار المجهولون لا يملكون أي صلاحية مباشرة على الجداول
      execute format('revoke all on table public.%I from anon', t);
    else
      raise notice 'PharmaGuard: الجدول public.% غير موجود — تم تجاوزه.', t;
    end if;
  end loop;
end $pg$;

-- ---------------------------------------------------------------------------
-- 3) سياسات جدول profiles
--    - كل مستخدم يرى صفه، وموظفو نفس الصيدلية يرى بعضهم.
--    - لا إدراج إلا لصف المستخدم نفسه بدور مسموح (المالك يُنشأ من السيرفر).
--    - لا يمكن تغيير الدور أو الصيدلية من العميل (trigger في القسم 5).
-- ---------------------------------------------------------------------------
do $pg$
declare
  v_id_col    text;
  v_pharm_col text;
  v_role_col  text;
  v_own       text;
  v_same      text;
begin
  select c.column_name into v_id_col
    from information_schema.columns c
   where c.table_schema='public' and c.table_name='profiles'
     and c.column_name in ('id','user_id','profile_id')
   order by array_position(array['id','user_id','profile_id'], c.column_name) limit 1;

  select c.column_name into v_pharm_col
    from information_schema.columns c
   where c.table_schema='public' and c.table_name='profiles'
     and c.column_name in ('pharmacy_id','pharmacy','store_id','pharmacies_id')
   order by array_position(array['pharmacy_id','pharmacy','store_id','pharmacies_id'], c.column_name) limit 1;

  select c.column_name into v_role_col
    from information_schema.columns c
   where c.table_schema='public' and c.table_name='profiles'
     and c.column_name in ('role','user_role','account_role','role_name')
   order by array_position(array['role','user_role','account_role','role_name'], c.column_name) limit 1;

  v_own := format('(p.%I)::text = auth.uid()::text', v_id_col);
  if v_pharm_col is null then
    v_same := 'false';
  else
    v_same := format('((p.%I) is not null and (p.%I)::text = public.pg_pharmacy())', v_pharm_col, v_pharm_col);
  end if;

  execute 'drop policy if exists pg_profiles_select on public.profiles';
  execute format($p$
    create policy pg_profiles_select on public.profiles
    for select to authenticated
    using (
      public.pg_role() is not null
      and (%1$s or %2$s)
    )
  $p$, v_own, v_same);

  execute 'drop policy if exists pg_profiles_update on public.profiles';
  execute format($p$
    create policy pg_profiles_update on public.profiles
    for update to authenticated
    using (
      public.pg_role() is not null
      and ((%1$s) or (public.pg_role() = 'owner' and %2$s))
    )
    with check (
      public.pg_role() is not null
      and ((%1$s) or (public.pg_role() = 'owner' and %2$s))
    )
  $p$, v_own, v_same);

  execute 'drop policy if exists pg_profiles_insert on public.profiles';
  if v_role_col is null then
    execute format($p$
      create policy pg_profiles_insert on public.profiles
      for insert to authenticated
      with check (%1$s)
    $p$, v_own);
  else
    execute format($p$
      create policy pg_profiles_insert on public.profiles
      for insert to authenticated
      with check (
        (%1$s)
        and lower(btrim((%2$I)::text)) in ('pharmacist', 'inventory_manager', 'inventory', 'stock_manager', 'inventory-manager')
      )
    $p$, v_own, v_role_col);
  end if;

  execute 'drop policy if exists pg_profiles_delete on public.profiles';
  execute format($p$
    create policy pg_profiles_delete on public.profiles
    for delete to authenticated
    using (
      public.pg_role() = 'owner'
      and not (%1$s)
      and %2$s
    )
  $p$, v_own, v_same);
end $pg$;

-- ---------------------------------------------------------------------------
-- 4) سياسات جدول pharmacies: كل مستخدم يرى صيدليته، والمالك وحده يعدّلها
-- ---------------------------------------------------------------------------
do $pg$
declare
  v_pharm_col text;
  v_pharm_id  text;
  v_own       text;
begin
  select c.column_name into v_pharm_col
    from information_schema.columns c
   where c.table_schema='public' and c.table_name='profiles'
     and c.column_name in ('pharmacy_id','pharmacy','store_id','pharmacies_id')
   order by array_position(array['pharmacy_id','pharmacy','store_id','pharmacies_id'], c.column_name) limit 1;

  select c.column_name into v_pharm_id
    from information_schema.columns c
   where c.table_schema='public' and c.table_name='pharmacies'
     and c.column_name in ('id','pharmacy_id','uuid')
   order by array_position(array['id','pharmacy_id','uuid'], c.column_name) limit 1;

  v_own := case
    when v_pharm_col is null or v_pharm_id is null then 'false'
    else format('(ph.%I)::text = public.pg_pharmacy()', v_pharm_id)
  end;

  execute 'drop policy if exists pg_pharmacies_select on public.pharmacies';
  execute format($p$
    create policy pg_pharmacies_select on public.pharmacies
    for select to authenticated
    using (public.pg_role() is not null and %s)
  $p$, v_own);

  execute 'drop policy if exists pg_pharmacies_update on public.pharmacies';
  execute format($p$
    create policy pg_pharmacies_update on public.pharmacies
    for update to authenticated
    using (public.pg_role() = 'owner' and %s)
    with check (public.pg_role() = 'owner' and %s)
  $p$, v_own, v_own);
end $pg$;

-- ---------------------------------------------------------------------------
-- 5) حماية من ترقية الدور ومن نقل الموظفين بين الصيدليات
-- ---------------------------------------------------------------------------
create or replace function public.pg_profiles_guard_update() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $body$
declare
  v_role_col  text := nullif(TG_ARGV[0], '');
  v_pharm_col text := nullif(TG_ARGV[1], '');
  v_new_role  text;
  v_old_role  text;
  v_new_pharm text;
  v_old_pharm text;
  v_me        text;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role' then
    return new;
  end if;

  if v_role_col is not null then
    v_new_role := to_jsonb(new) ->> v_role_col;
    v_old_role := to_jsonb(old) ->> v_role_col;
    if v_new_role is distinct from v_old_role then
      raise exception 'تغيير الدور غير مسموح من العميل.' using errcode = '42501';
    end if;
  end if;

  if v_pharm_col is not null then
    v_new_pharm := to_jsonb(new) ->> v_pharm_col;
    v_old_pharm := to_jsonb(old) ->> v_pharm_col;
    if v_new_pharm is distinct from v_old_pharm then
      v_me := public.pg_role();
      if v_me is distinct from 'owner' then
        raise exception 'ربط الموظف بالصيدلية يدار من مالك الصيدلية.' using errcode = '42501';
      end if;
      if v_new_pharm is distinct from public.pg_pharmacy() then
        raise exception 'لا يمكن نقل موظف إلى صيدلية أخرى.' using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end;
$body$;

create or replace function public.pg_profiles_guard_insert() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $body$
declare
  v_role_col text := nullif(TG_ARGV[0], '');
  v_new_role text;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role' then
    return new;
  end if;

  if v_role_col is not null then
    v_new_role := lower(btrim(coalesce(to_jsonb(new) ->> v_role_col, '')));
    if v_new_role in ('owner', 'pharmacy_owner', 'pharmacy-owner') then
      raise exception 'لا يمكن إنشاء حساب بدور مالك الصيدلية من العميل.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$body$;

do $pg$
declare
  v_role_col  text;
  v_pharm_col text;
begin
  select c.column_name into v_role_col
    from information_schema.columns c
   where c.table_schema='public' and c.table_name='profiles'
     and c.column_name in ('role','user_role','account_role','role_name')
   order by array_position(array['role','user_role','account_role','role_name'], c.column_name) limit 1;

  select c.column_name into v_pharm_col
    from information_schema.columns c
   where c.table_schema='public' and c.table_name='profiles'
     and c.column_name in ('pharmacy_id','pharmacy','store_id','pharmacies_id')
   order by array_position(array['pharmacy_id','pharmacy','store_id','pharmacies_id'], c.column_name) limit 1;

  execute 'drop trigger if exists pg_profiles_guard_update_trg on public.profiles';
  execute format(
    'create trigger pg_profiles_guard_update_trg before update on public.profiles
     for each row execute function public.pg_profiles_guard_update(%L, %L)',
    coalesce(v_role_col, ''), coalesce(v_pharm_col, ''));

  execute 'drop trigger if exists pg_profiles_guard_insert_trg on public.profiles';
  execute format(
    'create trigger pg_profiles_guard_insert_trg before insert on public.profiles
     for each row execute function public.pg_profiles_guard_insert(%L)',
    coalesce(v_role_col, ''));
end $pg$;

-- ---------------------------------------------------------------------------
-- 6) سياسات الجداول التشغيلية: قراءة لكل موظفي الصيدلية،
--    وكتابة حسب الدور، وكل شيء مقيّد بصيدلية المستخدم.
-- ---------------------------------------------------------------------------
do $pg$
declare
  t            text;
  v_write      text[];
  v_col        text;
  v_scope      text;
  v_scope_w    text;
  v_read_expr  text;
  v_rec        record;
begin
  for v_rec in
    select * from (values
      ('medicines',         '{owner,inventory_manager}'::text[]),
      ('inventory_batches', '{owner,inventory_manager}'::text[]),
      ('stock_movements',   '{owner,inventory_manager}'::text[]),
      ('inventory_alerts',  '{owner,inventory_manager}'::text[]),
      ('drug_interactions', '{owner,pharmacist}'::text[]),
      ('agent_runs',        '{owner,pharmacist}'::text[]),
      ('reports',           '{owner,pharmacist}'::text[])
    ) as v(tbl, write_roles)
  loop
    t := v_rec.tbl;
    v_write := v_rec.write_roles;

    if not exists (
      select 1 from information_schema.tables
       where table_schema='public' and table_name=t
    ) then
      raise notice 'PharmaGuard: الجدول public.% غير موجود — تم تجاوزه.', t;
      continue;
    end if;

    select c.column_name into v_col
      from information_schema.columns c
     where c.table_schema='public' and c.table_name=t
       and c.column_name in ('pharmacy_id','pharmacy','store_id','pharmacies_id')
     order by array_position(array['pharmacy_id','pharmacy','store_id','pharmacies_id'], c.column_name) limit 1;

    if v_col is null then
      v_scope   := 'true';
      v_scope_w := 'true';
      v_read_expr := 'public.pg_role() is not null';
    else
      v_scope   := format('(%I)::text = public.pg_pharmacy()', v_col);
      v_scope_w := format('(%I)::text = public.pg_pharmacy()', v_col);
      v_read_expr := format('public.pg_role() is not null and %s', v_scope);
    end if;

    execute format('drop policy if exists %I on public.%I', 'pg_' || t || '_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (%s)',
      'pg_' || t || '_select', t, v_read_expr);

    execute format('drop policy if exists %I on public.%I', 'pg_' || t || '_insert', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.pg_role() = any ((%L)::text[]) and %s)',
      'pg_' || t || '_insert', t, v_write, v_scope_w);

    execute format('drop policy if exists %I on public.%I', 'pg_' || t || '_update', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.pg_role() = any ((%L)::text[]) and %s) with check (public.pg_role() = any ((%L)::text[]) and %s)',
      'pg_' || t || '_update', t, v_write, v_scope, v_write, v_scope_w);

    execute format('drop policy if exists %I on public.%I', 'pg_' || t || '_delete', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.pg_role() = any ((%L)::text[]) and %s)',
      'pg_' || t || '_delete', t, v_write, v_scope);
  end loop;
end $pg$;

-- ---------------------------------------------------------------------------
-- 7) notifications و device_tokens: صفوف المستخدم نفسه فقط
-- ---------------------------------------------------------------------------
do $pg$
declare
  t          text;
  v_user_col text;
  v_own      text;
begin
  foreach t in array array['notifications', 'device_tokens'] loop
    if not exists (
      select 1 from information_schema.tables
       where table_schema='public' and table_name=t
    ) then
      raise notice 'PharmaGuard: الجدول public.% غير موجود — تم تجاوزه.', t;
      continue;
    end if;

    select c.column_name into v_user_col
      from information_schema.columns c
     where c.table_schema='public' and c.table_name=t
       and c.column_name in ('user_id','profile_id','recipient_id','owner_id')
     order by array_position(array['user_id','profile_id','recipient_id','owner_id'], c.column_name) limit 1;

    v_own := case
      when v_user_col is null then 'false'
      else format('(%I)::text = auth.uid()::text', v_user_col)
    end;

    execute format('drop policy if exists %I on public.%I', 'pg_' || t || '_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (%s)',
      'pg_' || t || '_select', t, v_own);

    execute format('drop policy if exists %I on public.%I', 'pg_' || t || '_insert', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (%s)',
      'pg_' || t || '_insert', t, v_own);

    execute format('drop policy if exists %I on public.%I', 'pg_' || t || '_update', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (%s) with check (%s)',
      'pg_' || t || '_update', t, v_own, v_own);

    execute format('drop policy if exists %I on public.%I', 'pg_' || t || '_delete', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (%s)',
      'pg_' || t || '_delete', t, v_own);
  end loop;
end $pg$;

-- ---------------------------------------------------------------------------
-- 8) دالتا التشخيص (تستخدمهما صفحة "تشخيص الربط")
-- ---------------------------------------------------------------------------
create or replace function public.pg_rls_status()
returns table(table_name text, rls_enabled boolean, policy_count integer)
language sql stable security definer set search_path = public, pg_temp
as $body$
  select c.relname::text,
         c.relrowsecurity,
         (select count(*)::int from pg_policy p where p.polrelid = c.oid)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
   order by c.relname;
$body$;

create or replace function public.pg_selftest(p_table text default 'reports')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $body$
declare
  v_error text;
begin
  if p_table is null or not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = p_table
  ) then
    return jsonb_build_object('ok', false, 'error', 'الجدول غير موجود', 'table', p_table);
  end if;

  begin
    -- إدراج صف فارغ ثم التراجع عنه: لا تبقى أي بيانات تجريبية
    execute format('insert into public.%I default values', p_table);
    raise sqlstate 'P0001' using message = 'pg_selftest_rollback';
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'pg_selftest_rollback' then
        return jsonb_build_object(
          'ok', true, 'table', p_table, 'method', 'insert_then_rollback',
          'note', 'الكتابة مسموحة وتم التراجع عن الصف بالكامل.'
        );
      end if;
      v_error := sqlerrm;
    when not_null_violation or check_violation or foreign_key_violation then
      return jsonb_build_object(
        'ok', true, 'table', p_table, 'method', 'insert_permission_only',
        'note', 'صلاحية الكتابة متاحة، لكن قيود المخطط تمنع صفًا فارغًا — سلوك متوقع قبل إدخال بيانات حقيقية.'
      );
    when others then
      v_error := sqlerrm;
  end;

  return jsonb_build_object(
    'ok', false, 'table', p_table, 'method', 'insert_then_rollback', 'error', v_error
  );
end;
$body$;

revoke all on function public.pg_rls_status() from public;
revoke all on function public.pg_selftest(text) from public;
grant execute on function public.pg_rls_status() to authenticated, service_role;
grant execute on function public.pg_selftest(text) to service_role;

commit;

-- ---------------------------------------------------------------------------
-- 9) تحقّق سريع بعد التشغيل
-- ---------------------------------------------------------------------------
select table_name, rls_enabled, policy_count
  from public.pg_rls_status()
 where table_name in (
   'profiles','pharmacies','medicines','inventory_batches','stock_movements',
   'inventory_alerts','notifications','device_tokens','drug_interactions',
   'agent_runs','reports'
 )
 order by table_name;
