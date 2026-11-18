-- =============================================================================
-- Recurring items. An item may repeat every N days, weeks, months or years.
-- When it reaches a stage that means done or closed, the database makes the
-- next one, on any path (list, board, several at once, the API): the same
-- title, description, priority, people, field values and checklist (lines
-- unticked), in the list's first stage, due one step after the last due date
-- (or after today, if it had none, and never in the past). The rule moves to
-- the new item, so finishing the old one again makes nothing more.
--
-- Whoever edits the item sets or removes the rule; nothing about it changes
-- while the item is in the trash.
-- =============================================================================

CREATE TABLE app.item_recurrences (
  item_id uuid PRIMARY KEY REFERENCES app.items (id) ON DELETE CASCADE,
  unit    text NOT NULL CHECK (unit IN ('day', 'week', 'month', 'year')),
  every   smallint NOT NULL CHECK (every BETWEEN 1 AND 99),
  set_by  uuid NOT NULL REFERENCES app.users (id),
  set_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON app.item_recurrences
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('set_by', 'restamp');
CREATE TRIGGER trash_guard BEFORE INSERT OR UPDATE OR DELETE ON app.item_recurrences
  FOR EACH ROW EXECUTE FUNCTION app.refuse_if_trashed();

CREATE FUNCTION app.item_recurrences_touch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.item_id <> OLD.item_id THEN
    RAISE EXCEPTION 'a rule stays on its item' USING ERRCODE = 'CB003';
  END IF;
  NEW.set_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER touch BEFORE INSERT OR UPDATE ON app.item_recurrences
  FOR EACH ROW EXECUTE FUNCTION app.item_recurrences_touch();

ALTER TABLE app.item_recurrences ENABLE ROW LEVEL SECURITY;
CREATE POLICY item_recurrences_select ON app.item_recurrences FOR SELECT TO cerebro_app
  USING (EXISTS (SELECT 1 FROM app.items i WHERE i.id = item_recurrences.item_id));
CREATE POLICY item_recurrences_insert ON app.item_recurrences FOR INSERT TO cerebro_app
  WITH CHECK (authz.item_level(item_id) >= 'edit');
CREATE POLICY item_recurrences_update ON app.item_recurrences FOR UPDATE TO cerebro_app
  USING (authz.item_level(item_id) >= 'edit')
  WITH CHECK (authz.item_level(item_id) >= 'edit');
CREATE POLICY item_recurrences_delete ON app.item_recurrences FOR DELETE TO cerebro_app
  USING (authz.item_level(item_id) >= 'edit');

GRANT SELECT ON app.item_recurrences TO cerebro_app;
GRANT INSERT (item_id, unit, every), UPDATE (unit, every), DELETE
  ON app.item_recurrences TO cerebro_app;

-- ---------------------------------------------------------------------------
-- On the item's history
-- ---------------------------------------------------------------------------

ALTER TABLE app.item_changes DROP CONSTRAINT item_changes_what_check;
ALTER TABLE app.item_changes ADD CONSTRAINT item_changes_what_check CHECK (what IN (
  'created', 'title', 'description', 'list', 'stage', 'assigned', 'unassigned', 'field',
  'trashed', 'restored', 'attachment_added', 'attachment_removed', 'attachment_restored',
  'priority', 'start_date', 'due_date', 'parent',
  'check_added', 'check_done', 'check_undone', 'check_renamed', 'check_removed',
  'recurrence', 'repeated'));

CREATE FUNCTION app.item_recurrences_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_item uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.item_id ELSE NEW.item_id END;
BEGIN
  -- Nothing to add to when the item itself is being removed, or when the rule
  -- only moves on to the next item (that is written as "repeated" there).
  IF NOT EXISTS (SELECT 1 FROM app.items i WHERE i.id = v_item)
     OR current_setting('cerebro.repeating', true) = 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.item_changes (item_id, actor, what, old, new)
  VALUES (
    v_item, authz.uid(), 'recurrence',
    CASE WHEN TG_OP = 'INSERT' THEN NULL
         ELSE jsonb_build_object('unit', OLD.unit, 'every', OLD.every) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL
         ELSE jsonb_build_object('unit', NEW.unit, 'every', NEW.every) END
  );
  RETURN NULL;
END
$$;
CREATE TRIGGER record_changes AFTER INSERT OR UPDATE OR DELETE ON app.item_recurrences
  FOR EACH ROW EXECUTE FUNCTION app.item_recurrences_record();

-- ---------------------------------------------------------------------------
-- The next one
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.items_repeat() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rule   app.item_recurrences;
  v_step   interval;
  v_base   date;
  v_n      integer := 1;
  v_next   date;
  v_start  date;
  v_new    uuid := gen_random_uuid();
  v_actor  uuid := authz.uid();
  v_parent uuid;
  v_value  record;
BEGIN
  -- Only on reaching a finished stage from an open one, in the same list.
  IF NEW.deleted_at IS NOT NULL OR NEW.list_id <> OLD.list_id
     OR NOT EXISTS (SELECT 1 FROM app.list_stages s
                    WHERE s.id = NEW.stage_id AND s.kind IN ('done', 'closed'))
     OR EXISTS (SELECT 1 FROM app.list_stages s
                WHERE s.id = OLD.stage_id AND s.kind IN ('done', 'closed')) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_rule FROM app.item_recurrences r WHERE r.item_id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_step := CASE v_rule.unit
    WHEN 'day'   THEN make_interval(days => v_rule.every)
    WHEN 'week'  THEN make_interval(weeks => v_rule.every)
    WHEN 'month' THEN make_interval(months => v_rule.every)
    ELSE              make_interval(years => v_rule.every)
  END;
  -- Steps are counted from the last due date; finished late, whole steps are
  -- added until the next date is today or later.
  v_base := coalesce(NEW.due_date, current_date);
  v_next := (v_base + v_step)::date;
  WHILE v_next < current_date AND v_n < 1000 LOOP
    v_n := v_n + 1;
    v_next := (v_base + v_step * v_n)::date;
  END LOOP;
  IF NEW.start_date IS NOT NULL THEN
    v_start := least((NEW.start_date + v_step * v_n)::date, v_next);
  END IF;
  -- Under the same parent only while whoever finished it may still hang work there.
  IF NEW.parent_id IS NOT NULL AND app.parent_usable(NEW.parent_id, NEW.list_id)
     AND (session_user <> 'cerebro_app' OR authz.item_level(NEW.parent_id) >= 'edit') THEN
    v_parent := NEW.parent_id;
  END IF;

  PERFORM set_config('cerebro.repeating', 'on', true);
  INSERT INTO app.items (id, list_id, title, description, created_by, priority, start_date,
                         due_date, parent_id)
  VALUES (v_new, NEW.list_id, NEW.title, NEW.description, coalesce(v_actor, NEW.created_by),
          NEW.priority, v_start, v_next, v_parent);

  INSERT INTO app.item_assignees (item_id, user_id, assigned_by)
  SELECT v_new, ia.user_id, coalesce(v_actor, NEW.created_by)
  FROM app.item_assignees ia
  WHERE ia.item_id = NEW.id AND authz.list_level_of(ia.user_id, NEW.list_id) >= 'edit'
  ON CONFLICT DO NOTHING;

  -- A value that no longer fits (an option removed, a person gone) stays behind.
  FOR v_value IN
    SELECT fv.field_id, fv.value FROM app.item_field_values fv
    JOIN app.list_fields f ON f.id = fv.field_id
    WHERE fv.item_id = NEW.id AND f.list_id = NEW.list_id AND NOT f.is_archived
      AND f.kind <> 'files'
  LOOP
    BEGIN
      INSERT INTO app.item_field_values (item_id, field_id, value)
      VALUES (v_new, v_value.field_id, v_value.value);
    EXCEPTION WHEN SQLSTATE 'CB003' OR SQLSTATE '23514' THEN
      NULL;
    END;
  END LOOP;

  INSERT INTO app.item_checks (id, item_id, text, position, created_by)
  SELECT gen_random_uuid(), v_new, c.text, c.position, coalesce(v_actor, c.created_by)
  FROM app.item_checks c WHERE c.item_id = NEW.id;

  -- The rule moves on.
  DELETE FROM app.item_recurrences r WHERE r.item_id = NEW.id;
  INSERT INTO app.item_recurrences (item_id, unit, every, set_by)
  VALUES (v_new, v_rule.unit, v_rule.every, coalesce(v_actor, v_rule.set_by));
  INSERT INTO app.item_changes (item_id, actor, what, new)
  VALUES (v_new, v_actor, 'repeated', to_jsonb(NEW.id));
  PERFORM set_config('cerebro.repeating', 'off', true);
  RETURN NULL;
END
$$;
CREATE TRIGGER repeat AFTER UPDATE OF stage_id ON app.items
  FOR EACH ROW WHEN (NEW.stage_id IS DISTINCT FROM OLD.stage_id)
  EXECUTE FUNCTION app.items_repeat();

REVOKE EXECUTE ON FUNCTION
  app.item_recurrences_touch(),
  app.item_recurrences_record(),
  app.items_repeat()
FROM PUBLIC;
