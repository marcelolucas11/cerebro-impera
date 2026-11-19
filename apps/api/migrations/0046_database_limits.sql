-- =============================================================================
-- Limits the database keeps by itself, found missing by the independent review
-- (D72). Each part says what it closes.
--
--   1. The routines' own functions answer only outside a request.
--   2. The login service cannot approve a device, open a session on a device
--      whose secret it was not shown, or change a session other than to end it
--      or mark a fresh second factor.
--   3. Request-wide counts live where no service can write.
--   4. People's rules hold for every service, not only the application's.
--   5. Lowering a list's protection or moving it needs a fresh second factor
--      and goes on the record.
--   6. A notification hides once its item does.
--   7. The application writes to the record only what it is meant to.
--   8. Two setups, or two owners demoting each other, at the same moment.
-- =============================================================================

-- Whether people's rules apply to this change: always for the three services,
-- and for anyone acting as a person. Only the database owner's own
-- maintenance (migrations, recovery by hand) passes without them.
CREATE FUNCTION authz.enforced() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT session_user::text IN ('cerebro_app', 'cerebro_auth', 'cerebro_forms')
         OR authz.uid() IS NOT NULL
$$;

-- ---------------------------------------------------------------------------
-- 1. Routines only
-- ---------------------------------------------------------------------------

CREATE FUNCTION authz.require_routine() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF authz.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'only the routines do this' USING ERRCODE = 'CB001';
  END IF;
END
$$;

-- Each keeps its body under a new name, out of everyone's reach, and the old
-- name asks first who is calling.
ALTER FUNCTION app.record_scan(uuid, text) RENAME TO record_scan_unguarded;
ALTER FUNCTION app.attachments_waiting_for_scan() RENAME TO attachments_waiting_for_scan_unguarded;
ALTER FUNCTION app.take_disposals(integer) RENAME TO take_disposals_unguarded;
ALTER FUNCTION app.purge_trash() RENAME TO purge_trash_unguarded;
ALTER FUNCTION app.purge_attachments() RENAME TO purge_attachments_unguarded;
ALTER FUNCTION app.purge_automation_runs() RENAME TO purge_automation_runs_unguarded;
ALTER FUNCTION app.notify_due() RENAME TO notify_due_unguarded;
REVOKE EXECUTE ON FUNCTION
  app.record_scan_unguarded(uuid, text),
  app.attachments_waiting_for_scan_unguarded(),
  app.take_disposals_unguarded(integer),
  app.purge_trash_unguarded(),
  app.purge_attachments_unguarded(),
  app.purge_automation_runs_unguarded(),
  app.notify_due_unguarded()
FROM cerebro_app;

