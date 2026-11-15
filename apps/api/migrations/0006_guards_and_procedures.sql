-- Rules that must hold no matter what the API does: guard triggers, automatic
-- auditing of permission changes, and the few privileged procedures that the
-- application role is allowed to call.

-- ---------------------------------------------------------------------------
-- Binding a request to a person
-- ---------------------------------------------------------------------------

-- Validates a session and binds the current transaction to its owner. Returns
-- no row when the session is unknown, expired, idle for too long or revoked,
-- when the account is not active, or when the device is not approved.
-- p_token_hash is SHA-256(token) computed by the API; the table stores
-- SHA-256 of that again, so raw tokens never reach the database.
CREATE FUNCTION authz.begin_request(p_token_hash bytea, p_ip inet)
RETURNS TABLE (
  ctx_user_id uuid, ctx_session_id uuid, ctx_device_id uuid, ctx_role app.user_role,
  ctx_name text, ctx_email text, ctx_step_up boolean, ctx_capabilities text[]
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  cfg    record;
  s      record;
  v_step boolean;
BEGIN
  SELECT i.session_idle_minutes, i.step_up_minutes INTO STRICT cfg FROM app.instance_settings i;

  SELECT se.id, se.user_id, se.device_id, se.last_seen_at, se.step_up_at, u.role, u.name, u.email
    INTO s
  FROM auth.sessions se
  JOIN app.users u ON u.id = se.user_id
  JOIN auth.devices d ON d.id = se.device_id
  WHERE se.token_hash = sha256(p_token_hash)
    AND se.revoked_at IS NULL
    AND se.expires_at > now()
    AND se.last_seen_at > now() - make_interval(mins => cfg.session_idle_minutes)
    AND u.status = 'active'
    AND d.status = 'approved'
    AND d.user_id = se.user_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF s.last_seen_at < now() - interval '1 minute' THEN
    UPDATE auth.sessions SET last_seen_at = now(), ip = p_ip WHERE id = s.id;
    UPDATE auth.devices SET last_seen_at = now() WHERE id = s.device_id;
  END IF;

  v_step := s.step_up_at IS NOT NULL
            AND s.step_up_at > now() - make_interval(mins => cfg.step_up_minutes);

  INSERT INTO authz.request_ctx AS c (pid, xact_start, user_id, session_id, ip, step_up)
  VALUES (pg_backend_pid(), transaction_timestamp(), s.user_id, s.id, p_ip, v_step)
  ON CONFLICT (pid) DO UPDATE
    SET xact_start = EXCLUDED.xact_start, user_id = EXCLUDED.user_id,
        session_id = EXCLUDED.session_id, ip = EXCLUDED.ip, step_up = EXCLUDED.step_up;

  RETURN QUERY
  SELECT s.user_id, s.id, s.device_id, s.role, s.name, s.email, v_step,
         coalesce((SELECT array_agg(uc.capability ORDER BY uc.capability)
                   FROM app.user_capabilities uc WHERE uc.user_id = s.user_id), '{}'::text[]);
END
$$;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.users_guard() RETURNS trigger
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
      -- First-run setup: the very first account, and only while setup is open.
      IF NEW.role = 'owner' AND NEW.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM app.users)
         AND EXISTS (SELECT 1 FROM app.instance_settings i WHERE i.setup_completed_at IS NULL) THEN
        NEW.created_by := NULL;
        RETURN NEW;
      END IF;
    ELSIF OLD.status = 'invited' AND NEW.status = 'active'
          AND NEW.id = OLD.id AND NEW.email = OLD.email AND NEW.name = OLD.name
          AND NEW.role = OLD.role AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by THEN
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

CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.users_guard();

