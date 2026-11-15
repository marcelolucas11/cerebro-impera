-- Append-only audit trail with a hash chain.
--
-- Nobody can edit or delete entries through the application: the roles the API
-- uses have no such privilege and triggers reject it even for the table owner.
-- Each entry also stores the hash of the previous one, so tampering by someone
-- with full database access (who could disable the triggers) is detectable:
-- `audit.verify_chain()` recomputes the chain and reports the first break.

CREATE TABLE audit.log (
  seq              bigint PRIMARY KEY,
  at               timestamptz NOT NULL,
  actor_user_id    uuid,
  actor_session_id uuid,
  actor_db_role    text NOT NULL,
  ip               inet,
  action           text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  target_type      text,
  target_id        text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash        bytea NOT NULL,
  hash             bytea NOT NULL
);
CREATE INDEX log_at_idx ON audit.log (at DESC);
CREATE INDEX log_actor_idx ON audit.log (actor_user_id, seq DESC);
CREATE INDEX log_action_idx ON audit.log (action, seq DESC);
CREATE INDEX log_target_idx ON audit.log (target_type, target_id, seq DESC);

-- Single row holding the tip of the chain. Locking it serialises appends, so
-- sequence numbers are gapless and every entry links to the true predecessor.
CREATE TABLE audit.chain_head (
  id        boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_seq  bigint NOT NULL,
  last_hash bytea NOT NULL
);
INSERT INTO audit.chain_head (last_seq, last_hash)
VALUES (0, sha256(convert_to('cerebro-audit-genesis', 'UTF8')));

CREATE FUNCTION audit.entry_hash(
  p_prev bytea, p_seq bigint, p_at timestamptz, p_actor uuid, p_session uuid,
  p_db_role text, p_ip inet, p_action text, p_target_type text, p_target_id text,
  p_metadata jsonb
) RETURNS bytea
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT sha256(p_prev || convert_to(jsonb_build_object(
    'seq', p_seq,
    'at_us', (extract(epoch FROM p_at) * 1000000)::bigint,
    'actor', p_actor,
    'session', p_session,
    'db_role', p_db_role,
    'ip', host(p_ip),
    'action', p_action,
    'target_type', p_target_type,
    'target_id', p_target_id,
    'metadata', p_metadata
  )::text, 'UTF8'))
$$;

-- Internal: the only code path that writes to the log.
CREATE FUNCTION audit.append_entry(
  p_actor uuid, p_session uuid, p_ip inet, p_action text,
  p_target_type text, p_target_id text, p_metadata jsonb
) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_prev bytea;
  v_seq  bigint;
  v_at   timestamptz := date_trunc('microseconds', clock_timestamp());
  v_meta jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_hash bytea;
BEGIN
  SELECT h.last_seq + 1, h.last_hash INTO STRICT v_seq, v_prev
  FROM audit.chain_head h WHERE h.id FOR UPDATE;

  v_hash := audit.entry_hash(v_prev, v_seq, v_at, p_actor, p_session, session_user::text,
                             p_ip, p_action, p_target_type, p_target_id, v_meta);

  INSERT INTO audit.log (seq, at, actor_user_id, actor_session_id, actor_db_role, ip, action,
                         target_type, target_id, metadata, prev_hash, hash)
  VALUES (v_seq, v_at, p_actor, p_session, session_user::text, p_ip, p_action,
          p_target_type, p_target_id, v_meta, v_prev, v_hash);

  UPDATE audit.chain_head SET last_seq = v_seq, last_hash = v_hash WHERE id;
  RETURN v_seq;
END
$$;

-- For authenticated requests: the actor always comes from the verified request
-- context, never from an argument.
CREATE FUNCTION audit.record(
  p_action text, p_target_type text DEFAULT NULL, p_target_id text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS bigint
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT audit.append_entry(authz.uid(), authz.session_id(), authz.client_ip(),
                            p_action, p_target_type, p_target_id, p_metadata)
$$;

-- For the login flow, where there is no session yet.
CREATE FUNCTION audit.record_as(
  p_actor uuid, p_ip inet, p_action text, p_target_type text DEFAULT NULL,
  p_target_id text DEFAULT NULL, p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS bigint
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT audit.append_entry(p_actor, NULL, p_ip, p_action, p_target_type, p_target_id, p_metadata)
$$;

CREATE FUNCTION audit.reject_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'the audit trail is append-only' USING ERRCODE = 'CB001';
END
$$;

CREATE TRIGGER log_immutable BEFORE UPDATE OR DELETE ON audit.log
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER log_no_truncate BEFORE TRUNCATE ON audit.log
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER chain_head_no_delete BEFORE DELETE ON audit.chain_head
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER chain_head_no_truncate BEFORE TRUNCATE ON audit.chain_head
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();

-- Recomputes the whole chain. Returns ok = false and the first bad sequence
-- number when an entry was altered, removed or inserted out of band.
CREATE FUNCTION audit.verify_chain()
RETURNS TABLE (ok boolean, checked bigint, broken_seq bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r          record;
  v_prev     bytea := sha256(convert_to('cerebro-audit-genesis', 'UTF8'));
  v_next_seq bigint := 1;
  v_head     record;
BEGIN
  IF session_user IN ('cerebro_app', 'cerebro_auth')
     AND NOT authz.has_capability('audit.view') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;

  FOR r IN SELECT * FROM audit.log l ORDER BY l.seq LOOP
    IF r.seq <> v_next_seq
       OR r.prev_hash <> v_prev
       OR r.hash <> audit.entry_hash(r.prev_hash, r.seq, r.at, r.actor_user_id,
                                     r.actor_session_id, r.actor_db_role, r.ip, r.action,
                                     r.target_type, r.target_id, r.metadata) THEN
      RETURN QUERY SELECT false, v_next_seq - 1, r.seq;
      RETURN;
    END IF;
    v_prev := r.hash;
    v_next_seq := r.seq + 1;
  END LOOP;

  -- The tip must match too, otherwise deleting the newest entries would pass.
  SELECT h.last_seq, h.last_hash INTO v_head FROM audit.chain_head h WHERE h.id;
  IF v_head.last_seq <> v_next_seq - 1 OR v_head.last_hash <> v_prev THEN
    RETURN QUERY SELECT false, v_next_seq - 1, v_next_seq;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, v_next_seq - 1, NULL::bigint;
END
$$;
