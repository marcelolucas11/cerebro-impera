-- =============================================================================
-- A field for what nobody should read over someone's shoulder: passwords,
-- access keys. The value is sealed by the API with the instance key and kept
-- in a table of its own, whose sealed column the API cannot read. The only way
-- back to a value is app.reveal_secret, which asks for the capability to
-- reveal secrets and a recent second factor, and puts every reveal on the
-- record. Whoever edits the item may replace or clear a value without seeing it.
-- =============================================================================

ALTER TYPE app.field_kind ADD VALUE 'secret';

-- A secret never sits among the ordinary values, where every list read and
-- the history would carry it.
ALTER FUNCTION app.field_value_problem(app.field_kind, jsonb, jsonb, jsonb)
  RENAME TO field_value_problem_before_secret;

CREATE FUNCTION app.field_value_problem(
  p_kind app.field_kind, p_config jsonb, p_value jsonb, p_previous jsonb
) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF p_kind::text = 'secret' THEN
    RETURN 'a secret is kept apart from the other values';
  END IF;
  RETURN app.field_value_problem_before_secret(p_kind, p_config, p_value, p_previous);
END
$$;

CREATE TABLE app.item_secrets (
  item_id    uuid NOT NULL REFERENCES app.items (id) ON DELETE CASCADE,
  field_id   uuid NOT NULL REFERENCES app.list_fields (id),
  -- nonce, tag and up to 2000 characters of UTF-8, sealed by the API.
  sealed     bytea NOT NULL CHECK (octet_length(sealed) BETWEEN 29 AND 8100),
  updated_by uuid NOT NULL REFERENCES app.users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, field_id)
);
CREATE INDEX item_secrets_field_idx ON app.item_secrets (field_id);

CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.item_secrets
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('updated_by', 'restamp');
CREATE TRIGGER trash_guard BEFORE INSERT OR UPDATE OR DELETE ON app.item_secrets
  FOR EACH ROW EXECUTE FUNCTION app.refuse_if_trashed();

-- A secret belongs to an active secret field of the item's own list, and stays
-- with its item and field.
CREATE FUNCTION app.item_secrets_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.item_id <> OLD.item_id OR NEW.field_id <> OLD.field_id) THEN
    RAISE EXCEPTION 'a secret stays with its item and its field' USING ERRCODE = 'CB003';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.list_fields f
    JOIN app.items i ON i.list_id = f.list_id
    WHERE f.id = NEW.field_id AND i.id = NEW.item_id
      AND f.kind::text = 'secret' AND NOT f.is_archived
  ) THEN
    RAISE EXCEPTION 'not a secret field of the item''s list' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER keep BEFORE INSERT OR UPDATE ON app.item_secrets
  FOR EACH ROW EXECUTE FUNCTION app.item_secrets_guard();

-- The history says that a secret was set, changed or cleared; never what it is.
CREATE FUNCTION app.item_secrets_record_changes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_marker constant jsonb := '{"secret": true}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.item_changes (item_id, actor, what, field_id, new)
    VALUES (NEW.item_id, authz.uid(), 'field', NEW.field_id, v_marker);
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.sealed <> OLD.sealed THEN
      INSERT INTO app.item_changes (item_id, actor, what, field_id, old, new)
      VALUES (NEW.item_id, authz.uid(), 'field', NEW.field_id, v_marker, v_marker);
    END IF;
  ELSIF EXISTS (SELECT 1 FROM app.items i WHERE i.id = OLD.item_id) THEN
    INSERT INTO app.item_changes (item_id, actor, what, field_id, old)
    VALUES (OLD.item_id, authz.uid(), 'field', OLD.field_id, v_marker);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER record_changes AFTER INSERT OR UPDATE OR DELETE ON app.item_secrets
  FOR EACH ROW EXECUTE FUNCTION app.item_secrets_record_changes();

-- ---------------------------------------------------------------------------
-- The one way back to a value
-- ---------------------------------------------------------------------------

-- The sealed value, for whoever sees the item and holds the capability to
-- reveal secrets (owners hold every capability), with a recent second factor,
-- while the field is an active field of the item's list and the item is not in
-- the trash. Every call is on the record, before the value leaves.
CREATE FUNCTION app.reveal_secret(p_item uuid, p_field uuid) RETURNS bytea
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_sealed bytea;
BEGIN
  PERFORM authz.require_step_up();
  IF NOT authz.has_capability('secret_fields.reveal')
     OR authz.field_value_level(p_item, p_field) < 'view'
     OR EXISTS (SELECT 1 FROM app.items i WHERE i.id = p_item AND i.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'not allowed to reveal this secret' USING ERRCODE = 'CB001';
  END IF;
  SELECT s.sealed INTO v_sealed
  FROM app.item_secrets s JOIN app.list_fields f ON f.id = s.field_id
  WHERE s.item_id = p_item AND s.field_id = p_field AND f.kind::text = 'secret';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM audit.record('secret.revealed', 'item', p_item::text,
                       jsonb_build_object('field_id', p_field));
  RETURN v_sealed;
END
$$;

-- ---------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------

ALTER TABLE app.item_secrets ENABLE ROW LEVEL SECURITY;

-- Which secrets exist follows the item, like any value. The sealed column
-- itself is not granted: knowing that a value exists is all a read gives.
CREATE POLICY item_secrets_select ON app.item_secrets FOR SELECT TO cerebro_app
  USING (EXISTS (
    SELECT 1 FROM app.items i
    JOIN app.list_fields f ON f.list_id = i.list_id
    WHERE i.id = item_secrets.item_id
      AND f.id = item_secrets.field_id
      AND NOT f.is_archived
  ));
CREATE POLICY item_secrets_insert ON app.item_secrets FOR INSERT TO cerebro_app
  WITH CHECK (authz.field_value_level(item_id, field_id) >= 'edit');
CREATE POLICY item_secrets_update ON app.item_secrets FOR UPDATE TO cerebro_app
  USING (authz.field_value_level(item_id, field_id) >= 'edit')
  WITH CHECK (authz.field_value_level(item_id, field_id) >= 'edit');
CREATE POLICY item_secrets_delete ON app.item_secrets FOR DELETE TO cerebro_app
  USING (authz.field_value_level(item_id, field_id) >= 'edit');

GRANT SELECT (item_id, field_id, updated_by, updated_at) ON app.item_secrets TO cerebro_app;
GRANT INSERT (item_id, field_id, sealed), UPDATE (sealed), DELETE ON app.item_secrets
  TO cerebro_app;

REVOKE EXECUTE ON FUNCTION
  app.field_value_problem_before_secret(app.field_kind, jsonb, jsonb, jsonb),
  app.field_value_problem(app.field_kind, jsonb, jsonb, jsonb),
  app.item_secrets_guard(),
  app.item_secrets_record_changes(),
  app.reveal_secret(uuid, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reveal_secret(uuid, uuid) TO cerebro_app;
