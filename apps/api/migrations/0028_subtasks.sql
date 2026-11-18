-- =============================================================================
-- Subtasks. A subtask is an item like any other, with a parent: an item of the
-- same list that is not itself a subtask (one level). Who sees and edits a
-- subtask follows the rules of any item, not its parent's: inheriting would
-- show one employee the work of another.
--
-- Families stay whole. A live subtask sits in its parent's list, and its
-- parent is live too. Moving or trashing a parent takes its live subtasks
-- along, in the same change; the database checks the family at the end of the
-- transaction, so a change that leaves one behind does not happen.
-- =============================================================================

ALTER TABLE app.items
  ADD COLUMN parent_id uuid REFERENCES app.items (id) ON DELETE CASCADE,
  ADD CONSTRAINT items_not_own_parent CHECK (parent_id <> id);
CREATE INDEX items_parent_idx ON app.items (parent_id) WHERE parent_id IS NOT NULL;

GRANT INSERT (parent_id), UPDATE (parent_id) ON app.items TO cerebro_app;

-- ---------------------------------------------------------------------------
-- Whose item a subtask may hang from
-- ---------------------------------------------------------------------------

-- Hanging work under an item is changing that item: only whoever may edit it.
CREATE FUNCTION app.items_parent_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF session_user <> 'cerebro_app' OR NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN
    RETURN NEW;
  END IF;
  IF authz.item_level(NEW.parent_id) < 'edit' THEN
    RAISE EXCEPTION 'a subtask hangs only from an item its author may edit' USING ERRCODE = 'CB001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER parent_guard BEFORE INSERT OR UPDATE OF parent_id ON app.items
  FOR EACH ROW EXECUTE FUNCTION app.items_parent_guard();

-- ---------------------------------------------------------------------------
-- Families stay whole, checked when the transaction ends
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.items_family_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_item app.items;
  v_parent app.items;
BEGIN
  -- The row as it is now, at the end of the transaction, not as it was then.
  SELECT * INTO v_item FROM app.items WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_item.parent_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM app.items WHERE id = v_item.parent_id;
    IF v_parent.parent_id IS NOT NULL THEN
      RAISE EXCEPTION 'a subtask cannot have subtasks' USING ERRCODE = 'CB003';
    END IF;
    IF v_item.deleted_at IS NULL
       AND (v_parent.deleted_at IS NOT NULL OR v_parent.list_id <> v_item.list_id) THEN
      RAISE EXCEPTION 'a live subtask sits in its parent''s list, under a live parent'
        USING ERRCODE = 'CB003';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM app.items c WHERE c.parent_id = v_item.id) THEN
    IF v_item.parent_id IS NOT NULL THEN
      RAISE EXCEPTION 'a subtask cannot have subtasks' USING ERRCODE = 'CB003';
    END IF;
    IF EXISTS (
      SELECT 1 FROM app.items c
      WHERE c.parent_id = v_item.id AND c.deleted_at IS NULL
        AND (v_item.deleted_at IS NOT NULL OR c.list_id <> v_item.list_id)
    ) THEN
      RAISE EXCEPTION 'an item does not leave its live subtasks behind' USING ERRCODE = 'CB003';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER family_check
  AFTER INSERT OR UPDATE OF parent_id, list_id, deleted_at ON app.items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.items_family_check();

-- Whether an item can hold a subtask of the given list right now. Says no more
-- than yes or no, about an item the caller already names.
CREATE FUNCTION app.parent_usable(p_parent uuid, p_list uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.items p
    WHERE p.id = p_parent AND p.list_id = p_list AND p.deleted_at IS NULL AND p.parent_id IS NULL
  )
$$;

-- ---------------------------------------------------------------------------
-- An item in the trash does not change, its parent included
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.items_trash_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_other_changes boolean :=
    (NEW.title, NEW.description, NEW.list_id, NEW.parent_id,
     NEW.priority, NEW.start_date, NEW.due_date)
    IS DISTINCT FROM
    (OLD.title, OLD.description, OLD.list_id, OLD.parent_id,
     OLD.priority, OLD.start_date, OLD.due_date);
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

-- ---------------------------------------------------------------------------
-- On the item's history: which item it hangs from, by id only (the parent's
-- title is not copied: whoever reads the subtask may not see the parent)
-- ---------------------------------------------------------------------------

ALTER TABLE app.item_changes DROP CONSTRAINT item_changes_what_check;
ALTER TABLE app.item_changes ADD CONSTRAINT item_changes_what_check CHECK (what IN (
  'created', 'title', 'description', 'list', 'stage', 'assigned', 'unassigned', 'field',
  'trashed', 'restored', 'attachment_added', 'attachment_removed', 'attachment_restored',
  'priority', 'start_date', 'due_date', 'parent'));

CREATE FUNCTION app.items_record_parent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.parent_id IS NOT NULL THEN
      INSERT INTO app.item_changes (item_id, actor, what, new)
      VALUES (NEW.id, authz.uid(), 'parent', to_jsonb(NEW.parent_id));
    END IF;
  ELSIF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    INSERT INTO app.item_changes (item_id, actor, what, old, new)
    VALUES (NEW.id, authz.uid(), 'parent', to_jsonb(OLD.parent_id), to_jsonb(NEW.parent_id));
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER record_parent AFTER INSERT OR UPDATE OF parent_id ON app.items
  FOR EACH ROW EXECUTE FUNCTION app.items_record_parent();

REVOKE EXECUTE ON FUNCTION
  app.items_parent_guard(),
  app.items_family_check(),
  app.items_record_parent(),
  app.parent_usable(uuid, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.parent_usable(uuid, uuid) TO cerebro_app;
