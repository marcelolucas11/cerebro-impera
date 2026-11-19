-- =============================================================================
-- Sign-in and uploads, from the independent review (D75).
--
--   1. An authenticator is linked only right after an invite or an access reset
--      is accepted, never with the password alone.
--   2. The live stream checking the session is not activity: an open tab does
--      not keep a session from going idle.
--   3. What is still being uploaded counts as space taken, and one person has
--      at most five uploads open at a time.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Linking an authenticator
-- ---------------------------------------------------------------------------

-- A challenge made when an invite or reset is used carries the right to link
-- an authenticator; one made by the password step never does.
ALTER TABLE auth.login_challenges ADD COLUMN enrol boolean NOT NULL DEFAULT false;

CREATE FUNCTION auth.login_challenges_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF session_user <> 'cerebro_auth' OR NOT NEW.enrol THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.invites i WHERE i.user_id = NEW.user_id AND i.used_at = now()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE INSERT ON auth.login_challenges
  FOR EACH ROW EXECUTE FUNCTION auth.login_challenges_guard();

-- After it is made, the login service only counts attempts and consumes it.
REVOKE UPDATE ON auth.login_challenges FROM cerebro_auth;
GRANT UPDATE (attempts, consumed_at) ON auth.login_challenges TO cerebro_auth;

-- ---------------------------------------------------------------------------
-- 2. Checking without counting as activity
-- ---------------------------------------------------------------------------

-- The same as begin_request, with p_activity saying whether this request is the
-- person doing something (it then counts against the idle time) or only the app
-- checking that the session still holds.
CREATE FUNCTION authz.begin_request(p_token_hash bytea, p_ip inet, p_activity boolean)
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

  IF p_activity AND s.last_seen_at < now() - interval '1 minute' THEN
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

CREATE OR REPLACE FUNCTION authz.begin_request(p_token_hash bytea, p_ip inet)
RETURNS TABLE (
  ctx_user_id uuid, ctx_session_id uuid, ctx_device_id uuid, ctx_role app.user_role,
  ctx_name text, ctx_email text, ctx_step_up boolean, ctx_capabilities text[]
)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT * FROM authz.begin_request(p_token_hash, p_ip, true)
$$;

REVOKE EXECUTE ON FUNCTION
  auth.login_challenges_guard(),
  authz.begin_request(bytea, inet, boolean)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.begin_request(bytea, inet, boolean) TO cerebro_app;

-- ---------------------------------------------------------------------------
-- 3. Room for uploads
-- ---------------------------------------------------------------------------

-- How much of what is being uploaded has not arrived yet (everyone's: the disk
-- is shared), and how many uploads the person has open. Only sums: no names,
-- no sizes of anyone's file in particular.
CREATE FUNCTION app.uploads_open() RETURNS TABLE (pending bigint, mine integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(sum(a.size - coalesce(p.got, 0)), 0)::bigint,
         (count(*) FILTER (WHERE a.created_by = authz.uid()))::integer
  FROM app.attachments a
  LEFT JOIN (SELECT ap.attachment_id, sum(ap.size) AS got
             FROM app.attachment_parts ap GROUP BY ap.attachment_id) p
    ON p.attachment_id = a.id
  WHERE a.status = 'uploading'
$$;

CREATE FUNCTION app.attachments_open_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF authz.enforced()
     AND (SELECT count(*) FROM app.attachments a
          WHERE a.created_by = authz.uid() AND a.status = 'uploading') >= 5 THEN
    RAISE EXCEPTION 'at most five uploads open at a time' USING ERRCODE = 'CB003';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER open_limit BEFORE INSERT ON app.attachments
  FOR EACH ROW EXECUTE FUNCTION app.attachments_open_limit();

REVOKE EXECUTE ON FUNCTION app.uploads_open(), app.attachments_open_limit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.uploads_open() TO cerebro_app;