CREATE FUNCTION app.record_scan(p_id uuid, p_result text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM authz.require_routine();
  PERFORM app.record_scan_unguarded(p_id, p_result);
END
$$;

CREATE FUNCTION app.attachments_waiting_for_scan()
RETURNS TABLE (id uuid, size bigint, wrapped_key bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM authz.require_routine();
  RETURN QUERY SELECT * FROM app.attachments_waiting_for_scan_unguarded();
END
$$;

CREATE FUNCTION app.take_disposals(p_limit integer) RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM authz.require_routine();
  RETURN QUERY SELECT * FROM app.take_disposals_unguarded(p_limit);
END
$$;

CREATE FUNCTION app.purge_trash() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM authz.require_routine();
  RETURN app.purge_trash_unguarded();
END
$$;

CREATE FUNCTION app.purge_attachments() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM authz.require_routine();
  RETURN app.purge_attachments_unguarded();
END
$$;

CREATE FUNCTION app.purge_automation_runs() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM authz.require_routine();
  RETURN app.purge_automation_runs_unguarded();
END
$$;

CREATE FUNCTION app.notify_due() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM authz.require_routine();
  RETURN app.notify_due_unguarded();
END
$$;

REVOKE EXECUTE ON FUNCTION
  authz.enforced(),
  authz.require_routine(),
  app.record_scan(uuid, text),
  app.attachments_waiting_for_scan(),
  app.take_disposals(integer),
  app.purge_trash(),
  app.purge_attachments(),
  app.purge_automation_runs(),
  app.notify_due()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.record_scan(uuid, text),
  app.attachments_waiting_for_scan(),
  app.take_disposals(integer),
  app.purge_trash(),
  app.purge_attachments(),
  app.purge_automation_runs(),
  app.notify_due()
TO cerebro_app;

-- ---------------------------------------------------------------------------
-- 2. What the login service may do
--
-- It checks passwords and codes, which the database cannot. What the database
-- can hold is the door after that: a device is approved by a person, never by
-- the login service (save the first owner's, during setup); a session opens
-- only on an approved device of the same person, and only for whoever holds
-- that device's secret, which the database keeps only as a digest. So even a
-- login service made to run any statement cannot let anyone in on a device
-- nobody approved.
-- ---------------------------------------------------------------------------

CREATE FUNCTION auth.devices_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF session_user <> 'cerebro_auth' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'pending' AND NEW.decided_by IS NULL AND NEW.decided_at IS NULL THEN
      NEW.last_seen_at := NULL;
      RETURN NEW;
    END IF;
    -- The first owner's own browser, while the installation is being set up.
    IF NEW.status = 'approved' AND NEW.decided_by = NEW.user_id
       AND EXISTS (SELECT 1 FROM app.instance_settings i WHERE i.setup_completed_at IS NULL)
       AND EXISTS (SELECT 1 FROM app.users u WHERE u.id = NEW.user_id AND u.role = 'owner')
       AND (SELECT count(*) FROM app.users) = 1
       AND NOT EXISTS (SELECT 1 FROM auth.devices d) THEN
      NEW.decided_at := now();
      NEW.last_seen_at := NULL;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  -- Asking again after a refusal or a revocation: back to waiting, the same
  -- device of the same person.
  IF NEW.id = OLD.id AND NEW.user_id = OLD.user_id AND NEW.token_hash = OLD.token_hash
     AND NEW.status = 'pending' AND NEW.decided_by IS NULL AND NEW.decided_at IS NULL
     AND NEW.last_seen_at IS NOT DISTINCT FROM OLD.last_seen_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
END
$$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON auth.devices
  FOR EACH ROW EXECUTE FUNCTION auth.devices_guard();

-- Opens a session for a person on their approved device, shown its secret.
-- Starts with a fresh second factor (one was just confirmed) and lasts what
-- the installation allows. Returns how many hours that is.
CREATE FUNCTION auth.open_session(
  p_id uuid, p_user uuid, p_device_proof bytea, p_token_digest bytea, p_ip inet, p_user_agent text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_device uuid;
  v_hours  integer;
BEGIN
  SELECT d.id INTO v_device
  FROM auth.devices d JOIN app.users u ON u.id = d.user_id
  WHERE d.user_id = p_user AND d.token_hash = sha256(p_device_proof)
    AND d.status = 'approved' AND u.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  SELECT i.session_absolute_hours INTO STRICT v_hours FROM app.instance_settings i;
  INSERT INTO auth.sessions (id, user_id, device_id, token_hash, expires_at, step_up_at, ip,
                             user_agent)
  VALUES (p_id, p_user, v_device, sha256(p_token_digest),
          now() + make_interval(hours => v_hours), now(), p_ip, left(p_user_agent, 400));
  RETURN v_hours;
END
$$;

-- After that, a session changes only by ending, for good, or by marking a
-- second factor confirmed now.
CREATE FUNCTION auth.sessions_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF session_user <> 'cerebro_auth' THEN
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.device_id <> OLD.device_id
     OR NEW.token_hash <> OLD.token_hash OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at <> OLD.expires_at OR NEW.last_seen_at <> OLD.last_seen_at
     OR NEW.ip IS DISTINCT FROM OLD.ip OR NEW.user_agent <> OLD.user_agent THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason
       OR NEW.step_up_at IS DISTINCT FROM OLD.step_up_at THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := now();
  ELSIF NEW.revoked_reason IS NOT NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  IF NEW.step_up_at IS DISTINCT FROM OLD.step_up_at THEN
    IF NEW.step_up_at IS NULL OR NEW.revoked_at IS NOT NULL OR OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
    END IF;
    NEW.step_up_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE UPDATE ON auth.sessions
  FOR EACH ROW EXECUTE FUNCTION auth.sessions_guard();

-- Invites are made by people with authority (through the application); the
-- login service only uses one up, once.
CREATE FUNCTION auth.invites_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF session_user <> 'cerebro_auth' THEN
    RETURN NEW;
  END IF;
  IF OLD.used_at IS NOT NULL OR NEW.used_at IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  NEW.used_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE UPDATE ON auth.invites
  FOR EACH ROW EXECUTE FUNCTION auth.invites_guard();

REVOKE INSERT ON auth.sessions FROM cerebro_auth;
REVOKE INSERT, UPDATE, DELETE ON auth.invites FROM cerebro_auth;
GRANT UPDATE (used_at) ON auth.invites TO cerebro_auth;

REVOKE EXECUTE ON FUNCTION
  auth.devices_guard(),
  auth.open_session(uuid, uuid, bytea, bytea, inet, text),
  auth.sessions_guard(),
  auth.invites_guard()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.open_session(uuid, uuid, bytea, bytea, inet, text) TO cerebro_auth;

-- An account becomes active only by its own invite, used in the same step.
-- Setups queue on the settings row, so the second one finds the first owner
-- (part 8).
CREATE OR REPLACE FUNCTION app.users_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid;
  v_role  app.user_role;
BEGIN
  -- Maintenance by the database owner (migrations, server-side recovery).
  IF session_user NOT IN ('cerebro_app', 'cerebro_auth') THEN
    RETURN NEW;
  END IF;

  IF session_user = 'cerebro_auth' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM 1 FROM app.instance_settings FOR UPDATE;
      -- First-run setup: the very first account, and only while setup is open.
      IF NEW.role = 'owner' AND NEW.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM app.users)
         AND EXISTS (SELECT 1 FROM app.instance_settings i WHERE i.setup_completed_at IS NULL) THEN
        NEW.created_by := NULL;
        RETURN NEW;
      END IF;
    ELSIF OLD.status = 'invited' AND NEW.status = 'active'
          AND NEW.id = OLD.id AND NEW.email = OLD.email AND NEW.name = OLD.name
          AND NEW.role = OLD.role AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
          AND EXISTS (SELECT 1 FROM auth.invites i
                      WHERE i.user_id = OLD.id AND i.kind = 'invite' AND i.used_at = now()) THEN
      -- Invite acceptance: the only change the login service may make.
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;

  v_actor := authz.uid();
  v_role := authz.my_role();
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM authz.require_step_up();
    IF v_role <> 'owner'
       AND NOT (authz.has_capability('users.manage') AND NEW.role < v_role) THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
    END IF;
    NEW.created_by := v_actor;
    NEW.status := 'invited';
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;

  -- Display name only: the person themselves or whoever administers them.
  IF NEW.role = OLD.role AND NEW.status = OLD.status AND NEW.email = OLD.email THEN
    IF OLD.id = v_actor OR authz.can_manage_user(OLD.id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;

  -- Role, status or login e-mail: a critical change.
  PERFORM authz.require_step_up();
  -- An account only becomes active by accepting its invite, and never goes
  -- back to "invited". Cancelling a pending invite (invited -> suspended) is fine.
  IF NEW.status <> OLD.status
     AND (NEW.status = 'invited' OR (OLD.status = 'invited' AND NEW.status = 'active')) THEN
    RAISE EXCEPTION 'accounts are activated by accepting an invite' USING ERRCODE = 'CB003';
  END IF;
  IF v_role = 'owner' THEN
    RETURN NEW;
  END IF;
  IF NEW.email = OLD.email AND authz.can_manage_user(OLD.id) AND NEW.role < v_role THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Request-wide counts
-- ---------------------------------------------------------------------------

ALTER TABLE authz.request_ctx ADD COLUMN trashed integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION authz.request_ctx_fresh() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.xact_start IS DISTINCT FROM OLD.xact_start THEN
    NEW.automation_id := NULL;
    NEW.automation_depth := 0;
    NEW.form_id := NULL;
    NEW.trashed := 0;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.items_bulk_trash_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_now   integer;
  v_total integer;
BEGIN
  IF NOT authz.enforced() THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO v_now
  FROM new_rows n JOIN old_rows o ON o.id = n.id
  WHERE o.deleted_at IS NULL AND n.deleted_at IS NOT NULL;
  IF v_now = 0 THEN
    RETURN NULL;
  END IF;
  -- Counted in the request's own context, which no service can write.
  UPDATE authz.request_ctx c SET trashed = c.trashed + v_now
  WHERE c.pid = pg_backend_pid() AND c.xact_start = transaction_timestamp()
  RETURNING c.trashed INTO v_total;
  v_total := coalesce(v_total, v_now);
  IF v_total > 1 THEN
    IF NOT authz.has_capability('bulk_delete') THEN
      RAISE EXCEPTION 'sending several items to the trash needs the bulk delete capability'
        USING ERRCODE = 'CB001';
    END IF;
    PERFORM authz.require_step_up();
    PERFORM audit.record('items.bulk_trashed', NULL, NULL, jsonb_build_object('count', v_now));
    -- Once per request is enough for the owners to hear about it.
    IF v_total = v_now OR v_total - v_now <= 1 THEN
      PERFORM app.raise_alert('bulk_delete', 'warning', authz.uid(),
                              jsonb_build_object('count', v_total));
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- The rule moving on to the next item is written once, as "repeated", by the
-- trigger that moves it; only that trigger changes a rule from inside another
-- change, which no service can fake.
CREATE OR REPLACE FUNCTION app.item_recurrences_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_item uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.item_id ELSE NEW.item_id END;
BEGIN
  -- Nothing to add to when the item itself is being removed, or when the rule
  -- only moves on to the next item (that is written as "repeated" there).
  IF NOT EXISTS (SELECT 1 FROM app.items i WHERE i.id = v_item) OR pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.item_changes (item_id, actor, what, old, new)
  VALUES (
    v_item, authz.uid(), 'recurrence',
    CASE WHEN TG_OP = 'INSERT' THEN NULL
         ELSE jsonb_build_object('unit', OLD.unit, 'every', OLD.every) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL
         ELSE jsonb_build_object('unit', NEW.unit, 'every', NEW.every) END
  );
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION app.items_repeat() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rule   app.item_recurrences;
  v_step   interval;
  v_base   date;
  v_n      integer := 1;
  v_next   date;
  v_start  date;
  v_new    uuid := gen_random_uuid();
  v_actor  uuid := authz.uid();
  v_parent uuid;
  v_value  record;
BEGIN
  -- Only on reaching a finished stage from an open one, in the same list.
  IF NEW.deleted_at IS NOT NULL OR NEW.list_id <> OLD.list_id
     OR NOT EXISTS (SELECT 1 FROM app.list_stages s
                    WHERE s.id = NEW.stage_id AND s.kind IN ('done', 'closed'))
     OR EXISTS (SELECT 1 FROM app.list_stages s
                WHERE s.id = OLD.stage_id AND s.kind IN ('done', 'closed')) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_rule FROM app.item_recurrences r WHERE r.item_id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_step := CASE v_rule.unit
    WHEN 'day'   THEN make_interval(days => v_rule.every)
    WHEN 'week'  THEN make_interval(weeks => v_rule.every)
    WHEN 'month' THEN make_interval(months => v_rule.every)
    ELSE              make_interval(years => v_rule.every)
  END;
  -- Steps are counted from the last due date; finished late, whole steps are
  -- added until the next date is today or later.
  v_base := coalesce(NEW.due_date, current_date);
  v_next := (v_base + v_step)::date;
  WHILE v_next < current_date AND v_n < 1000 LOOP
    v_n := v_n + 1;
    v_next := (v_base + v_step * v_n)::date;
  END LOOP;
  IF NEW.start_date IS NOT NULL THEN
    v_start := least((NEW.start_date + v_step * v_n)::date, v_next);
  END IF;
  -- Under the same parent only while whoever finished it may still hang work there.
  IF NEW.parent_id IS NOT NULL AND app.parent_usable(NEW.parent_id, NEW.list_id)
     AND (NOT authz.enforced() OR authz.item_level(NEW.parent_id) >= 'edit') THEN
    v_parent := NEW.parent_id;
  END IF;

  INSERT INTO app.items (id, list_id, title, description, created_by, priority, start_date,
                         due_date, parent_id)
  VALUES (v_new, NEW.list_id, NEW.title, NEW.description, coalesce(v_actor, NEW.created_by),
          NEW.priority, v_start, v_next, v_parent);

  INSERT INTO app.item_assignees (item_id, user_id, assigned_by)
  SELECT v_new, ia.user_id, coalesce(v_actor, NEW.created_by)
  FROM app.item_assignees ia
  WHERE ia.item_id = NEW.id AND authz.list_level_of(ia.user_id, NEW.list_id) >= 'edit'
  ON CONFLICT DO NOTHING;

  -- A value that no longer fits (an option removed, a person gone) stays behind.
  FOR v_value IN
    SELECT fv.field_id, fv.value FROM app.item_field_values fv
    JOIN app.list_fields f ON f.id = fv.field_id
    WHERE fv.item_id = NEW.id AND f.list_id = NEW.list_id AND NOT f.is_archived
      AND f.kind <> 'files'
  LOOP
    BEGIN
      INSERT INTO app.item_field_values (item_id, field_id, value)
      VALUES (v_new, v_value.field_id, v_value.value);
    EXCEPTION WHEN SQLSTATE 'CB003' OR SQLSTATE '23514' THEN
      NULL;
    END;
  END LOOP;

  INSERT INTO app.item_checks (id, item_id, text, position, created_by)
  SELECT gen_random_uuid(), v_new, c.text, c.position, coalesce(v_actor, c.created_by)
  FROM app.item_checks c WHERE c.item_id = NEW.id;

  -- The rule moves on.
  DELETE FROM app.item_recurrences r WHERE r.item_id = NEW.id;
  INSERT INTO app.item_recurrences (item_id, unit, every, set_by)
  VALUES (v_new, v_rule.unit, v_rule.every, coalesce(v_actor, v_rule.set_by));
  INSERT INTO app.item_changes (item_id, actor, what, new)
  VALUES (v_new, v_actor, 'repeated', to_jsonb(NEW.id));
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. People's rules under every service
--
-- These used to hold only for the application's connection. A form acts as
-- its author, and so do the rules it sets off; they now meet the same limits.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.items_stage_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_needed app.user_role;
BEGIN
  IF NOT authz.enforced() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id THEN
    RETURN NEW;
  END IF;
  SELECT s.entry_role INTO v_needed FROM app.list_stages s WHERE s.id = NEW.stage_id;
  IF v_needed IS NOT NULL AND NOT coalesce(authz.my_role() >= v_needed, false) THEN
    RAISE EXCEPTION 'only % and above put items in this stage', v_needed USING ERRCODE = 'CB004';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.item_assignees_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT authz.enforced() THEN
    RETURN NEW;
  END IF;
  IF coalesce(authz.list_level_of(
       NEW.user_id, (SELECT i.list_id FROM app.items i WHERE i.id = NEW.item_id)
     ), 'none') < 'edit' THEN
    RAISE EXCEPTION 'this person cannot work in this list' USING ERRCODE = 'CB003';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.item_field_values_people_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_list uuid;
BEGIN
  IF NOT authz.enforced() THEN
    RETURN NEW;
  END IF;
  SELECT i.list_id INTO v_list
  FROM app.items i JOIN app.list_fields f ON f.list_id = i.list_id
  WHERE i.id = NEW.item_id AND f.id = NEW.field_id AND f.kind::text = 'people';
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(NEW.value) AS p
    WHERE NOT (
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.value ELSE coalesce((
        SELECT v.value FROM app.item_field_values v
        WHERE v.item_id = NEW.item_id AND v.field_id = NEW.field_id
      ), '[]'::jsonb) END ? p
    )
    AND coalesce(authz.list_level_of(p::uuid, v_list), 'none') < 'edit'
  ) THEN
    RAISE EXCEPTION 'a person named here cannot work in this list' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.items_parent_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT authz.enforced() OR NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN
    RETURN NEW;
  END IF;
  IF authz.item_level(NEW.parent_id) < 'edit' THEN
    RAISE EXCEPTION 'a subtask hangs only from an item its author may edit' USING ERRCODE = 'CB001';
  END IF;
  RETURN NEW;
END
$$;

-- A form whose author can no longer put items in its stage stops taking answers.
CREATE OR REPLACE FUNCTION app.form_submit(p_slug text, p_title text, p_description text,
                                           p_values jsonb)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_form  app.forms;
  v_item  uuid := gen_random_uuid();
  v_key   text;
  v_stage uuid;
BEGIN
  IF authz.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  SELECT f.* INTO v_form FROM app.forms f WHERE f.slug = p_slug AND f.enabled FOR UPDATE;
  IF NOT FOUND OR coalesce(authz.list_level_of(v_form.run_as, v_form.list_id), 'none') < 'edit' THEN
    RETURN 'closed';
  END IF;
  IF EXISTS (SELECT 1 FROM app.list_stages s JOIN app.users u ON u.id = v_form.run_as
             WHERE s.id = v_form.stage_id AND s.entry_role IS NOT NULL
               AND u.role < s.entry_role) THEN
    RETURN 'closed';
  END IF;

  IF p_title IS NULL OR char_length(btrim(p_title)) NOT BETWEEN 1 AND 500
     OR (p_description IS NOT NULL
         AND (v_form.description_label IS NULL OR char_length(p_description) > 5000))
     OR jsonb_typeof(p_values) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'the answer does not fit the form' USING ERRCODE = '22023';
  END IF;
  -- Only what the form asks, and everything it requires.
  FOR v_key IN SELECT jsonb_object_keys(p_values) LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_form.fields) AS e WHERE e ->> 'id' = v_key) THEN
      RAISE EXCEPTION 'the answer does not fit the form' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_form.fields) AS e
    WHERE (e ->> 'required')::boolean AND NOT p_values ? (e ->> 'id')
  ) THEN
    RAISE EXCEPTION 'the answer does not fit the form' USING ERRCODE = '22023';
  END IF;

  -- However many people send, a list takes at most 500 a day from one form.
  IF (SELECT count(*) FROM app.form_submissions s
      WHERE s.form_id = v_form.id AND s.at > now() - interval '1 day') >= 500 THEN
    RETURN 'full';
  END IF;

  -- From here until the end, the acting person is the form's author, with no
  -- recent code, and what they do is marked as the form's.
  INSERT INTO authz.request_ctx AS c (pid, xact_start, user_id, session_id, ip, step_up)
  VALUES (pg_backend_pid(), transaction_timestamp(), v_form.run_as, NULL, NULL, false)
  ON CONFLICT (pid) DO UPDATE
    SET xact_start = EXCLUDED.xact_start, user_id = EXCLUDED.user_id,
        session_id = NULL, ip = NULL, step_up = false;
  UPDATE authz.request_ctx SET form_id = v_form.id WHERE pid = pg_backend_pid();

  SELECT s.id INTO v_stage FROM app.list_stages s
  WHERE s.id = v_form.stage_id AND s.list_id = v_form.list_id;
  INSERT INTO app.items (id, list_id, title, description, created_by, stage_id, form_id)
  VALUES (v_item, v_form.list_id, btrim(p_title), coalesce(btrim(p_description), ''),
          v_form.run_as, v_stage, v_form.id);
  FOR v_key IN SELECT jsonb_object_keys(p_values) LOOP
    INSERT INTO app.item_field_values (item_id, field_id, value, updated_by)
    VALUES (v_item, v_key::uuid, p_values -> v_key, v_form.run_as);
  END LOOP;
  INSERT INTO app.form_submissions (form_id, item_id) VALUES (v_form.id, v_item);
  RETURN 'sent';
