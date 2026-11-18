-- =============================================================================
-- Who may put items into a stage. A stage may say that only people from a
-- given role up move items into it (only managers, only ADMs, only owners);
-- by default, anyone who edits the item may. Checked here, on every path:
-- moving an item, creating it straight into the stage, and a rule acting with
-- its author's access.
--
-- Landing in a list's first stage on its own (an item created without
-- choosing a stage, a repeating item coming back, an item moved to another
-- list without choosing a stage) is not choosing that stage, and is allowed.
-- =============================================================================

ALTER TABLE app.list_stages ADD COLUMN entry_role app.user_role
  CHECK (entry_role IS DISTINCT FROM 'employee');

GRANT INSERT (entry_role), UPDATE (entry_role) ON app.list_stages TO cerebro_app;

-- Named to run before stage_guard, which fills in the first stage when none
-- was chosen.
CREATE FUNCTION app.items_stage_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_needed app.user_role;
BEGIN
  IF session_user <> 'cerebro_app' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id THEN
    RETURN NEW;
  END IF;
  SELECT s.entry_role INTO v_needed FROM app.list_stages s WHERE s.id = NEW.stage_id;
  IF v_needed IS NOT NULL AND NOT coalesce(authz.my_role() >= v_needed, false) THEN
    RAISE EXCEPTION 'only % and above put items in this stage', v_needed USING ERRCODE = 'CB004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stage_entry BEFORE INSERT OR UPDATE OF stage_id ON app.items
  FOR EACH ROW EXECUTE FUNCTION app.items_stage_entry();

REVOKE EXECUTE ON FUNCTION app.items_stage_entry() FROM PUBLIC;