-- The instance must always keep at least one active owner, and a suspended
-- account loses its sessions immediately.
CREATE FUNCTION app.users_after_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.role = 'owner' AND OLD.status = 'active'
     AND (NEW.role <> 'owner' OR NEW.status <> 'active')
     AND NOT EXISTS (SELECT 1 FROM app.users u WHERE u.role = 'owner' AND u.status = 'active') THEN
    RAISE EXCEPTION 'the instance needs at least one active owner' USING ERRCODE = 'CB003';
  END IF;
  IF NEW.status = 'suspended' AND OLD.status <> 'suspended' THEN
    UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'account suspended'
    WHERE user_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER after_change AFTER UPDATE OF role, status ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.users_after_change();

-- ---------------------------------------------------------------------------
-- Stamping authorship so it can never be spoofed by the caller
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.stamp_actor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := authz.uid();
  v_row   jsonb;
BEGIN
  IF session_user <> 'cerebro_app' THEN
    RETURN NEW;
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  -- TG_ARGV[0] names the authorship column. With 'restamp' as the second
  -- argument the column tracks whoever made the latest change; otherwise it is
  -- written once, on insert, and can never be changed afterwards.
  IF TG_OP = 'INSERT' OR TG_ARGV[1] = 'restamp' THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], v_actor));
  ELSE
    v_row := to_jsonb(NEW);
    IF (v_row ->> TG_ARGV[0]) IS DISTINCT FROM (to_jsonb(OLD) ->> TG_ARGV[0]) THEN
      RAISE EXCEPTION 'authorship cannot be changed' USING ERRCODE = 'CB001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.spaces
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('created_by');
CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.folders
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('created_by');
CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.items
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('created_by');
CREATE TRIGGER guard BEFORE INSERT ON app.item_assignees
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('assigned_by');
-- Grants and capabilities record who made the latest change.
CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.access_grants
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('granted_by', 'restamp');
CREATE TRIGGER guard BEFORE INSERT ON app.user_capabilities
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('granted_by');

-- A grant is tied to its person and scope; changing either would be a way to
-- move access around without passing the "can grant" check for the old row.
CREATE FUNCTION app.access_grants_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id
     OR NEW.space_id IS DISTINCT FROM OLD.space_id
     OR NEW.folder_id IS DISTINCT FROM OLD.folder_id
     OR NEW.list_id IS DISTINCT FROM OLD.list_id THEN
    RAISE EXCEPTION 'a grant cannot be moved' USING ERRCODE = 'CB001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER immutable_scope BEFORE UPDATE ON app.access_grants
  FOR EACH ROW EXECUTE FUNCTION app.access_grants_guard();

CREATE FUNCTION app.lists_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF session_user <> 'cerebro_app' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := authz.uid();
    RETURN NEW;
  END IF;
  IF NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'authorship cannot be changed' USING ERRCODE = 'CB001';
  END IF;
  IF NOT authz.is_owner() THEN
    -- Only owners can lower a list's protection or move it elsewhere.
    IF OLD.is_sensitive AND NOT NEW.is_sensitive THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
    END IF;
    IF NEW.space_id <> OLD.space_id OR NEW.folder_id IS DISTINCT FROM OLD.folder_id THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.lists
  FOR EACH ROW EXECUTE FUNCTION app.lists_guard();

CREATE FUNCTION app.folders_move_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF session_user = 'cerebro_app' AND NEW.space_id <> OLD.space_id AND NOT authz.is_owner() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER move_guard BEFORE UPDATE ON app.folders
  FOR EACH ROW EXECUTE FUNCTION app.folders_move_guard();

CREATE FUNCTION app.capabilities_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF session_user = 'cerebro_app' THEN
    PERFORM authz.require_step_up();
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER step_up BEFORE INSERT OR DELETE ON app.user_capabilities
  FOR EACH ROW EXECUTE FUNCTION app.capabilities_guard();