END
$$;

-- ---------------------------------------------------------------------------
-- 5. A list's protection and place
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.lists_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT authz.enforced() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := authz.uid();
    RETURN NEW;
  END IF;
  IF NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'authorship cannot be changed' USING ERRCODE = 'CB001';
  END IF;
  -- Only owners lower a list's protection or move it elsewhere, with a fresh
  -- second factor.
  IF (OLD.is_sensitive AND NOT NEW.is_sensitive)
     OR NEW.space_id <> OLD.space_id OR NEW.folder_id IS DISTINCT FROM OLD.folder_id THEN
    IF NOT authz.is_owner() THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
    END IF;
    PERFORM authz.require_step_up();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER audit AFTER UPDATE OF is_sensitive, space_id, folder_id, is_archived ON app.lists
  FOR EACH ROW
  WHEN (OLD.is_sensitive IS DISTINCT FROM NEW.is_sensitive
        OR OLD.space_id IS DISTINCT FROM NEW.space_id
        OR OLD.folder_id IS DISTINCT FROM NEW.folder_id
        OR OLD.is_archived IS DISTINCT FROM NEW.is_archived)
  EXECUTE FUNCTION audit.on_security_change('id', 'silent');

-- ---------------------------------------------------------------------------
-- 6. Notifications follow their item
-- ---------------------------------------------------------------------------

