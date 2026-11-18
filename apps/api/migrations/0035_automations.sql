-- =============================================================================
-- Automations: rules per list. When an item is created or enters a stage, and
-- what the rule asks of it holds, the rule acts: moves it to a stage, sets its
-- priority, hands it to someone, tells people, or comments.
--
-- A rule acts with the access of whoever last saved it, never more. Inside the
-- database, for exactly the duration of the rule, the acting person becomes
-- that author, with no recent second factor: every guard, stamp and history
-- line sees the author, and what the author could not do, the rule cannot do
-- (so nothing on a sensitive list). What a rule does is marked as the rule's
-- in the history, in comments and in notifications. A rule never undoes or
-- blocks what the person did: when it cannot act, or fails, that goes to its
-- log instead. Rules starting rules stop three levels down.
--
-- Rules are seen by whoever manages the list, and written only by those who
-- also hold the "automations" capability.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Which rule is acting, kept where the application cannot write
-- ---------------------------------------------------------------------------

ALTER TABLE authz.request_ctx
  ADD COLUMN automation_id uuid,
  ADD COLUMN automation_depth smallint NOT NULL DEFAULT 0;

-- A new request on the same connection starts with no rule acting.
CREATE FUNCTION authz.request_ctx_fresh() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.xact_start IS DISTINCT FROM OLD.xact_start THEN
    NEW.automation_id := NULL;
    NEW.automation_depth := 0;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fresh BEFORE UPDATE ON authz.request_ctx
  FOR EACH ROW EXECUTE FUNCTION authz.request_ctx_fresh();

CREATE FUNCTION authz.automation_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.automation_id FROM authz.request_ctx c
  WHERE c.pid = pg_backend_pid() AND c.xact_start = transaction_timestamp()
$$;

-- ---------------------------------------------------------------------------
-- Rules and their log
-- ---------------------------------------------------------------------------

CREATE TABLE app.automations (
  id         uuid PRIMARY KEY,
  list_id    uuid NOT NULL REFERENCES app.lists (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name)),
  enabled    boolean NOT NULL DEFAULT true,
  trigger    jsonb NOT NULL,
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions    jsonb NOT NULL,
  -- Whoever saved it last: it acts with their access.
  run_as     uuid NOT NULL REFERENCES app.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automations_list_idx ON app.automations (list_id) WHERE enabled;

CREATE TABLE app.automation_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  automation_id uuid NOT NULL REFERENCES app.automations (id) ON DELETE CASCADE,
  item_id       uuid REFERENCES app.items (id) ON DELETE SET NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  outcome       text NOT NULL CHECK (outcome IN ('done', 'skipped', 'failed')),
  -- Why it was skipped, or the error it met.
  detail        text CHECK (char_length(detail) <= 40),
  CHECK ((outcome = 'done') = (detail IS NULL))
);
CREATE INDEX automation_runs_rule_idx ON app.automation_runs (automation_id, id DESC);

-- What a rule does is marked as the rule's. No foreign key: the mark stays
-- when the rule is removed, and these records never change once written.
ALTER TABLE app.item_changes ADD COLUMN automation_id uuid DEFAULT authz.automation_id();
ALTER TABLE app.item_comments ADD COLUMN automation_id uuid DEFAULT authz.automation_id();
ALTER TABLE app.notifications ADD COLUMN automation_id uuid DEFAULT authz.automation_id();