CREATE FUNCTION app.alerts_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF session_user = 'cerebro_app' THEN
    IF OLD.acknowledged_at IS NOT NULL THEN
      RAISE EXCEPTION 'already acknowledged' USING ERRCODE = 'CB003';
    END IF;
    NEW.acknowledged_by := authz.uid();
    NEW.acknowledged_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE UPDATE ON app.security_alerts
  FOR EACH ROW EXECUTE FUNCTION app.alerts_guard();

-- ---------------------------------------------------------------------------
-- Automatic audit of security-relevant tables
--
-- These fire inside the database, so a permission change is recorded even if
-- an endpoint forgets to log it.
-- ---------------------------------------------------------------------------

CREATE FUNCTION audit.on_security_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := authz.uid();
  v_row   jsonb;
  v_meta  jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_row := to_jsonb(NEW);
    v_meta := jsonb_build_object('new', v_row);
  ELSIF TG_OP = 'UPDATE' THEN
    v_row := to_jsonb(NEW);
    IF (to_jsonb(OLD) - 'updated_at') = (v_row - 'updated_at') THEN
      RETURN NULL;
    END IF;
    v_meta := jsonb_build_object('old', to_jsonb(OLD), 'new', v_row);
  ELSE
    v_row := to_jsonb(OLD);
    v_meta := jsonb_build_object('old', v_row);
  END IF;

  PERFORM audit.append_entry(v_actor, authz.session_id(), authz.client_ip(),
                             TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME,
                             v_row ->> TG_ARGV[0], v_meta);

  -- Owners are told whenever someone who is not an owner changes permissions.
  IF TG_ARGV[1] = 'alert' AND NOT authz.is_owner() THEN
    PERFORM app.raise_alert('permission_changed', 'warning', v_actor, jsonb_build_object(
      'table', TG_TABLE_NAME, 'operation', lower(TG_OP), 'target', v_row ->> TG_ARGV[0]));
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.access_grants
  FOR EACH ROW EXECUTE FUNCTION audit.on_security_change('user_id', 'alert');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.user_capabilities
  FOR EACH ROW EXECUTE FUNCTION audit.on_security_change('user_id', 'alert');
CREATE TRIGGER audit AFTER UPDATE ON app.instance_settings
  FOR EACH ROW EXECUTE FUNCTION audit.on_security_change('id', 'silent');

CREATE FUNCTION audit.on_user_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := authz.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM audit.append_entry(v_actor, authz.session_id(), authz.client_ip(), 'user.created',
                               'user', NEW.id::text,
                               jsonb_build_object('email', NEW.email, 'role', NEW.role));
    IF NEW.role = 'owner' AND v_actor IS NOT NULL THEN
      PERFORM app.raise_alert('owner_added', 'critical', v_actor,
                              jsonb_build_object('user_id', NEW.id));
    ELSIF v_actor IS NOT NULL AND NOT authz.is_owner() THEN
      PERFORM app.raise_alert('user_created', 'info', v_actor,
                              jsonb_build_object('user_id', NEW.id, 'role', NEW.role));
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.role = OLD.role AND NEW.status = OLD.status AND NEW.email = OLD.email
     AND NEW.name = OLD.name THEN
    RETURN NULL;
  END IF;

  PERFORM audit.append_entry(v_actor, authz.session_id(), authz.client_ip(), 'user.updated',
    'user', NEW.id::text, jsonb_build_object(
      'old', jsonb_build_object('email', OLD.email, 'name', OLD.name, 'role', OLD.role, 'status', OLD.status),
      'new', jsonb_build_object('email', NEW.email, 'name', NEW.name, 'role', NEW.role, 'status', NEW.status)));

  IF NEW.role <> OLD.role AND 'owner' IN (NEW.role, OLD.role) THEN
    PERFORM app.raise_alert('owner_role_changed', 'critical', v_actor, jsonb_build_object(
      'user_id', NEW.id, 'from', OLD.role, 'to', NEW.role));
  ELSIF (NEW.role <> OLD.role OR NEW.status <> OLD.status OR NEW.email <> OLD.email)
        AND v_actor IS NOT NULL AND NOT authz.is_owner() THEN
    PERFORM app.raise_alert('permission_changed', 'warning', v_actor, jsonb_build_object(
      'table', 'users', 'operation', 'update', 'target', NEW.id));
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER audit AFTER INSERT OR UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION audit.on_user_change();