DROP POLICY notifications_select ON app.notifications;
DROP POLICY notifications_update ON app.notifications;
CREATE POLICY notifications_select ON app.notifications FOR SELECT TO cerebro_app
  USING (user_id = authz.uid() AND authz.item_level(item_id) >= 'view');
CREATE POLICY notifications_update ON app.notifications FOR UPDATE TO cerebro_app
  USING (user_id = authz.uid() AND authz.item_level(item_id) >= 'view')
  WITH CHECK (user_id = authz.uid());

-- ---------------------------------------------------------------------------
-- 7. What goes on the record
--
-- The record is the history a person trusts after something went wrong, so
-- it takes, from each service, only the entries that service writes, about
-- the things it writes them about, with a bounded amount of detail. An entry
-- from a request always carries who made it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit.record(
  p_action text, p_target_type text DEFAULT NULL, p_target_id text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF authz.uid() IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  IF p_action IS NULL OR p_action NOT IN (
       'list.sensitive_viewed', 'item.assignees_changed', 'items.bulk_assigned',
       'items.bulk_trashed', 'attachment.downloaded', 'secret.revealed',
       'automations.created', 'automations.updated', 'automations.removed',
       'update.checked', 'update.requested', 'update.refused', 'update.applied',
       'update.rolled_back', 'update.failed')
     OR (p_target_type IS NOT NULL
         AND p_target_type NOT IN ('list', 'item', 'attachment', 'automation', 'update'))
     OR char_length(coalesce(p_target_id, '')) > 100
     OR octet_length(coalesce(p_metadata, '{}'::jsonb)::text) > 8192 THEN
    RAISE EXCEPTION 'not an entry for the record' USING ERRCODE = '22023';
  END IF;
  RETURN audit.append_entry(authz.uid(), authz.session_id(), authz.client_ip(),
                            p_action, p_target_type, p_target_id, p_metadata);
END
$$;

CREATE OR REPLACE FUNCTION audit.record_as(
  p_actor uuid, p_ip inet, p_action text, p_target_type text DEFAULT NULL,
  p_target_id text DEFAULT NULL, p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- The routines write their own entries through here too, from inside the
  -- database; the login service, the only one allowed to call it, writes these.
  IF session_user = 'cerebro_auth' AND (p_action IS NULL OR p_action NOT IN (
       'login.failed', 'login.succeeded', 'device.pending', 'instance.setup_completed',
       'invite.accepted', 'totp.enrolled', 'recovery_code.used', 'session.step_up',
       'password.changed')
     OR (p_target_type IS NOT NULL AND p_target_type NOT IN ('user', 'device', 'session'))
     OR char_length(coalesce(p_target_id, '')) > 100
     OR octet_length(coalesce(p_metadata, '{}'::jsonb)::text) > 8192) THEN
    RAISE EXCEPTION 'not an entry for the record' USING ERRCODE = '22023';
  END IF;
  RETURN audit.append_entry(p_actor, NULL, p_ip, p_action, p_target_type, p_target_id,
                            p_metadata);
END
$$;

-- ---------------------------------------------------------------------------
-- 8. Two at once
-- ---------------------------------------------------------------------------

-- Two owners demoting each other at the same moment would each still see the
-- other: the second waits for the first, then counts again.
CREATE OR REPLACE FUNCTION app.users_after_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.role = 'owner' AND OLD.status = 'active'
     AND (NEW.role <> 'owner' OR NEW.status <> 'active') THEN
    PERFORM 1 FROM app.instance_settings FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM app.users u WHERE u.role = 'owner' AND u.status = 'active') THEN
      RAISE EXCEPTION 'the instance needs at least one active owner' USING ERRCODE = 'CB003';
    END IF;
  END IF;
  IF NEW.status = 'suspended' AND OLD.status <> 'suspended' THEN
    UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'account suspended'
    WHERE user_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;
