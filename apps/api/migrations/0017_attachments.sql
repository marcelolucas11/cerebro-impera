-- =============================================================================
-- Attachments. The content lives in the installation's file volume, encrypted
-- with a key of its own; here are the facts about each file, its key (sealed
-- with the instance key) and the rules: an attachment follows its item, an
-- upload is visible only to whoever is sending it, and nothing is downloadable
-- until it has been checked. See docs/design/anexos.md.
-- =============================================================================

CREATE TYPE app.attachment_status AS ENUM ('uploading', 'scanning', 'ready', 'blocked');

CREATE TABLE app.attachments (
  id            uuid PRIMARY KEY,
  item_id       uuid NOT NULL REFERENCES app.items (id) ON DELETE CASCADE,
  -- As the person named it. Never used as a path; no control characters or slashes.
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 255
                                     AND name !~ '[[:cntrl:]/\\]' AND name = btrim(name)),
  size          bigint NOT NULL CHECK (size BETWEEN 1 AND 1099511627776),
  declared_type text NOT NULL CHECK (length(declared_type) <= 200),
  -- What the content turned out to be, from its first bytes; null when unknown.
  detected_type text CHECK (detected_type IS NULL OR length(detected_type) <= 100),
  sha256        bytea CHECK (sha256 IS NULL OR length(sha256) = 32),
  -- The file's own key, sealed with the instance key. Without it the content
  -- on disk is noise: removing this row is enough to make the file unreadable.
  wrapped_key   bytea NOT NULL,
  status        app.attachment_status NOT NULL DEFAULT 'uploading',
  scan_result   text CHECK (scan_result IN ('clean', 'infected', 'not_scanned')),
  created_by    uuid NOT NULL REFERENCES app.users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  scanned_at    timestamptz,
  deleted_at    timestamptz,
  deleted_by    uuid REFERENCES app.users (id),
  CHECK ((status IN ('ready', 'blocked')) = (scan_result IS NOT NULL)),
  CHECK (status = 'uploading' OR (finished_at IS NOT NULL AND sha256 IS NOT NULL)),
  CHECK (deleted_at IS NOT NULL OR deleted_by IS NULL)
);
CREATE INDEX attachments_item_idx ON app.attachments (item_id);
CREATE INDEX attachments_pending_idx ON app.attachments (status, created_at)
  WHERE status IN ('uploading', 'scanning');

-- The parts of an upload that have arrived.
CREATE TABLE app.attachment_parts (
  attachment_id uuid NOT NULL REFERENCES app.attachments (id) ON DELETE CASCADE,
  n             integer NOT NULL CHECK (n >= 0),
  size          integer NOT NULL CHECK (size BETWEEN 1 AND 8388608),
  received_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attachment_id, n)
);