-- ---------------------------------------------------------------------------
-- Privileged procedures callable by the application role
--
-- Each one re-checks authority inside the database, for the person bound to
-- the request. The API cannot approve a device or mint an invite on behalf of
-- someone who is not allowed to.
-- ---------------------------------------------------------------------------

CREATE FUNCTION auth.my_sessions()
RETURNS TABLE (id uuid, device_id uuid, created_at timestamptz, last_seen_at timestamptz,
               expires_at timestamptz, ip inet, user_agent text, is_current boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.id, s.device_id, s.created_at, s.last_seen_at, s.expires_at, s.ip, s.user_agent,
         s.id = authz.session_id()
  FROM auth.sessions s
  WHERE s.user_id = authz.uid() AND s.revoked_at IS NULL AND s.expires_at > now()
  ORDER BY s.last_seen_at DESC
$$;

-- Devices the caller may look at: their own, plus everyone's for owners, plus
-- those of people below them for holders of `devices.approve`.
CREATE FUNCTION auth.list_devices(p_only_mine boolean DEFAULT false)
RETURNS TABLE (id uuid, user_id uuid, user_name text, user_email text, user_role app.user_role,
               status auth.device_status, user_agent text, created_at timestamptz,
               created_ip inet, last_seen_at timestamptz, decided_by uuid,
               decided_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.id, d.user_id, u.name, u.email, u.role, d.status, d.user_agent, d.created_at,
         d.created_ip, d.last_seen_at, d.decided_by, d.decided_at
  FROM auth.devices d
  JOIN app.users u ON u.id = d.user_id
  WHERE authz.my_role() IS NOT NULL
    AND (
      d.user_id = authz.uid()
      OR (NOT p_only_mine AND (
        authz.is_owner()
        OR (authz.has_capability('devices.approve') AND u.role < authz.my_role())
      ))
    )
  ORDER BY d.created_at DESC
$$;

CREATE FUNCTION auth.decide_device(p_device uuid, p_decision text) RETURNS auth.device_status
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor  uuid := authz.uid();
  v_role   app.user_role := authz.my_role();
  d        record;
  v_status auth.device_status;
  v_has_authority boolean;
BEGIN
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;

  SELECT dv.id, dv.user_id, dv.status, u.role AS user_role INTO d
  FROM auth.devices dv JOIN app.users u ON u.id = dv.user_id
  WHERE dv.id = p_device FOR UPDATE OF dv;

  v_has_authority := FOUND AND (
    v_role = 'owner' OR (authz.has_capability('devices.approve') AND d.user_role < v_role));

  -- Anyone may cut off one of their own devices (a lost phone); nothing else
  -- is allowed without authority. Unknown ids look the same as forbidden ones.
  IF NOT FOUND OR NOT (v_has_authority OR (p_decision = 'revoke' AND d.user_id = v_actor)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;

  IF p_decision = 'approve' AND d.status = 'pending' THEN
    PERFORM authz.require_step_up();
    v_status := 'approved';
  ELSIF p_decision = 'reject' AND d.status = 'pending' THEN
    v_status := 'rejected';
  ELSIF p_decision = 'revoke' AND d.status IN ('pending', 'approved') THEN
    v_status := 'revoked';
  ELSE
    RAISE EXCEPTION 'invalid device decision' USING ERRCODE = 'CB003';
  END IF;

  UPDATE auth.devices SET status = v_status, decided_by = v_actor, decided_at = now()
  WHERE id = p_device;
  IF v_status <> 'approved' THEN
    UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'device ' || v_status::text
    WHERE device_id = p_device AND revoked_at IS NULL;
  END IF;

  PERFORM audit.append_entry(v_actor, authz.session_id(), authz.client_ip(),
                             'device.' || v_status::text, 'device', p_device::text,
                             jsonb_build_object('user_id', d.user_id));
  IF v_status = 'approved' AND v_role <> 'owner' THEN
    PERFORM app.raise_alert('device_approved', 'warning', v_actor,
                            jsonb_build_object('device_id', p_device, 'user_id', d.user_id));
  END IF;
  RETURN v_status;
END
$$;

CREATE FUNCTION auth.revoke_session(p_session uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_owner uuid;
BEGIN
  SELECT s.user_id INTO v_owner FROM auth.sessions s
  WHERE s.id = p_session AND s.revoked_at IS NULL;
  IF NOT FOUND OR NOT (v_owner = authz.uid() OR authz.can_manage_user(v_owner)) THEN
    RETURN false;
  END IF;
  UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'revoked'
  WHERE id = p_session AND revoked_at IS NULL;
  PERFORM audit.append_entry(authz.uid(), authz.session_id(), authz.client_ip(),
                             'session.revoked', 'session', p_session::text,
                             jsonb_build_object('user_id', v_owner));
  RETURN true;
END
$$;

CREATE FUNCTION auth.revoke_user_sessions(p_user uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_count integer;
BEGIN
  IF authz.my_role() IS NULL OR NOT (p_user = authz.uid() OR authz.can_manage_user(p_user)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  -- When someone signs themselves out everywhere, keep the session they are using.
  UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'revoked'
  WHERE user_id = p_user AND revoked_at IS NULL
    AND NOT (p_user = authz.uid() AND id = authz.session_id());
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM audit.append_entry(authz.uid(), authz.session_id(), authz.client_ip(),
                             'sessions.revoked_all', 'user', p_user::text,
                             jsonb_build_object('count', v_count));
  RETURN v_count;
END
$$;

-- Issues a one-time link. 'invite' lets a newly created person choose a
-- password; 'reset' makes an existing person choose a new password and enrol
-- their second factor again. Only the digest of the token is stored.
CREATE FUNCTION auth.create_invite(p_user uuid, p_token_hash bytea, p_kind text)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor   uuid := authz.uid();
  v_target  record;
  v_expires timestamptz := now() + interval '72 hours';
BEGIN
  PERFORM authz.require_step_up();
  IF NOT authz.can_manage_user(p_user) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  IF octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'invalid token digest' USING ERRCODE = 'CB003';
  END IF;

  SELECT u.status, u.role INTO STRICT v_target FROM app.users u WHERE u.id = p_user;
  IF (p_kind = 'invite' AND v_target.status <> 'invited')
     OR (p_kind = 'reset' AND v_target.status <> 'active')
     OR p_kind NOT IN ('invite', 'reset') THEN
    RAISE EXCEPTION 'invite kind does not match the account status' USING ERRCODE = 'CB003';
  END IF;

  -- A new link invalidates the previous ones.
  DELETE FROM auth.invites i WHERE i.user_id = p_user AND i.used_at IS NULL;
  INSERT INTO auth.invites (token_hash, user_id, kind, created_by, expires_at)
  VALUES (sha256(p_token_hash), p_user, p_kind, v_actor, v_expires);

  PERFORM audit.append_entry(v_actor, authz.session_id(), authz.client_ip(),
                             'invite.created', 'user', p_user::text,
                             jsonb_build_object('kind', p_kind));
  IF p_kind = 'reset' AND (v_target.role = 'owner' OR NOT authz.is_owner()) THEN
    PERFORM app.raise_alert('access_reset_issued',
                            CASE WHEN v_target.role = 'owner' THEN 'critical' ELSE 'warning' END,
                            v_actor, jsonb_build_object('user_id', p_user));
  END IF;
  RETURN v_expires;
END
$$;
