-- =============================================================================
-- A checklist inside each item: short lines, each done or not. It follows the
-- item: whoever sees the item reads it, whoever edits the item changes it, and
-- nothing in it changes while the item is in the trash. Who ticked a line, and
-- when, is the database's to write. Every change goes into the item's history.
-- =============================================================================

CREATE TABLE app.item_checks (
  id         uuid PRIMARY KEY,
  item_id    uuid NOT NULL REFERENCES app.items (id) ON DELETE CASCADE,
  text       text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500 AND text = btrim(text)),
  position   double precision NOT NULL,
  done       boolean NOT NULL DEFAULT false,
  done_by    uuid REFERENCES app.users (id),
  done_at    timestamptz,
  created_by uuid NOT NULL REFERENCES app.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_checks_done_when CHECK (done = (done_at IS NOT NULL)),
  CONSTRAINT item_checks_done_by CHECK (done OR done_by IS NULL)
);
CREATE INDEX item_checks_item_idx ON app.item_checks (item_id, position);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON app.item_checks
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('created_by');

CREATE TRIGGER trash_guard BEFORE INSERT OR UPDATE OR DELETE ON app.item_checks
  FOR EACH ROW EXECUTE FUNCTION app.refuse_if_trashed();

-- A line stays on its item and keeps when it was written. Ticking is stamped
-- here: the moment and the person, never what the application says.
CREATE FUNCTION app.item_checks_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (SELECT count(*) FROM app.item_checks c WHERE c.item_id = NEW.item_id) >= 100 THEN
      RAISE EXCEPTION 'at most 100 lines in a checklist' USING ERRCODE = 'CB003';
    END IF;
    NEW.created_at := now();
    IF NEW.done THEN
      NEW.done_at := now();
      NEW.done_by := authz.uid();
    ELSE
      NEW.done_at := NULL;
      NEW.done_by := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.item_id <> OLD.item_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a checklist line stays on its item' USING ERRCODE = 'CB003';
  END IF;
  IF NEW.done IS DISTINCT FROM OLD.done THEN
    IF NEW.done THEN
      NEW.done_at := now();
      NEW.done_by := authz.uid();
    ELSE
      NEW.done_at := NULL;
      NEW.done_by := NULL;
    END IF;
  ELSE
    NEW.done_at := OLD.done_at;
    NEW.done_by := OLD.done_by;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.item_checks
  FOR EACH ROW EXECUTE FUNCTION app.item_checks_guard();

-- ---------------------------------------------------------------------------
-- On the item's history, with the text of the line as it was
-- ---------------------------------------------------------------------------

ALTER TABLE app.item_changes DROP CONSTRAINT item_changes_what_check;
ALTER TABLE app.item_changes ADD CONSTRAINT item_changes_what_check CHECK (what IN (
  'created', 'title', 'description', 'list', 'stage', 'assigned', 'unassigned', 'field',
  'trashed', 'restored', 'attachment_added', 'attachment_removed', 'attachment_restored',
  'priority', 'start_date', 'due_date', 'parent',
  'check_added', 'check_done', 'check_undone', 'check_renamed', 'check_removed'));

CREATE FUNCTION app.item_checks_record_changes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := authz.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.item_changes (item_id, actor, what, new)
    VALUES (NEW.item_id, v_actor, 'check_added', to_jsonb(NEW.text));
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.text <> OLD.text THEN
      INSERT INTO app.item_changes (item_id, actor, what, old, new)
      VALUES (NEW.item_id, v_actor, 'check_renamed', to_jsonb(OLD.text), to_jsonb(NEW.text));
    END IF;
    IF NEW.done <> OLD.done THEN
      INSERT INTO app.item_changes (item_id, actor, what, new)
      VALUES (NEW.item_id, v_actor, CASE WHEN NEW.done THEN 'check_done' ELSE 'check_undone' END,
              to_jsonb(NEW.text));
    END IF;
  -- When the item itself is being removed there is no history left to add to.
  ELSIF EXISTS (SELECT 1 FROM app.items i WHERE i.id = OLD.item_id) THEN
    INSERT INTO app.item_changes (item_id, actor, what, old)
    VALUES (OLD.item_id, v_actor, 'check_removed', to_jsonb(OLD.text));
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER record_changes AFTER INSERT OR UPDATE OR DELETE ON app.item_checks
  FOR EACH ROW EXECUTE FUNCTION app.item_checks_record_changes();

-- ---------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------

ALTER TABLE app.item_checks ENABLE ROW LEVEL SECURITY;

-- Read by whoever reads the item: its own policy decides, once per statement.
CREATE POLICY item_checks_select ON app.item_checks FOR SELECT TO cerebro_app
  USING (EXISTS (SELECT 1 FROM app.items i WHERE i.id = item_checks.item_id));
CREATE POLICY item_checks_insert ON app.item_checks FOR INSERT TO cerebro_app
  WITH CHECK (authz.item_level(item_id) >= 'edit');
CREATE POLICY item_checks_update ON app.item_checks FOR UPDATE TO cerebro_app
  USING (authz.item_level(item_id) >= 'edit')
  WITH CHECK (authz.item_level(item_id) >= 'edit');
CREATE POLICY item_checks_delete ON app.item_checks FOR DELETE TO cerebro_app
  USING (authz.item_level(item_id) >= 'edit');

GRANT SELECT ON app.item_checks TO cerebro_app;
GRANT INSERT (id, item_id, text, position, done), UPDATE (text, position, done), DELETE
  ON app.item_checks TO cerebro_app;

REVOKE EXECUTE ON FUNCTION
  app.item_checks_guard(),
  app.item_checks_record_changes()
FROM PUBLIC;
