-- =============================================================================
-- Automations, fourth step: rules that act when an item's due date comes —
-- some days before, on the day, or some days late.
--
-- Nobody is signed in when a day turns: the hourly job runs these. For each
-- rule and item, and only inside this function, the acting person becomes the
-- rule's author with no recent second factor, exactly as when a person sets a
-- rule off; when the function ends, nobody is left acting. It refuses to run
-- inside a person's request, so it can never be used to borrow an identity.
-- Each rule acts once per item and due date. Finished items and items in the
-- trash are left alone.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- What a rule may say: one more "when"
-- ---------------------------------------------------------------------------

ALTER FUNCTION app.automation_problem(uuid, jsonb, jsonb, jsonb)
  RENAME TO automation_problem_before_due;

CREATE FUNCTION app.automation_problem(
  p_list uuid, p_trigger jsonb, p_conditions jsonb, p_actions jsonb
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(p_trigger) = 'object' AND p_trigger ->> 'on' = 'due' THEN
    -- Days from the due date: negative before it, zero on the day, positive late.
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_trigger) k WHERE k NOT IN ('on', 'offset'))
       OR NOT coalesce(jsonb_typeof(p_trigger -> 'offset') = 'number'
                       AND (p_trigger ->> 'offset') ~ '^-?[0-9]{1,2}$'
                       AND abs((p_trigger ->> 'offset')::integer) <= 30, false) THEN
      RETURN 'bad_trigger';
    END IF;
    -- The rest is checked as for any rule.
    RETURN app.automation_problem_before_due(p_list, '{"on": "created"}', p_conditions, p_actions);
  END IF;
  RETURN app.automation_problem_before_due(p_list, p_trigger, p_conditions, p_actions);
END
$$;

-- ---------------------------------------------------------------------------
-- One rule on one item, as its author: shared by every way a rule starts
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.automation_apply(
  p_rule app.automations, p_item uuid, p_ctx authz.request_ctx, p_origin uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_item   app.items;
  v_action jsonb;
BEGIN
  SELECT * INTO v_item FROM app.items i WHERE i.id = p_item;
  BEGIN
    -- From here until the rule ends, the acting person is its author.
    UPDATE authz.request_ctx
    SET user_id = p_rule.run_as, step_up = false,
        automation_id = p_rule.id, automation_depth = p_ctx.automation_depth + 1
    WHERE pid = pg_backend_pid();
    -- A suspended author sees nothing, so this covers that too.
    IF authz.item_level(p_item) < 'edit' THEN
      INSERT INTO app.automation_runs (automation_id, item_id, outcome, detail)
      VALUES (p_rule.id, p_item, 'skipped', 'no_access');
    ELSIF app.automation_holds(p_rule.conditions, v_item) THEN
      FOR v_action IN SELECT * FROM jsonb_array_elements(p_rule.actions) LOOP
        PERFORM app.automation_act(v_action, p_item, p_origin);
      END LOOP;
      INSERT INTO app.automation_runs (automation_id, item_id, outcome)
      VALUES (p_rule.id, p_item, 'done');
    END IF;
    UPDATE authz.request_ctx
    SET user_id = p_ctx.user_id, step_up = p_ctx.step_up,
        automation_id = p_ctx.automation_id, automation_depth = p_ctx.automation_depth
    WHERE pid = pg_backend_pid();
  EXCEPTION WHEN OTHERS THEN
    -- Everything the rule did is undone, the change of identity included.
    INSERT INTO app.automation_runs (automation_id, item_id, outcome, detail)
    VALUES (p_rule.id, p_item, 'failed', SQLSTATE);
  END;
END
$$;

CREATE OR REPLACE FUNCTION app.automations_fire(p_on text, p_item uuid, p_event jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ctx  authz.request_ctx;
  v_list uuid;
  v_rule app.automations;
  v_item app.items;
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
    PERFORM app.automation_apply(v_rule, p_item, v_ctx, v_ctx.user_id);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- When the due date comes
-- ---------------------------------------------------------------------------

-- Which rule already acted on which item for which due date.
CREATE TABLE app.automation_due_seen (
  automation_id uuid NOT NULL REFERENCES app.automations (id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES app.items (id) ON DELETE CASCADE,
  due_on        date NOT NULL,
  PRIMARY KEY (automation_id, item_id, due_on)
);
ALTER TABLE app.automation_due_seen ENABLE ROW LEVEL SECURITY;

-- Signs in nobody: the acting person is a rule's author only while the rule
-- runs, in this function, and nobody once it returns.
CREATE FUNCTION app.automations_due() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_due   record;
  v_rule  app.automations;
  v_ctx   authz.request_ctx;
  v_count integer := 0;
BEGIN
  IF authz.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'rules on due dates run on their own, not in a request' USING ERRCODE = 'CB001';
  END IF;
  DELETE FROM app.automation_due_seen s WHERE s.due_on < current_date - 31;

  FOR v_due IN
    SELECT a.id AS rule_id, i.id AS item_id, i.due_date
    FROM app.automations a
    JOIN app.items i ON i.list_id = a.list_id
    JOIN app.list_stages s ON s.id = i.stage_id
    WHERE a.enabled AND a.trigger ->> 'on' = 'due'
      AND i.deleted_at IS NULL
      AND i.due_date = current_date - (a.trigger ->> 'offset')::integer
      AND s.kind NOT IN ('done', 'closed')
      AND NOT EXISTS (SELECT 1 FROM app.automation_due_seen d
                      WHERE d.automation_id = a.id AND d.item_id = i.id AND d.due_on = i.due_date)
    ORDER BY a.created_at, a.id, i.id
  LOOP
    INSERT INTO app.automation_due_seen (automation_id, item_id, due_on)
    VALUES (v_due.rule_id, v_due.item_id, v_due.due_date);
    SELECT * INTO v_rule FROM app.automations a WHERE a.id = v_due.rule_id;
    -- The author is who acts, for this rule only; the session is nobody's.
    INSERT INTO authz.request_ctx (pid, xact_start, user_id, session_id, ip, step_up)
    VALUES (pg_backend_pid(), transaction_timestamp(), v_rule.run_as,
            '00000000-0000-0000-0000-000000000000', NULL, false)
    ON CONFLICT (pid) DO UPDATE
      SET xact_start = EXCLUDED.xact_start, user_id = EXCLUDED.user_id,
          session_id = EXCLUDED.session_id, ip = NULL, step_up = false;
    SELECT * INTO v_ctx FROM authz.request_ctx c WHERE c.pid = pg_backend_pid();
    -- Nobody set this off, so nobody is spared a notification.
    PERFORM app.automation_apply(v_rule, v_due.item_id, v_ctx, NULL);
    v_count := v_count + 1;
  END LOOP;

  DELETE FROM authz.request_ctx WHERE pid = pg_backend_pid();
  RETURN v_count;
END
$$;

REVOKE EXECUTE ON FUNCTION
  app.automation_problem_before_due(uuid, jsonb, jsonb, jsonb),
  app.automation_problem(uuid, jsonb, jsonb, jsonb),
  app.automation_apply(app.automations, uuid, authz.request_ctx, uuid),
  app.automations_due()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automations_due() TO cerebro_app;