-- The name of a rule, for whoever can open its list.
CREATE FUNCTION app.automation_name(p_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.name FROM app.automations a
  WHERE a.id = p_id AND authz.list_level(a.list_id) >= 'view'
$$;

-- ---------------------------------------------------------------------------
-- What a rule may say, checked against the list it belongs to
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.automation_problem(
  p_list uuid, p_trigger jsonb, p_conditions jsonb, p_actions jsonb
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_item   jsonb;
  v_stage  text;
  v_person jsonb;
BEGIN
  IF (SELECT l.is_sensitive FROM app.lists l WHERE l.id = p_list) THEN
    RETURN 'sensitive_list';
  END IF;

  -- When
  IF jsonb_typeof(p_trigger) IS DISTINCT FROM 'object' THEN RETURN 'bad_trigger'; END IF;
  IF p_trigger ->> 'on' = 'created' THEN
    IF p_trigger <> '{"on": "created"}'::jsonb THEN RETURN 'bad_trigger'; END IF;
  ELSIF p_trigger ->> 'on' = 'stage' THEN
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
  ELSE
    RETURN 'bad_trigger';
  END IF;

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
        IF NOT EXISTS (
          SELECT 1 FROM app.list_fields f
          WHERE f.list_id = p_list AND f.id::text = v_item ->> 'field' AND NOT f.is_archived
            AND CASE f.kind
                  WHEN 'select' THEN EXISTS (
                    SELECT 1 FROM jsonb_array_elements(f.config -> 'options') o
                    WHERE o ->> 'id' = v_item ->> 'is')
                  WHEN 'checkbox' THEN jsonb_typeof(v_item -> 'is') = 'boolean'
                  ELSE false
                END
        ) THEN
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

-- The same check, for the screen that writes rules: only for who manages the
-- list, so that it tells nobody else which stages, fields or people exist.
CREATE FUNCTION app.automation_check(
  p_list uuid, p_trigger jsonb, p_conditions jsonb, p_actions jsonb
) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN authz.list_level(p_list) = 'manage'
      THEN app.automation_problem(p_list, p_trigger, p_conditions, p_actions)
    ELSE 'forbidden'
  END
$$;

-- Who a rule may hand work to, or tell: for who manages the list.
CREATE FUNCTION app.list_audience(p_list uuid)
RETURNS TABLE (id uuid, name text, can_work boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT u.id, u.name, authz.list_level_of(u.id, p_list) >= 'edit'
  FROM app.users u
  WHERE authz.list_level(p_list) = 'manage'
    AND authz.list_level_of(u.id, p_list) >= 'view'
  ORDER BY u.name, u.id
$$;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON app.automations
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('run_as', 'restamp');

CREATE FUNCTION app.automations_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_problem text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    IF (SELECT count(*) FROM app.automations a WHERE a.list_id = NEW.list_id) >= 50 THEN
      RAISE EXCEPTION 'at most 50 rules in a list' USING ERRCODE = 'CB003';
    END IF;
  ELSE
    IF NEW.list_id <> OLD.list_id THEN
      RAISE EXCEPTION 'a rule stays on its list' USING ERRCODE = 'CB003';
    END IF;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  v_problem := app.automation_problem(NEW.list_id, NEW.trigger, NEW.conditions, NEW.actions);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'rule not valid: %', v_problem USING ERRCODE = 'CB003';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.automations
  FOR EACH ROW EXECUTE FUNCTION app.automations_guard();

-- The log is the database's to write. Entries go with their rule, or once
-- they are older than 90 days; the item they name may be removed for good.
CREATE FUNCTION app.automation_runs_keep() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.at < now() - interval '90 days'
       OR NOT EXISTS (SELECT 1 FROM app.automations a WHERE a.id = OLD.automation_id) THEN
      RETURN OLD;
    END IF;
  ELSIF NEW.item_id IS NULL
        AND (NEW.id, NEW.automation_id, NEW.at, NEW.outcome, NEW.detail)
            IS NOT DISTINCT FROM (OLD.id, OLD.automation_id, OLD.at, OLD.outcome, OLD.detail) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the log of a rule is kept as it was' USING ERRCODE = 'CB001';
END
$$;
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.automation_runs
  FOR EACH ROW EXECUTE FUNCTION app.automation_runs_keep();

CREATE FUNCTION app.purge_automation_runs() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH gone AS (
    DELETE FROM app.automation_runs r WHERE r.at < now() - interval '90 days' RETURNING 1
  )
  SELECT count(*)::integer FROM gone
$$;

-- A rule's comment says what the rule said: nobody rewrites it. It can still
-- be removed like any other.
CREATE FUNCTION app.item_comments_automated() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.automation_id IS DISTINCT FROM OLD.automation_id
     OR (OLD.automation_id IS NOT NULL AND NEW.body IS DISTINCT FROM OLD.body) THEN
    RAISE EXCEPTION 'a comment by a rule is not rewritten' USING ERRCODE = 'CB003';
  END IF;
  RETURN NEW;
END
$$;
-- Named to run before the guard, which empties the text of a removed comment.
CREATE TRIGGER automated BEFORE UPDATE ON app.item_comments
  FOR EACH ROW EXECUTE FUNCTION app.item_comments_automated();

-- ---------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------

ALTER TABLE app.automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.automation_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY automations_select ON app.automations FOR SELECT TO cerebro_app
  USING (authz.list_level(list_id) = 'manage');
CREATE POLICY automations_insert ON app.automations FOR INSERT TO cerebro_app
  WITH CHECK (authz.list_level(list_id) = 'manage' AND authz.has_capability('automations.manage'));
CREATE POLICY automations_update ON app.automations FOR UPDATE TO cerebro_app
  USING (authz.list_level(list_id) = 'manage' AND authz.has_capability('automations.manage'))
  WITH CHECK (authz.list_level(list_id) = 'manage' AND authz.has_capability('automations.manage'));
CREATE POLICY automations_delete ON app.automations FOR DELETE TO cerebro_app
  USING (authz.list_level(list_id) = 'manage' AND authz.has_capability('automations.manage'));

CREATE POLICY automation_runs_select ON app.automation_runs FOR SELECT TO cerebro_app
  USING (EXISTS (SELECT 1 FROM app.automations a
                 WHERE a.id = automation_runs.automation_id
                   AND authz.list_level(a.list_id) = 'manage'));

GRANT SELECT ON app.automations, app.automation_runs TO cerebro_app;
GRANT INSERT (id, list_id, name, enabled, trigger, conditions, actions),
      UPDATE (name, enabled, trigger, conditions, actions),
      DELETE
  ON app.automations TO cerebro_app;

-- ---------------------------------------------------------------------------
-- A rule tells people: one more kind of notification
-- ---------------------------------------------------------------------------

ALTER TABLE app.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'mentioned', 'assigned', 'commented', 'due_today', 'overdue', 'automation'));

CREATE OR REPLACE FUNCTION app.notifications_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (NEW.user_id, NEW.kind, NEW.item_id, NEW.comment_id, NEW.actor, NEW.due_on, NEW.created_at,
      NEW.automation_id)
     IS DISTINCT FROM
     (OLD.user_id, OLD.kind, OLD.item_id, OLD.comment_id, OLD.actor, OLD.due_on, OLD.created_at,
      OLD.automation_id)
  THEN
    RAISE EXCEPTION 'a notification says what happened, and that does not change'
      USING ERRCODE = 'CB003';
  END IF;
  NEW.read_at := CASE WHEN NEW.read_at IS NULL THEN NULL ELSE coalesce(OLD.read_at, now()) END;
  RETURN NEW;
END
$$;

DROP FUNCTION app.my_notifications(bigint, integer);
CREATE FUNCTION app.my_notifications(p_before bigint, p_limit integer)
RETURNS TABLE (
  id bigint, kind text, item_id uuid, item_title text, list_id uuid, comment_id uuid,
  actor uuid, actor_name text, due_on date, created_at timestamptz, read_at timestamptz,
  automation_id uuid, automation_name text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT n.id, n.kind, n.item_id, i.title, i.list_id, n.comment_id, n.actor, u.name, n.due_on,
         n.created_at, n.read_at, n.automation_id, a.name
  FROM app.notifications n
  JOIN app.items i ON i.id = n.item_id
  LEFT JOIN app.users u ON u.id = n.actor
  LEFT JOIN app.automations a ON a.id = n.automation_id
  WHERE n.user_id = authz.uid()
    AND i.deleted_at IS NULL
    AND authz.item_level(n.item_id) >= 'view'
    AND (p_before IS NULL OR n.id < p_before)
  ORDER BY n.id DESC
  LIMIT least(greatest(p_limit, 1), 100)
$$;

-- ---------------------------------------------------------------------------
-- The engine
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.automation_holds(p_conditions jsonb, p_item app.items) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cond  jsonb;
  v_value jsonb;
BEGIN
  FOR v_cond IN SELECT * FROM jsonb_array_elements(p_conditions) LOOP
    CASE v_cond ->> 'if'
      WHEN 'stage' THEN
        IF p_item.stage_id::text IS DISTINCT FROM v_cond ->> 'is' THEN RETURN false; END IF;
      WHEN 'priority' THEN
        IF p_item.priority::text IS DISTINCT FROM v_cond ->> 'is' THEN RETURN false; END IF;
      WHEN 'assignee' THEN
        IF v_cond -> 'is' = 'null'::jsonb THEN
          IF EXISTS (SELECT 1 FROM app.item_assignees ia WHERE ia.item_id = p_item.id) THEN
            RETURN false;
          END IF;
        ELSIF NOT EXISTS (SELECT 1 FROM app.item_assignees ia
                          WHERE ia.item_id = p_item.id AND ia.user_id::text = v_cond ->> 'is') THEN
          RETURN false;
        END IF;
      WHEN 'field' THEN
        SELECT v.value INTO v_value FROM app.item_field_values v
        WHERE v.item_id = p_item.id AND v.field_id::text = v_cond ->> 'field';
        -- An unticked box and a box never ticked are the same.
        IF v_cond -> 'is' = 'false'::jsonb THEN
          IF v_value = 'true'::jsonb THEN RETURN false; END IF;
        ELSIF v_value IS DISTINCT FROM v_cond -> 'is' THEN
          RETURN false;
        END IF;
      ELSE
        RETURN false;
    END CASE;
  END LOOP;
  RETURN true;
END
$$;

-- One action, as the author. The tables' own guards hold as for anyone; what
-- row-level security would check, and which does not apply in here, is checked
-- by the engine (the author can edit the item) and below.
CREATE FUNCTION app.automation_act(p_action jsonb, p_item uuid, p_origin uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_person uuid;
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
  END CASE;
END
$$;

CREATE FUNCTION app.automations_fire(p_on text, p_item uuid, p_from uuid, p_to uuid) RETURNS void
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
      AND (NOT a.trigger ? 'to' OR a.trigger ->> 'to' = p_to::text)
      AND (NOT a.trigger ? 'from' OR a.trigger ->> 'from' = p_from::text)
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

CREATE FUNCTION app.items_automations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.automations_fire('created', NEW.id, NULL, NULL);
  ELSE
    PERFORM app.automations_fire('stage', NEW.id, OLD.stage_id, NEW.stage_id);
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

REVOKE EXECUTE ON FUNCTION
  authz.request_ctx_fresh(),
  authz.automation_id(),
  app.automation_name(uuid),
  app.automation_problem(uuid, jsonb, jsonb, jsonb),
  app.automation_check(uuid, jsonb, jsonb, jsonb),
  app.list_audience(uuid),
  app.automations_guard(),
  app.automation_runs_keep(),
  app.purge_automation_runs(),
  app.item_comments_automated(),
  app.my_notifications(bigint, integer),
  app.automation_holds(jsonb, app.items),
  app.automation_act(jsonb, uuid, uuid),
  app.automations_fire(text, uuid, uuid, uuid),
  app.items_automations()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  authz.automation_id(),
  app.automation_name(uuid),
  app.automation_check(uuid, jsonb, jsonb, jsonb),
  app.list_audience(uuid),
  app.purge_automation_runs(),
  app.my_notifications(bigint, integer)
TO cerebro_app;
