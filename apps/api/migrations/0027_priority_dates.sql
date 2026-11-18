-- =============================================================================
-- Priority, start and due date, native to every item.
--
-- Priority is a number from 1 (most urgent) to 4, or none. Dates are days, not
-- moments: "due on the 20th" means the same day to everyone, wherever they
-- read it. A start never comes after the due date. Whoever edits the item sets
-- them; the history records every change, by the database.
-- =============================================================================

ALTER TABLE app.items
  ADD COLUMN priority   smallint CHECK (priority BETWEEN 1 AND 4),
  ADD COLUMN start_date date,
  ADD COLUMN due_date   date,
  ADD CONSTRAINT items_dates_in_order
    CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date);

-- What is due soon is asked of every list, every time it opens.
CREATE INDEX items_due_idx ON app.items (list_id, due_date) WHERE deleted_at IS NULL;

GRANT UPDATE (priority, start_date, due_date) ON app.items TO cerebro_app;

-- ---------------------------------------------------------------------------
-- On the item's history
-- ---------------------------------------------------------------------------

ALTER TABLE app.item_changes DROP CONSTRAINT item_changes_what_check;
ALTER TABLE app.item_changes ADD CONSTRAINT item_changes_what_check CHECK (what IN (
  'created', 'title', 'description', 'list', 'stage', 'assigned', 'unassigned', 'field',
  'trashed', 'restored', 'attachment_added', 'attachment_removed', 'attachment_restored',
  'priority', 'start_date', 'due_date'));

CREATE OR REPLACE FUNCTION app.items_record_changes() RETURNS trigger
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
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    INSERT INTO app.item_changes (item_id, actor, what)
    VALUES (NEW.id, v_actor, CASE WHEN NEW.deleted_at IS NULL THEN 'restored' ELSE 'trashed' END);
  END IF;
  IF NEW.priority IS DISTINCT FROM OLD.priority THEN
    INSERT INTO app.item_changes (item_id, actor, what, old, new)
    VALUES (NEW.id, v_actor, 'priority', to_jsonb(OLD.priority), to_jsonb(NEW.priority));
  END IF;
  -- Days are written as text ("2026-11-20"), the way they are read back.
  IF NEW.start_date IS DISTINCT FROM OLD.start_date THEN
    INSERT INTO app.item_changes (item_id, actor, what, old, new)
    VALUES (NEW.id, v_actor, 'start_date',
            to_jsonb(OLD.start_date::text), to_jsonb(NEW.start_date::text));
  END IF;
  IF NEW.due_date IS DISTINCT FROM OLD.due_date THEN
    INSERT INTO app.item_changes (item_id, actor, what, old, new)
    VALUES (NEW.id, v_actor, 'due_date',
            to_jsonb(OLD.due_date::text), to_jsonb(NEW.due_date::text));
  END IF;
  RETURN NULL;
END
$$;
