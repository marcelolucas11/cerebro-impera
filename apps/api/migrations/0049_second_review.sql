-- =============================================================================
-- From the second independent review of the hardening phase (D84).
--
--   1. Taking a rule away can widen access: the person falls back on a broader
--      rule. Whoever takes it away must be able to give what she falls back on.
--   2. The login service raises only its own three kinds of alert.
--   3. An invite past its date is not used, and a device waiting for approval
--      says when it asked, not when the login service says it did.
--   4. An authenticator is written only with a challenge made for linking one.
--   5. Uploads: reserving and counting happen one at a time, a person's own
--      reservations have a ceiling, and a reservation with nothing arriving
--      stops holding space after 15 minutes.
--   6. Who is an owner, and the first account, change only under the isolation
--      the locks were written for.
--   7. A list that changes (sensitive, archived, moved) is announced live, so
--      open pages read the structure again.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Taking a rule away
-- ---------------------------------------------------------------------------

-- Without a rule on a folder or a list, a person falls back on her rule on the
-- folder above (for a list) or on the space. Taking the narrower rule away hands
-- her that: it needs the same as giving it.
CREATE FUNCTION authz.can_take(p_target uuid, p_space uuid, p_folder uuid, p_list uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_folder uuid;
  v_space  uuid;
  v_level  app.access_level;
  v_scope  app.item_scope;
BEGIN
  IF NOT authz.can_grant(p_target, p_space, p_folder, p_list, 'assigned') THEN
    RETURN false;
  END IF;
  IF p_space IS NOT NULL THEN
    -- Nothing broader to fall back on: it only narrows.
    RETURN true;
  END IF;
  IF p_list IS NOT NULL THEN
    SELECT l.folder_id, l.space_id INTO v_folder, v_space FROM app.lists l WHERE l.id = p_list;
  ELSE
    SELECT f.space_id INTO v_space FROM app.folders f WHERE f.id = p_folder;
  END IF;
  SELECT ag.level, ag.item_scope INTO v_level, v_scope
  FROM app.access_grants ag
  WHERE ag.user_id = p_target
    AND ((v_folder IS NOT NULL AND ag.folder_id = v_folder) OR ag.space_id = v_space)
  ORDER BY ag.folder_id IS NULL
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN true;
  END IF;
  RETURN authz.can_grant(p_target, p_space, p_folder, p_list, v_scope, v_level);
END
$$;
REVOKE EXECUTE ON FUNCTION authz.can_take(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.can_take(uuid, uuid, uuid, uuid) TO cerebro_app;

DROP POLICY grants_delete ON app.access_grants;
CREATE POLICY grants_delete ON app.access_grants FOR DELETE TO cerebro_app
  USING (authz.can_take(user_id, space_id, folder_id, list_id));

-- ---------------------------------------------------------------------------
-- 2. Alerts from the login service
-- ---------------------------------------------------------------------------

CREATE FUNCTION auth.raise_login_alert(p_kind text, p_actor uuid, p_metadata jsonb)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_kind NOT IN ('login_lockout', 'recovery_code_used', 'device_pending')
     OR length(coalesce(p_metadata, '{}'::jsonb)::text) > 8192 THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  RETURN app.raise_alert(p_kind, 'warning', p_actor, coalesce(p_metadata, '{}'::jsonb));
END
$$;
REVOKE EXECUTE ON FUNCTION auth.raise_login_alert(text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.raise_login_alert(text, uuid, jsonb) TO cerebro_auth;
REVOKE EXECUTE ON FUNCTION app.raise_alert(text, text, uuid, jsonb) FROM cerebro_auth;

-- ---------------------------------------------------------------------------
-- 3. Invites past their date; when a device asked
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth.invites_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF session_user <> 'cerebro_auth' THEN
    RETURN NEW;
  END IF;
  IF OLD.used_at IS NOT NULL OR NEW.used_at IS NULL OR OLD.expires_at <= now() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  NEW.used_at := now();
  RETURN NEW;
END
$$;

CREATE FUNCTION auth.devices_asked_at() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF session_user = 'cerebro_auth' THEN
    NEW.created_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER asked_at BEFORE INSERT ON auth.devices
  FOR EACH ROW EXECUTE FUNCTION auth.devices_asked_at();
REVOKE EXECUTE ON FUNCTION auth.devices_asked_at() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 4. Writing an authenticator
-- ---------------------------------------------------------------------------

-- The login service links an authenticator (a new key, or confirming one) only
-- while the person holds a live challenge made for that, which only using an
-- invite or a reset creates. The first owner's own, while the installation is
-- set up, is the one exception. After that, it only moves the last code used
-- forward, and takes one away only when an invite or reset is used.
CREATE FUNCTION auth.totp_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
BEGIN
  IF session_user <> 'cerebro_auth' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM auth.invites i WHERE i.user_id = v_user AND i.used_at = now()) THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.secret_enc = OLD.secret_enc
     AND NEW.confirmed_at IS NOT DISTINCT FROM OLD.confirmed_at
     AND NEW.created_at = OLD.created_at THEN
    IF NEW.user_id <> OLD.user_id OR NEW.last_step < OLD.last_step THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
    END IF;
    RETURN NEW;
  END IF;
  -- A confirmed authenticator is never replaced in place.
  IF TG_OP = 'UPDATE' AND (OLD.confirmed_at IS NOT NULL OR NEW.user_id <> OLD.user_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.login_challenges c
             WHERE c.user_id = v_user AND c.enrol AND c.expires_at > now()
               AND (c.consumed_at IS NULL OR c.consumed_at = now())) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT'
     AND EXISTS (SELECT 1 FROM app.instance_settings i WHERE i.setup_completed_at IS NULL)
     AND EXISTS (SELECT 1 FROM app.users u WHERE u.id = v_user AND u.role = 'owner')
     AND (SELECT count(*) FROM app.users) = 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
END
$$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON auth.totp
  FOR EACH ROW EXECUTE FUNCTION auth.totp_guard();
REVOKE EXECUTE ON FUNCTION auth.totp_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 5. Uploads
-- ---------------------------------------------------------------------------

-- What is still to arrive of uploads that are moving (one started, or a part
-- arrived, in the last 15 minutes): everyone's, and the person's own. Plus how
-- many uploads the person has open. Only sums.
DROP FUNCTION app.uploads_open();
CREATE FUNCTION app.uploads_open()
RETURNS TABLE (pending bigint, mine integer, mine_pending bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH open AS (
    SELECT a.created_by,
           a.size - coalesce(p.got, 0) AS left_to_come,
           greatest(a.created_at, p.last_part) > now() - interval '15 minutes' AS moving
    FROM app.attachments a
    LEFT JOIN (SELECT ap.attachment_id, sum(ap.size) AS got, max(ap.received_at) AS last_part
               FROM app.attachment_parts ap GROUP BY ap.attachment_id) p
      ON p.attachment_id = a.id
    WHERE a.status = 'uploading'
  )
  SELECT coalesce(sum(left_to_come) FILTER (WHERE moving), 0)::bigint,
         (count(*) FILTER (WHERE created_by = authz.uid()))::integer,
         coalesce(sum(left_to_come) FILTER (WHERE moving AND created_by = authz.uid()), 0)::bigint
  FROM open
$$;
REVOKE EXECUTE ON FUNCTION app.uploads_open() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.uploads_open() TO cerebro_app;

-- Starting uploads one at a time: what is counted is what is there.
CREATE OR REPLACE FUNCTION app.attachments_open_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF authz.enforced() THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('cerebro:uploads', 0));
    IF (SELECT count(*) FROM app.attachments a
        WHERE a.created_by = authz.uid() AND a.status = 'uploading') >= 5 THEN
      RAISE EXCEPTION 'at most five uploads open at a time' USING ERRCODE = 'CB003';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. Owners and the first account, under READ COMMITTED only
-- ---------------------------------------------------------------------------

-- The locks around owners and the first account re-check what others just
-- committed; under a stricter isolation the re-check would read an old picture.
CREATE FUNCTION app.users_isolation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF session_user IN ('cerebro_app', 'cerebro_auth', 'cerebro_forms')
     AND current_setting('transaction_isolation') <> 'read committed'
     AND (TG_OP = 'INSERT' OR NEW.role IS DISTINCT FROM OLD.role
          OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER isolation BEFORE INSERT OR UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.users_isolation();
REVOKE EXECUTE ON FUNCTION app.users_isolation() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 7. A list that changes, announced
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.live_list_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_notify('cerebro_live', jsonb_build_object('l', NEW.id)::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER live AFTER UPDATE OF is_sensitive, is_archived, space_id, folder_id, name
  ON app.lists FOR EACH ROW EXECUTE FUNCTION app.live_list_row();
REVOKE EXECUTE ON FUNCTION app.live_list_row() FROM PUBLIC;
