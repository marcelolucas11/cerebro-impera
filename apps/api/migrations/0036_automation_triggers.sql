-- =============================================================================
-- Automations, second step: more ways to start a rule and more for it to do.
--
-- When: a field changes (to any value, or to one option or tick), or someone
-- is handed the item (anyone, or one person). Then: fill in or clear a field,
-- set the due date some days from today (or clear it), or add a subtask.
--
-- Everything from 0035 holds: the rule acts with its author's access and no
-- more, never blocks the person, is marked as the rule's, and stops three
-- levels down. A change made while the item is being created is part of the
-- creation: it starts "created" rules, not these.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- What a rule may say
-- ---------------------------------------------------------------------------

-- A field a rule may look at: in the list and in use.
CREATE FUNCTION app.automation_field(p_list uuid, p_field text)
RETURNS TABLE (kind app.field_kind, config jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT f.kind, f.config FROM app.list_fields f
  WHERE f.list_id = p_list AND f.id::text = p_field AND NOT f.is_archived
$$;

-- Whether a value names one option of a choice field, or a tick of a checkbox.
CREATE FUNCTION app.automation_choice(p_kind app.field_kind, p_config jsonb, p_value jsonb)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE p_kind
    WHEN 'select' THEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_config -> 'options') o
      WHERE o ->> 'id' = p_value #>> '{}')
    WHEN 'checkbox' THEN jsonb_typeof(p_value) = 'boolean'
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION app.automation_problem(
  p_list uuid, p_trigger jsonb, p_conditions jsonb, p_actions jsonb
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_item   jsonb;
  v_stage  text;
  v_person jsonb;
  v_field  record;
BEGIN
  IF (SELECT l.is_sensitive FROM app.lists l WHERE l.id = p_list) THEN
    RETURN 'sensitive_list';
  END IF;

  -- When
  IF jsonb_typeof(p_trigger) IS DISTINCT FROM 'object' THEN RETURN 'bad_trigger'; END IF;
  CASE p_trigger ->> 'on'
    WHEN 'created' THEN
      IF p_trigger <> '{"on": "created"}'::jsonb THEN RETURN 'bad_trigger'; END IF;
    WHEN 'stage' THEN
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_trigger) k WHERE k NOT IN ('on', 'to', 'from')) THEN
        RETURN 'bad_trigger';
      END IF;
      FOREACH v_stage IN ARRAY ARRAY[p_trigger ->> 'to', p_trigger ->> 'from'] LOOP
        IF v_stage IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM app.list_stages s WHERE s.list_id = p_list AND s.id::text = v_stage
        ) THEN
          RETURN 'unknown_stage';
        END IF;
      END LOOP;
    WHEN 'field' THEN
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_trigger) k WHERE k NOT IN ('on', 'field', 'is')) THEN
        RETURN 'bad_trigger';
      END IF;
      SELECT * INTO v_field FROM app.automation_field(p_list, p_trigger ->> 'field');
      IF NOT FOUND
         OR (p_trigger ? 'is' AND NOT app.automation_choice(v_field.kind, v_field.config, p_trigger -> 'is')) THEN
        RETURN 'unknown_field';
      END IF;
    WHEN 'assigned' THEN
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_trigger) k WHERE k NOT IN ('on', 'to')) THEN
        RETURN 'bad_trigger';
      END IF;
      IF p_trigger ? 'to' AND NOT EXISTS (
        SELECT 1 FROM app.users u WHERE u.id::text = p_trigger ->> 'to'
      ) THEN
        RETURN 'unknown_person';
      END IF;
    ELSE
      RETURN 'bad_trigger';
  END CASE;

  -- If
  IF jsonb_typeof(p_conditions) IS DISTINCT FROM 'array' OR jsonb_array_length(p_conditions) > 10 THEN
    RETURN 'bad_conditions';
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_conditions) LOOP
    CASE v_item ->> 'if'
      WHEN 'stage' THEN
        IF NOT EXISTS (SELECT 1 FROM app.list_stages s
                       WHERE s.list_id = p_list AND s.id::text = v_item ->> 'is') THEN
          RETURN 'unknown_stage';
        END IF;
      WHEN 'priority' THEN
        IF NOT coalesce(v_item -> 'is' IN ('null', '1', '2', '3', '4'), false) THEN
          RETURN 'bad_conditions';
        END IF;
      WHEN 'assignee' THEN
        IF NOT coalesce(v_item -> 'is' = 'null'::jsonb
                        OR EXISTS (SELECT 1 FROM app.users u WHERE u.id::text = v_item ->> 'is'),
                        false) THEN
          RETURN 'unknown_person';
        END IF;
      WHEN 'field' THEN
        SELECT * INTO v_field FROM app.automation_field(p_list, v_item ->> 'field');
        IF NOT FOUND OR NOT app.automation_choice(v_field.kind, v_field.config, v_item -> 'is') THEN
          RETURN 'unknown_field';
        END IF;
      ELSE
        RETURN 'bad_conditions';
    END CASE;
  END LOOP;

  -- Then
  IF jsonb_typeof(p_actions) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_actions) NOT BETWEEN 1 AND 5 THEN
    RETURN 'bad_actions';
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_actions) LOOP
    CASE v_item ->> 'do'
      WHEN 'stage' THEN
        IF NOT EXISTS (SELECT 1 FROM app.list_stages s
                       WHERE s.list_id = p_list AND s.id::text = v_item ->> 'to') THEN
          RETURN 'unknown_stage';
        END IF;
      WHEN 'priority' THEN
        IF NOT coalesce(v_item -> 'to' IN ('null', '1', '2', '3', '4'), false) THEN
          RETURN 'bad_actions';
        END IF;
      WHEN 'assign' THEN
        -- Only someone who can work in the list.
        IF coalesce(authz.list_level_of((v_item ->> 'to')::uuid, p_list), 'none') < 'edit' THEN
          RETURN 'cannot_assign_person';
        END IF;
      WHEN 'notify' THEN
        IF jsonb_typeof(v_item -> 'to') IS DISTINCT FROM 'array'
           OR jsonb_array_length(v_item -> 'to') NOT BETWEEN 1 AND 10 THEN
          RETURN 'bad_actions';
        END IF;
        FOR v_person IN SELECT * FROM jsonb_array_elements(v_item -> 'to') LOOP
          IF coalesce(authz.list_level_of((v_person #>> '{}')::uuid, p_list), 'none') < 'view' THEN
            RETURN 'cannot_notify_person';
          END IF;
        END LOOP;
      WHEN 'comment' THEN
        IF jsonb_typeof(v_item -> 'text') IS DISTINCT FROM 'string'
           OR char_length(btrim(v_item ->> 'text')) NOT BETWEEN 1 AND 2000 THEN
          RETURN 'bad_actions';
        END IF;
      WHEN 'field' THEN
        -- Secrets are written only by a person who typed them; files come from
        -- the item's own attachments.
        SELECT * INTO v_field FROM app.automation_field(p_list, v_item ->> 'field');
        IF NOT FOUND OR v_field.kind IN ('secret', 'files') OR NOT v_item ? 'value' THEN
          RETURN 'unknown_field';
        END IF;
        IF v_item -> 'value' <> 'null'::jsonb
           AND (app.field_value_problem(v_field.kind, v_field.config, v_item -> 'value', NULL) IS NOT NULL
                -- An unticked box is stored as no value.
                OR v_item -> 'value' = 'false'::jsonb) THEN
          RETURN 'invalid_value';
        END IF;
      WHEN 'due' THEN
        IF NOT coalesce(v_item -> 'in' = 'null'::jsonb
                        OR (jsonb_typeof(v_item -> 'in') = 'number'
                            AND (v_item ->> 'in') ~ '^[0-9]{1,3}$'
                            AND (v_item ->> 'in')::integer <= 365),
                        false) THEN
          RETURN 'bad_actions';
        END IF;
      WHEN 'subtask' THEN
        IF jsonb_typeof(v_item -> 'title') IS DISTINCT FROM 'string'
           OR char_length(btrim(v_item ->> 'title')) NOT BETWEEN 1 AND 200 THEN
          RETURN 'bad_actions';
        END IF;
      ELSE
        RETURN 'bad_actions';
    END CASE;
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN invalid_text_representation THEN
  -- A person named by something that is not an id.
  RETURN 'unknown_person';
END
$$;

-- ---------------------------------------------------------------------------
-- What a rule does
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.automation_act(p_action jsonb, p_item uuid, p_origin uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_person uuid;
  v_parent uuid;
  v_list   uuid;
BEGIN
  CASE p_action ->> 'do'
    WHEN 'stage' THEN
      UPDATE app.items SET stage_id = (p_action ->> 'to')::uuid WHERE id = p_item;
    WHEN 'priority' THEN
      UPDATE app.items SET priority = (p_action ->> 'to')::smallint WHERE id = p_item;
    WHEN 'assign' THEN
      -- Handing out work is for who sees the whole list, as for a person.
      IF NOT authz.can_assign(p_item) THEN
        RAISE EXCEPTION 'the author does not hand out work here' USING ERRCODE = 'CB001';
      END IF;
      INSERT INTO app.item_assignees (item_id, user_id, assigned_by)
      VALUES (p_item, (p_action ->> 'to')::uuid, authz.uid())
      ON CONFLICT DO NOTHING;
    WHEN 'notify' THEN
      FOR v_person IN SELECT (e #>> '{}')::uuid FROM jsonb_array_elements(p_action -> 'to') e LOOP
        -- Not whoever set this off, and only someone who sees the item.
        IF v_person IS DISTINCT FROM p_origin AND authz.item_visible_to(v_person, p_item) THEN
          INSERT INTO app.notifications (user_id, kind, item_id, actor)
          VALUES (v_person, 'automation', p_item, authz.uid());
        END IF;
      END LOOP;
    WHEN 'comment' THEN
      INSERT INTO app.item_comments (id, item_id, author_id, body)
      VALUES (gen_random_uuid(), p_item, authz.uid(), btrim(p_action ->> 'text'));
    WHEN 'field' THEN
      -- The value is checked again by the table, against the field as it is now.
      IF p_action -> 'value' = 'null'::jsonb THEN
        DELETE FROM app.item_field_values
        WHERE item_id = p_item AND field_id = (p_action ->> 'field')::uuid;
      ELSE
        INSERT INTO app.item_field_values (item_id, field_id, value, updated_by)
        VALUES (p_item, (p_action ->> 'field')::uuid, p_action -> 'value', authz.uid())
        ON CONFLICT (item_id, field_id) DO UPDATE SET value = EXCLUDED.value;
      END IF;
    WHEN 'due' THEN
      UPDATE app.items
      SET due_date = current_date + (p_action ->> 'in')::integer
      WHERE id = p_item AND due_date IS DISTINCT FROM current_date + (p_action ->> 'in')::integer;
    WHEN 'subtask' THEN
      SELECT i.parent_id, i.list_id INTO v_parent, v_list FROM app.items i WHERE i.id = p_item;
      IF v_parent IS NOT NULL THEN
        RAISE EXCEPTION 'a subtask has no subtasks' USING ERRCODE = 'CB003';
      END IF;
      INSERT INTO app.items (id, list_id, title, created_by, parent_id)
      VALUES (gen_random_uuid(), v_list, btrim(p_action ->> 'title'), authz.uid(), p_item);
  END CASE;
END
$$;

-- ---------------------------------------------------------------------------
-- The engine, now told what happened
-- ---------------------------------------------------------------------------

DROP TRIGGER automations_created ON app.items;
DROP TRIGGER run_automations ON app.items;
DROP FUNCTION app.items_automations();
DROP FUNCTION app.automations_fire(text, uuid, uuid, uuid);

-- p_event: for a stage, its "from" and "to"; for a field, its "field" and new
-- "value" (null when cleared); for an assignment, the "person".
CREATE FUNCTION app.automations_fire(p_on text, p_item uuid, p_event jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ctx    authz.request_ctx;
  v_list   uuid;
  v_rule   app.automations;
  v_item   app.items;
  v_action jsonb;
BEGIN
  -- Only on behalf of someone signed in: imports and maintenance run no rules.
  SELECT * INTO v_ctx FROM authz.request_ctx c
  WHERE c.pid = pg_backend_pid() AND c.xact_start = transaction_timestamp();
  IF NOT FOUND OR v_ctx.automation_depth >= 3 THEN
    RETURN;
  END IF;
  SELECT i.list_id INTO v_list FROM app.items i WHERE i.id = p_item;

  FOR v_rule IN
    SELECT * FROM app.automations a
    WHERE a.list_id = v_list AND a.enabled AND a.trigger ->> 'on' = p_on
      AND CASE p_on
        WHEN 'stage' THEN
          (NOT a.trigger ? 'to' OR a.trigger ->> 'to' = p_event ->> 'to')
          AND (NOT a.trigger ? 'from' OR a.trigger ->> 'from' = p_event ->> 'from')
        WHEN 'field' THEN
          a.trigger ->> 'field' = p_event ->> 'field'
          AND (NOT a.trigger ? 'is'
               OR a.trigger -> 'is' = p_event -> 'value'
               -- Unticked and cleared are the same.
               OR (a.trigger -> 'is' = 'false'::jsonb
                   AND coalesce(p_event -> 'value', 'null'::jsonb) = 'null'::jsonb))
        WHEN 'assigned' THEN
          NOT a.trigger ? 'to' OR a.trigger ->> 'to' = p_event ->> 'person'
        ELSE true
      END
    ORDER BY a.created_at, a.id
  LOOP
    -- In the trash, or moved away by an earlier rule: nothing more to do.
    SELECT * INTO v_item FROM app.items i WHERE i.id = p_item;
    EXIT WHEN v_item.list_id IS DISTINCT FROM v_list OR v_item.deleted_at IS NOT NULL;
    BEGIN
      -- From here until the rule ends, the acting person is its author.
      UPDATE authz.request_ctx
      SET user_id = v_rule.run_as, step_up = false,
          automation_id = v_rule.id, automation_depth = v_ctx.automation_depth + 1
      WHERE pid = pg_backend_pid();
      -- A suspended author sees nothing, so this covers that too.
      IF authz.item_level(p_item) < 'edit' THEN
        INSERT INTO app.automation_runs (automation_id, item_id, outcome, detail)
        VALUES (v_rule.id, p_item, 'skipped', 'no_access');
      ELSIF app.automation_holds(v_rule.conditions, v_item) THEN
        FOR v_action IN SELECT * FROM jsonb_array_elements(v_rule.actions) LOOP
          PERFORM app.automation_act(v_action, p_item, v_ctx.user_id);
        END LOOP;
        INSERT INTO app.automation_runs (automation_id, item_id, outcome)
        VALUES (v_rule.id, p_item, 'done');
      END IF;
      UPDATE authz.request_ctx
      SET user_id = v_ctx.user_id, step_up = v_ctx.step_up,
          automation_id = v_ctx.automation_id, automation_depth = v_ctx.automation_depth
      WHERE pid = pg_backend_pid();
    EXCEPTION WHEN OTHERS THEN
      -- Everything the rule did is undone, the change of identity included.
      INSERT INTO app.automation_runs (automation_id, item_id, outcome, detail)
      VALUES (v_rule.id, p_item, 'failed', SQLSTATE);
    END;
  END LOOP;
END
$$;

-- Whether the item came into being in this very transaction: then what is
-- done to it now is part of its creation.
CREATE FUNCTION app.item_is_new(p_item uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT i.created_at = transaction_timestamp() FROM app.items i WHERE i.id = p_item),
                  false)
$$;

CREATE FUNCTION app.items_automations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.automations_fire('created', NEW.id, '{}'::jsonb);
  ELSE
    PERFORM app.automations_fire('stage', NEW.id,
      jsonb_build_object('from', OLD.stage_id, 'to', NEW.stage_id));
  END IF;
  RETURN NULL;
END
$$;
-- A new item is looked at when the request ends, with everything it was
-- created with (people, fields, checklist).
CREATE CONSTRAINT TRIGGER automations_created AFTER INSERT ON app.items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.items_automations();
-- A change of stage is acted on at once. Triggers fire in the order of their
-- names: this one comes after the change is written in the history and after a
-- repeating item makes its next one, so the person's own change comes first.
CREATE TRIGGER run_automations AFTER UPDATE OF stage_id ON app.items
  FOR EACH ROW
  WHEN (NEW.stage_id IS DISTINCT FROM OLD.stage_id AND NEW.list_id = OLD.list_id)
  EXECUTE FUNCTION app.items_automations();

CREATE FUNCTION app.item_field_values_automations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_item  uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.item_id ELSE NEW.item_id END;
  v_field uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.field_id ELSE NEW.field_id END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.value IS NOT DISTINCT FROM OLD.value THEN
    RETURN NULL;
  END IF;
  IF app.item_is_new(v_item) THEN
    RETURN NULL;
  END IF;
  -- On a delete NEW is empty, so the value reads as null: the field was cleared.
  PERFORM app.automations_fire('field', v_item,
    jsonb_build_object('field', v_field, 'value', NEW.value));
  RETURN NULL;
END
$$;
-- After the history line, like the stage.
CREATE TRIGGER run_automations AFTER INSERT OR UPDATE OR DELETE ON app.item_field_values
  FOR EACH ROW EXECUTE FUNCTION app.item_field_values_automations();

CREATE FUNCTION app.item_assignees_automations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF app.item_is_new(NEW.item_id) THEN
    RETURN NULL;
  END IF;
  PERFORM app.automations_fire('assigned', NEW.item_id, jsonb_build_object('person', NEW.user_id));
  RETURN NULL;
END
$$;
CREATE TRIGGER run_automations AFTER INSERT ON app.item_assignees
  FOR EACH ROW EXECUTE FUNCTION app.item_assignees_automations();

REVOKE EXECUTE ON FUNCTION
  app.automation_field(uuid, text),
  app.automation_choice(app.field_kind, jsonb, jsonb),
  app.automations_fire(text, uuid, jsonb),
  app.item_is_new(uuid),
  app.items_automations(),
  app.item_field_values_automations(),
  app.item_assignees_automations()
FROM PUBLIC;
