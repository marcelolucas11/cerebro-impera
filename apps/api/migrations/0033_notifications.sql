-- =============================================================================
-- Notifications inside the application, written by the database on every
-- path: being mentioned, being handed an item, a comment on an item that is
-- yours, and an item of yours due today or late (checked every hour).
--
-- Each one is read only by its recipient, and only while they can still see
-- the item: a notification never shows an item to anyone. The recipient marks
-- it read; nothing else about it changes.
--
-- Also here: the alert for many items sent to the trash by one person in a
-- short time, across requests (D44).
-- =============================================================================

CREATE TABLE app.notifications (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('mentioned', 'assigned', 'commented', 'due_today', 'overdue')),
  item_id    uuid NOT NULL REFERENCES app.items (id) ON DELETE CASCADE,
  comment_id uuid REFERENCES app.item_comments (id) ON DELETE CASCADE,
  actor      uuid REFERENCES app.users (id),
  -- The due date a reminder is about: one reminder of each kind per due date.
  due_on     date,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  CONSTRAINT notifications_due_kind CHECK ((kind IN ('due_today', 'overdue')) = (due_on IS NOT NULL))
);
CREATE INDEX notifications_user_idx ON app.notifications (user_id, id DESC);
CREATE UNIQUE INDEX notifications_due_once ON app.notifications (user_id, item_id, kind, due_on)
  WHERE due_on IS NOT NULL;

-- Read is the only thing that changes, and the moment is the database's.
CREATE FUNCTION app.notifications_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (NEW.user_id, NEW.kind, NEW.item_id, NEW.comment_id, NEW.actor, NEW.due_on, NEW.created_at)
     IS DISTINCT FROM
     (OLD.user_id, OLD.kind, OLD.item_id, OLD.comment_id, OLD.actor, OLD.due_on, OLD.created_at)
  THEN
    RAISE EXCEPTION 'a notification says what happened, and that does not change'
      USING ERRCODE = 'CB003';
  END IF;
  NEW.read_at := CASE WHEN NEW.read_at IS NULL THEN NULL ELSE coalesce(OLD.read_at, now()) END;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE UPDATE ON app.notifications
  FOR EACH ROW EXECUTE FUNCTION app.notifications_guard();

ALTER TABLE app.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_select ON app.notifications FOR SELECT TO cerebro_app
  USING (user_id = authz.uid());
CREATE POLICY notifications_update ON app.notifications FOR UPDATE TO cerebro_app
  USING (user_id = authz.uid())
  WITH CHECK (user_id = authz.uid());

GRANT SELECT ON app.notifications TO cerebro_app;
GRANT UPDATE (read_at) ON app.notifications TO cerebro_app;

-- ---------------------------------------------------------------------------
-- Written by the database
-- ---------------------------------------------------------------------------

