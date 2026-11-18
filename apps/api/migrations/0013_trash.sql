-- =============================================================================
-- The trash. An item sent to the trash leaves every list and every count, can
-- be brought back for thirty days, and is then removed for good together with
-- everything that hung from it. Nothing else removes an item.
-- =============================================================================

ALTER TABLE app.items
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES app.users (id),
  ADD CONSTRAINT items_trash_check CHECK (deleted_at IS NOT NULL OR deleted_by IS NULL);
CREATE INDEX items_trash_idx ON app.items (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX items_live_idx ON app.items (list_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Going in and coming out
-- ---------------------------------------------------------------------------

-- The moment and the person are the database's to write. While an item is in
-- the trash nothing about it changes, except the stage it is filed under when
-- that stage is removed from the list.
CREATE FUNCTION app.items_trash_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_other_changes boolean := (NEW.title, NEW.description, NEW.list_id)
                             IS DISTINCT FROM (OLD.title, OLD.description, OLD.list_id);
BEGIN
  IF NEW.deleted_at IS NULL AND OLD.deleted_at IS NULL THEN
    IF NEW.deleted_by IS NOT NULL THEN
      RAISE EXCEPTION 'only the trash says who sent an item there' USING ERRCODE = 'CB003';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL THEN
    IF v_other_changes OR NEW.deleted_at <> OLD.deleted_at
       OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
      RAISE EXCEPTION 'an item in the trash does not change' USING ERRCODE = 'CB003';
    END IF;
    RETURN NEW;
  END IF;

  -- Sending to the trash, or bringing back: that, and nothing else, in one change.
  IF v_other_changes OR NEW.stage_id <> OLD.stage_id THEN
    RAISE EXCEPTION 'an item goes to the trash or comes back as it is' USING ERRCODE = 'CB003';
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    IF session_user = 'cerebro_app' THEN
      -- Never in the past (that would shorten the thirty days) or in the future.
      NEW.deleted_at := now();
    END IF;
    NEW.deleted_by := authz.uid();
  ELSE
    NEW.deleted_by := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trash_guard BEFORE UPDATE ON app.items
  FOR EACH ROW EXECUTE FUNCTION app.items_trash_guard();

-- What hangs from an item in the trash stays as it was: no one is handed a
-- thrown-away item, and its fields are not filled in.
CREATE FUNCTION app.refuse_if_trashed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.items i
    WHERE i.id IN (
      CASE WHEN TG_OP = 'DELETE' THEN OLD.item_id ELSE NEW.item_id END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.item_id END
    )
    AND i.deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'the item is in the trash' USING ERRCODE = 'CB003';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER trash_guard BEFORE INSERT OR UPDATE OR DELETE ON app.item_assignees
  FOR EACH ROW EXECUTE FUNCTION app.refuse_if_trashed();
CREATE TRIGGER trash_guard BEFORE INSERT OR UPDATE OR DELETE ON app.item_field_values
  FOR EACH ROW EXECUTE FUNCTION app.refuse_if_trashed();

-- ---------------------------------------------------------------------------
-- On the item's history
-- ---------------------------------------------------------------------------

ALTER TABLE app.item_changes DROP CONSTRAINT item_changes_what_check;
ALTER TABLE app.item_changes ADD CONSTRAINT item_changes_what_check CHECK (what IN (
  'created', 'title', 'description', 'list', 'stage',
  'assigned', 'unassigned', 'field', 'trashed', 'restored'));

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
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- Removed for good after thirty days
-- ---------------------------------------------------------------------------

-- The only way an item ever leaves the database. The thirty days are written
-- here and nowhere else, so the application can run this as often as it likes
-- and still never remove anything sooner.
CREATE FUNCTION app.purge_trash() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_count integer;
BEGIN
  WITH gone AS (
    DELETE FROM app.items WHERE deleted_at < now() - interval '30 days' RETURNING id
  )
  SELECT count(*) INTO v_count FROM gone;
  IF v_count > 0 THEN
    PERFORM audit.record_as(NULL, NULL, 'items.purged', NULL, NULL,
                            jsonb_build_object('count', v_count));
  END IF;
  RETURN v_count;
END
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- Whoever may edit an item may send it to the trash and bring it back, through
-- the same row-level rules as any other change to it. Who sent it is never
-- the application's to write.
GRANT UPDATE (deleted_at) ON app.items TO cerebro_app;

REVOKE EXECUTE ON FUNCTION
  app.items_trash_guard(),
  app.refuse_if_trashed(),
  app.purge_trash()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_trash() TO cerebro_app;