-- Content to wipe from disk, queued when an attachment row goes away. The
-- content is already unreadable at that point (its key went with the row);
-- wiping it frees the space.
CREATE TABLE app.attachment_disposals (
  attachment_id uuid PRIMARY KEY,
  queued_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- Who sent it is written on the way in. Later changes are made partly by the
-- server's own background work (the antivirus), which acts for nobody.
CREATE TRIGGER guard BEFORE INSERT ON app.attachments
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('created_by');

-- Nothing is attached to an item in the trash.
CREATE TRIGGER trash_guard BEFORE INSERT ON app.attachments
  FOR EACH ROW EXECUTE FUNCTION app.refuse_if_trashed();

CREATE FUNCTION app.attachments_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (NEW.item_id, NEW.name, NEW.size, NEW.declared_type, NEW.wrapped_key, NEW.created_at,
      NEW.created_by)
     IS DISTINCT FROM
     (OLD.item_id, OLD.name, OLD.size, OLD.declared_type, OLD.wrapped_key, OLD.created_at,
      OLD.created_by) THEN
    RAISE EXCEPTION 'an attachment keeps what it was sent as' USING ERRCODE = 'CB003';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    IF OLD.status = 'uploading' OR NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'only a finished attachment goes to the trash' USING ERRCODE = 'CB003';
    END IF;
    IF NEW.deleted_at IS NOT NULL THEN
      IF session_user = 'cerebro_app' THEN
        NEW.deleted_at := now();
      END IF;
      NEW.deleted_by := authz.uid();
    ELSE
      NEW.deleted_by := NULL;
    END IF;
  ELSIF NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
    RAISE EXCEPTION 'only the trash says who sent an attachment there' USING ERRCODE = 'CB003';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER keep BEFORE UPDATE ON app.attachments
  FOR EACH ROW EXECUTE FUNCTION app.attachments_guard();

-- A part has a place in the file and exactly the length that place needs.
CREATE FUNCTION app.attachment_parts_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_size  bigint;
  v_count integer;
BEGIN
  SELECT a.size INTO v_size FROM app.attachments a
  WHERE a.id = NEW.attachment_id AND a.status = 'uploading';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this upload is not open' USING ERRCODE = 'CB003';
  END IF;
  v_count := ((v_size + 8388607) / 8388608)::integer;
  -- In parentheses: PL/pgSQL would otherwise end the condition at the CASE's own THEN.
  IF NEW.n >= v_count OR NEW.size <> (CASE WHEN NEW.n = v_count - 1
                                           THEN v_size - 8388608::bigint * (v_count - 1)
                                           ELSE 8388608 END) THEN
    RAISE EXCEPTION 'this part does not fit the file' USING ERRCODE = '23514';
  END IF;
  NEW.received_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER fits BEFORE INSERT OR UPDATE ON app.attachment_parts
  FOR EACH ROW EXECUTE FUNCTION app.attachment_parts_guard();

CREATE FUNCTION app.attachments_dispose() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO app.attachment_disposals (attachment_id) VALUES (OLD.id) ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
CREATE TRIGGER dispose AFTER DELETE ON app.attachments
  FOR EACH ROW EXECUTE FUNCTION app.attachments_dispose();

-- ---------------------------------------------------------------------------
-- On the item's history
-- ---------------------------------------------------------------------------

ALTER TABLE app.item_changes DROP CONSTRAINT item_changes_what_check;
ALTER TABLE app.item_changes ADD CONSTRAINT item_changes_what_check CHECK (what IN (
  'created', 'title', 'description', 'list', 'stage', 'assigned', 'unassigned', 'field',
  'trashed', 'restored', 'attachment_added', 'attachment_removed', 'attachment_restored'));

CREATE FUNCTION app.attachments_record_changes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_what text;
BEGIN
  IF OLD.status = 'uploading' AND NEW.status <> 'uploading' THEN
    v_what := 'attachment_added';
  ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    v_what := 'attachment_removed';
  ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    v_what := 'attachment_restored';
  ELSE
    RETURN NULL;
  END IF;
  INSERT INTO app.item_changes (item_id, actor, what, new)
  VALUES (NEW.item_id, authz.uid(), v_what, jsonb_build_object('id', NEW.id, 'name', NEW.name));
  RETURN NULL;
END
$$;
CREATE TRIGGER record_changes AFTER UPDATE ON app.attachments
  FOR EACH ROW EXECUTE FUNCTION app.attachments_record_changes();

-- ---------------------------------------------------------------------------
-- Steps of an upload that only the database may take
-- ---------------------------------------------------------------------------

-- The sender says every part is there. Checked against the parts received;
-- the attachment then waits for the antivirus.
CREATE FUNCTION app.finish_upload(p_id uuid, p_sha256 bytea, p_detected_type text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_size  bigint;
  v_count integer;
BEGIN
  SELECT a.size INTO v_size FROM app.attachments a
  WHERE a.id = p_id AND a.status = 'uploading' AND a.created_by = authz.uid()
    AND authz.item_level(a.item_id) >= 'edit'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
  SELECT count(*), coalesce(sum(p.size), 0) INTO v_count, v_size
  FROM app.attachment_parts p WHERE p.attachment_id = p_id
  HAVING coalesce(sum(p.size), 0) = v_size;
  IF NOT FOUND OR v_count <> ((v_size + 8388607) / 8388608)::integer THEN
    RAISE EXCEPTION 'parts are missing' USING ERRCODE = 'CB003';
  END IF;
  UPDATE app.attachments
  SET status = 'scanning', finished_at = now(), sha256 = p_sha256, detected_type = p_detected_type
  WHERE id = p_id;
END
$$;

-- The antivirus has spoken. Only from "scanning", and only once.
CREATE FUNCTION app.record_scan(p_id uuid, p_result text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_by uuid;
BEGIN
  IF p_result NOT IN ('clean', 'infected', 'not_scanned') THEN
    RAISE EXCEPTION 'unknown scan result' USING ERRCODE = '22023';
  END IF;
  UPDATE app.attachments
  SET status = CASE WHEN p_result = 'infected' THEN 'blocked' ELSE 'ready' END::app.attachment_status,
      scan_result = p_result, scanned_at = now()
  WHERE id = p_id AND status = 'scanning'
  RETURNING created_by INTO v_by;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'nothing to record' USING ERRCODE = 'CB003';
  END IF;
  IF p_result = 'infected' THEN
    PERFORM audit.record_as(v_by, NULL, 'attachment.blocked', 'attachment', p_id::text);
    PERFORM app.raise_alert('attachment_infected', 'critical', v_by,
                            jsonb_build_object('attachment_id', p_id));
  END IF;
END
$$;

-- The sender gives up an upload.
CREATE FUNCTION app.cancel_upload(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM app.attachments
  WHERE id = p_id AND status = 'uploading' AND created_by = authz.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'CB001';
  END IF;
END
$$;

-- Housekeeping, run by the application every hour: abandoned uploads after a
-- day, removed and blocked attachments after thirty days.
CREATE FUNCTION app.purge_attachments() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_count integer;
BEGIN
  WITH gone AS (
    DELETE FROM app.attachments
    WHERE (status = 'uploading' AND created_at < now() - interval '24 hours')
       OR (deleted_at < now() - interval '30 days')
       OR (status = 'blocked' AND scanned_at < now() - interval '30 days')
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM gone;
  IF v_count > 0 THEN
    PERFORM audit.record_as(NULL, NULL, 'attachments.purged', NULL, NULL,
                            jsonb_build_object('count', v_count));
  END IF;
  RETURN v_count;
END
$$;

-- What still waits for the antivirus, so a restart picks it up again.
CREATE FUNCTION app.attachments_waiting_for_scan()
RETURNS TABLE (id uuid, size bigint, wrapped_key bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.id, a.size, a.wrapped_key FROM app.attachments a
  WHERE a.status = 'scanning' ORDER BY a.finished_at LIMIT 1000
$$;

-- Hands the application the content to wipe, at most a batch at a time.
CREATE FUNCTION app.take_disposals(p_limit integer) RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM app.attachment_disposals
  WHERE attachment_id IN (
    SELECT d.attachment_id FROM app.attachment_disposals d
    ORDER BY d.queued_at LIMIT least(p_limit, 500)
  )
  RETURNING attachment_id
$$;

-- ---------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------

ALTER TABLE app.attachments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.attachment_parts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.attachment_disposals ENABLE ROW LEVEL SECURITY;

-- Seen by whoever sees the item; an upload in progress only by its sender.
CREATE POLICY attachments_select ON app.attachments FOR SELECT TO cerebro_app
  USING (
    EXISTS (SELECT 1 FROM app.items i WHERE i.id = attachments.item_id)
    AND (status <> 'uploading' OR created_by = authz.uid())
  );
CREATE POLICY attachments_insert ON app.attachments FOR INSERT TO cerebro_app
  WITH CHECK (authz.item_level(item_id) >= 'edit');
CREATE POLICY attachments_update ON app.attachments FOR UPDATE TO cerebro_app
  USING (authz.item_level(item_id) >= 'edit')
  WITH CHECK (authz.item_level(item_id) >= 'edit');

-- Parts are the sender's business alone.
CREATE POLICY parts_select ON app.attachment_parts FOR SELECT TO cerebro_app
  USING (EXISTS (
    SELECT 1 FROM app.attachments a
    WHERE a.id = attachment_parts.attachment_id AND a.created_by = authz.uid()
  ));
CREATE POLICY parts_insert ON app.attachment_parts FOR INSERT TO cerebro_app
  WITH CHECK (EXISTS (
    SELECT 1 FROM app.attachments a
    WHERE a.id = attachment_parts.attachment_id AND a.created_by = authz.uid()
      AND a.status = 'uploading'
  ));
CREATE POLICY parts_update ON app.attachment_parts FOR UPDATE TO cerebro_app
  USING (EXISTS (
    SELECT 1 FROM app.attachments a
    WHERE a.id = attachment_parts.attachment_id AND a.created_by = authz.uid()
      AND a.status = 'uploading'
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM app.attachments a
    WHERE a.id = attachment_parts.attachment_id AND a.created_by = authz.uid()
      AND a.status = 'uploading'
  ));

GRANT SELECT ON app.attachments, app.attachment_parts TO cerebro_app;
GRANT INSERT (id, item_id, name, size, declared_type, wrapped_key) ON app.attachments
  TO cerebro_app;
-- Sent to the trash and brought back; everything else changes through the functions above.
GRANT UPDATE (deleted_at) ON app.attachments TO cerebro_app;
GRANT INSERT (attachment_id, n, size), UPDATE (size) ON app.attachment_parts TO cerebro_app;
-- The disposal queue is not the application's to read or write; it takes from it.

REVOKE EXECUTE ON FUNCTION
  app.attachments_guard(),
  app.attachment_parts_guard(),
  app.attachments_dispose(),
  app.attachments_record_changes(),
  app.finish_upload(uuid, bytea, text),
  app.record_scan(uuid, text),
  app.cancel_upload(uuid),
  app.purge_attachments(),
  app.take_disposals(integer),
  app.attachments_waiting_for_scan()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.finish_upload(uuid, bytea, text),
  app.record_scan(uuid, text),
  app.cancel_upload(uuid),
  app.purge_attachments(),
  app.take_disposals(integer),
  app.attachments_waiting_for_scan()
TO cerebro_app;
