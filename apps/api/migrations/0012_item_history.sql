-- =============================================================================
-- What happened to an item: who created it, renamed it, moved it, handed it to
-- someone, filled in or cleared a field. Written by the database on every
-- path, so no endpoint can forget it and nobody can edit it afterwards.
-- =============================================================================

CREATE TABLE app.item_changes (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id  uuid NOT NULL REFERENCES app.items (id) ON DELETE CASCADE,
  at       timestamptz NOT NULL DEFAULT now(),
  -- NULL when the change was not made by a signed-in person (an import, for one).
  actor    uuid REFERENCES app.users (id),
  what     text NOT NULL CHECK (what IN (
             'created', 'title', 'description', 'list', 'stage',
             'assigned', 'unassigned', 'field')),
  field_id uuid REFERENCES app.list_fields (id),
  old      jsonb,
  new      jsonb,
  CHECK ((what = 'field') = (field_id IS NOT NULL))
);
CREATE INDEX item_changes_item_idx ON app.item_changes (item_id, id DESC);

-- Items that already exist start their history at their creation.
INSERT INTO app.item_changes (item_id, at, actor, what, new)
SELECT i.id, i.created_at, i.created_by, 'created', jsonb_build_object('title', i.title)
FROM app.items i;

-- ---------------------------------------------------------------------------
-- Written by triggers, and by nothing else
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.items_record_changes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := authz.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.item_changes (item_id, actor, what, new)
    VALUES (NEW.id, v_actor, 'created', jsonb_build_object('title', NEW.title));
    RETURN NULL;
  END IF;

  IF NEW.title <> OLD.title THEN
    INSERT INTO app.item_changes (item_id, actor, what, old, new)
    VALUES (NEW.id, v_actor, 'title', to_jsonb(OLD.title), to_jsonb(NEW.title));
  END IF;
  IF NEW.description <> OLD.description THEN
    INSERT INTO app.item_changes (item_id, actor, what, old, new)
    VALUES (NEW.id, v_actor, 'description', to_jsonb(OLD.description), to_jsonb(NEW.description));
  END IF;
  IF NEW.list_id <> OLD.list_id THEN
    INSERT INTO app.item_changes (item_id, actor, what, old, new)
    VALUES (NEW.id, v_actor, 'list', to_jsonb(OLD.list_id), to_jsonb(NEW.list_id));
  END IF;
  IF NEW.stage_id <> OLD.stage_id THEN
    -- Names are copied, so the line still reads right after a stage is renamed or removed.
    INSERT INTO app.item_changes (item_id, actor, what, old, new)
    SELECT NEW.id, v_actor, 'stage',
           (SELECT jsonb_build_object('id', s.id, 'name', s.name)
            FROM app.list_stages s WHERE s.id = OLD.stage_id),
           (SELECT jsonb_build_object('id', s.id, 'name', s.name)
            FROM app.list_stages s WHERE s.id = NEW.stage_id);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER record_changes AFTER INSERT OR UPDATE ON app.items
  FOR EACH ROW EXECUTE FUNCTION app.items_record_changes();

CREATE FUNCTION app.item_assignees_record_changes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.item_changes (item_id, actor, what, new)
    VALUES (NEW.item_id, authz.uid(), 'assigned', to_jsonb(NEW.user_id));
  -- When the item itself is being removed there is no history left to add to.
  ELSIF EXISTS (SELECT 1 FROM app.items i WHERE i.id = OLD.item_id) THEN
    INSERT INTO app.item_changes (item_id, actor, what, old)
    VALUES (OLD.item_id, authz.uid(), 'unassigned', to_jsonb(OLD.user_id));
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER record_changes AFTER INSERT OR DELETE ON app.item_assignees
  FOR EACH ROW EXECUTE FUNCTION app.item_assignees_record_changes();

CREATE FUNCTION app.item_field_values_record_changes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.item_changes (item_id, actor, what, field_id, new)
    VALUES (NEW.item_id, authz.uid(), 'field', NEW.field_id, NEW.value);
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.value <> OLD.value THEN
      INSERT INTO app.item_changes (item_id, actor, what, field_id, old, new)
      VALUES (NEW.item_id, authz.uid(), 'field', NEW.field_id, OLD.value, NEW.value);
    END IF;
  ELSIF EXISTS (SELECT 1 FROM app.items i WHERE i.id = OLD.item_id) THEN
    INSERT INTO app.item_changes (item_id, actor, what, field_id, old)
    VALUES (OLD.item_id, authz.uid(), 'field', OLD.field_id, OLD.value);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER record_changes AFTER INSERT OR UPDATE OR DELETE ON app.item_field_values
  FOR EACH ROW EXECUTE FUNCTION app.item_field_values_record_changes();

-- History is never edited. It only goes away together with its item, when the
-- item itself is removed for good.
CREATE FUNCTION app.item_changes_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM app.items i WHERE i.id = OLD.item_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'the history of an item is append-only' USING ERRCODE = 'CB001';
END
$$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON app.item_changes
  FOR EACH ROW EXECUTE FUNCTION app.item_changes_guard();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON app.item_changes
  FOR EACH STATEMENT EXECUTE FUNCTION app.item_changes_guard();

-- ---------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------

ALTER TABLE app.item_changes ENABLE ROW LEVEL SECURITY;

-- Read by whoever reads the item. What was once in a field is read only while
-- the field itself still is: archived, or left behind in another list, its
-- past values are as out of reach as its present one.
CREATE POLICY item_changes_select ON app.item_changes FOR SELECT TO cerebro_app
  USING (
    EXISTS (SELECT 1 FROM app.items i WHERE i.id = item_changes.item_id)
    AND (
      field_id IS NULL
      OR EXISTS (
        SELECT 1 FROM app.items i
        JOIN app.list_fields f ON f.list_id = i.list_id
        WHERE i.id = item_changes.item_id
          AND f.id = item_changes.field_id
          AND NOT f.is_archived
      )
    )
  );

-- Reading only: every line is written by the triggers above.
GRANT SELECT ON app.item_changes TO cerebro_app;

REVOKE EXECUTE ON FUNCTION
  app.items_record_changes(),
  app.item_assignees_record_changes(),
  app.item_field_values_record_changes(),
  app.item_changes_guard()
FROM PUBLIC;