-- One notification, to someone who sees the item, never to whoever caused it.
CREATE FUNCTION app.notify(
  p_user uuid, p_kind text, p_item uuid, p_comment uuid DEFAULT NULL, p_due date DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := authz.uid();
BEGIN
  IF p_user IS NOT DISTINCT FROM v_actor OR NOT authz.item_visible_to(p_user, p_item) THEN
    RETURN;
  END IF;
  INSERT INTO app.notifications (user_id, kind, item_id, comment_id, actor, due_on)
  VALUES (p_user, p_kind, p_item, p_comment, v_actor, p_due)
  ON CONFLICT DO NOTHING;
END
$$;

CREATE FUNCTION app.notify_assigned() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.notify(NEW.user_id, 'assigned', NEW.item_id);
  RETURN NULL;
END
$$;
CREATE TRIGGER notify AFTER INSERT ON app.item_assignees
  FOR EACH ROW EXECUTE FUNCTION app.notify_assigned();

-- A comment reaches whoever the item is with, or whoever created it when it
-- is with nobody.
CREATE FUNCTION app.notify_commented() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid;
BEGIN
  FOR v_user IN
    SELECT ia.user_id FROM app.item_assignees ia WHERE ia.item_id = NEW.item_id
    UNION
    SELECT i.created_by FROM app.items i
    WHERE i.id = NEW.item_id
      AND NOT EXISTS (SELECT 1 FROM app.item_assignees ia WHERE ia.item_id = i.id)
  LOOP
    PERFORM app.notify(v_user, 'commented', NEW.item_id, NEW.id);
  END LOOP;
  RETURN NULL;
END
$$;
CREATE TRIGGER notify AFTER INSERT ON app.item_comments
  FOR EACH ROW EXECUTE FUNCTION app.notify_commented();

-- Being mentioned says more than being told of a comment: it takes its place.
CREATE FUNCTION app.notify_mentioned() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_item uuid;
BEGIN
  SELECT c.item_id INTO v_item FROM app.item_comments c WHERE c.id = NEW.comment_id;
  DELETE FROM app.notifications n
  WHERE n.user_id = NEW.user_id AND n.comment_id = NEW.comment_id AND n.kind = 'commented';
  PERFORM app.notify(NEW.user_id, 'mentioned', v_item, NEW.comment_id);
  RETURN NULL;
END
$$;
CREATE TRIGGER notify AFTER INSERT ON app.comment_mentions
  FOR EACH ROW EXECUTE FUNCTION app.notify_mentioned();

-- Every hour: items due today, and items past due, still open and not in the
-- trash, remind whoever they are with (or whoever created them). Once per due
-- date and kind. "Today" is the server's day.
CREATE FUNCTION app.notify_due() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_count integer;
BEGIN
  WITH due AS (
    SELECT i.id, i.due_date,
           CASE WHEN i.due_date = current_date THEN 'due_today' ELSE 'overdue' END AS kind
    FROM app.items i
    JOIN app.list_stages s ON s.id = i.stage_id
    WHERE i.deleted_at IS NULL AND i.due_date <= current_date
      AND s.kind NOT IN ('done', 'closed')
  ),
  recipients AS (
    SELECT d.id, d.due_date, d.kind, ia.user_id
    FROM due d JOIN app.item_assignees ia ON ia.item_id = d.id
    UNION
    SELECT d.id, d.due_date, d.kind, i.created_by
    FROM due d JOIN app.items i ON i.id = d.id
    WHERE NOT EXISTS (SELECT 1 FROM app.item_assignees ia WHERE ia.item_id = d.id)
  ),
  made AS (
    INSERT INTO app.notifications (user_id, kind, item_id, due_on)
    SELECT r.user_id, r.kind, r.id, r.due_date
    FROM recipients r
    WHERE authz.item_visible_to(r.user_id, r.id)
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM made;
  RETURN v_count;
END
$$;

-- ---------------------------------------------------------------------------
-- Read by the recipient, while they see the item
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.my_notifications(p_before bigint, p_limit integer)
RETURNS TABLE (
  id bigint, kind text, item_id uuid, item_title text, list_id uuid, comment_id uuid,
  actor uuid, actor_name text, due_on date, created_at timestamptz, read_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT n.id, n.kind, n.item_id, i.title, i.list_id, n.comment_id, n.actor, u.name, n.due_on,
         n.created_at, n.read_at
  FROM app.notifications n
  JOIN app.items i ON i.id = n.item_id
  LEFT JOIN app.users u ON u.id = n.actor
  WHERE n.user_id = authz.uid()
    AND i.deleted_at IS NULL
    AND authz.item_level(n.item_id) >= 'view'
    AND (p_before IS NULL OR n.id < p_before)
  ORDER BY n.id DESC
  LIMIT least(greatest(p_limit, 1), 100)
$$;

CREATE FUNCTION app.my_unread_notifications() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT count(*)::integer
  FROM app.notifications n
  JOIN app.items i ON i.id = n.item_id
  WHERE n.user_id = authz.uid() AND n.read_at IS NULL AND i.deleted_at IS NULL
    AND authz.item_level(n.item_id) >= 'view'
$$;

-- ---------------------------------------------------------------------------
-- Many items to the trash in a short time, across requests (D44)
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.items_trash_volume() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := authz.uid();
  v_now   integer;
  v_total integer;
BEGIN
  IF session_user <> 'cerebro_app' OR v_actor IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO v_now FROM new_rows n JOIN old_rows o ON o.id = n.id
  WHERE o.deleted_at IS NULL AND n.deleted_at IS NOT NULL;
  IF v_now = 0 THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO v_total FROM app.items i
  WHERE i.deleted_by = v_actor AND i.deleted_at > now() - interval '10 minutes';
  -- Once, when the count crosses ten within the window.
  IF v_total >= 10 AND v_total - v_now < 10 THEN
    PERFORM app.raise_alert('trash_volume', 'warning', v_actor,
                            jsonb_build_object('count', v_total, 'minutes', 10));
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER trash_volume AFTER UPDATE ON app.items
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.items_trash_volume();

REVOKE EXECUTE ON FUNCTION
  app.notifications_guard(),
  app.notify(uuid, text, uuid, uuid, date),
  app.notify_assigned(),
  app.notify_commented(),
  app.notify_mentioned(),
  app.notify_due(),
  app.my_notifications(bigint, integer),
  app.my_unread_notifications(),
  app.items_trash_volume()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.notify_due(),
  app.my_notifications(bigint, integer),
  app.my_unread_notifications()
TO cerebro_app;
