-- =============================================================================
-- Mentions in comments, and the people of an item.
--
-- Only someone who can see the item can be mentioned on it: a mention never
-- shows an item to anyone. Only the author of a comment mentions people in it,
-- while the comment stands and the item is not in the trash.
--
-- The people of an item are the names whoever sees the item needs to follow
-- its comments: those who can see it, and those who wrote, removed or were
-- mentioned in its comments. Nobody learns a name from here about an item
-- they do not see.
-- =============================================================================

-- Whether a given person can see a given item, by the same rules as their own
-- requests: an owner sees everything; anyone else through their nearest grant
-- (list, then folder, then space), every item or only those they created or
-- were handed. A suspended account sees nothing.
CREATE FUNCTION authz.item_visible_to(p_user uuid, p_item uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.items i
    JOIN app.lists l ON l.id = i.list_id
    JOIN app.users u ON u.id = p_user AND u.status = 'active'
    LEFT JOIN LATERAL (
      SELECT ag.level, ag.item_scope FROM app.access_grants ag
      WHERE ag.user_id = u.id
        AND (ag.list_id = l.id OR ag.folder_id = l.folder_id OR ag.space_id = l.space_id)
      ORDER BY (ag.list_id IS NOT NULL) DESC, (ag.folder_id IS NOT NULL) DESC
      LIMIT 1
    ) g ON true
    WHERE i.id = p_item
      AND (
        u.role = 'owner'
        OR (g.level >= 'view'
            AND (g.item_scope = 'all' OR i.created_by = u.id
                 OR EXISTS (SELECT 1 FROM app.item_assignees ia
                            WHERE ia.item_id = i.id AND ia.user_id = u.id)))
      )
  )
$$;

CREATE TABLE app.comment_mentions (
  comment_id uuid NOT NULL REFERENCES app.item_comments (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES app.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX comment_mentions_user_idx ON app.comment_mentions (user_id, created_at DESC);

CREATE FUNCTION app.comment_mentions_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_comment app.item_comments;
BEGIN
  SELECT * INTO v_comment FROM app.item_comments c WHERE c.id = NEW.comment_id;
  IF v_comment.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'nobody is mentioned in a removed comment' USING ERRCODE = 'CB003';
  END IF;
  IF EXISTS (SELECT 1 FROM app.items i WHERE i.id = v_comment.item_id AND i.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the item is in the trash' USING ERRCODE = 'CB003';
  END IF;
  IF session_user = 'cerebro_app' AND authz.uid() IS DISTINCT FROM v_comment.author_id THEN
    RAISE EXCEPTION 'only the author mentions people in a comment' USING ERRCODE = 'CB001';
  END IF;
  IF NOT authz.item_visible_to(NEW.user_id, v_comment.item_id) THEN
    RAISE EXCEPTION 'only someone who sees the item can be mentioned on it' USING ERRCODE = 'CB003';
  END IF;
  IF (SELECT count(*) FROM app.comment_mentions m WHERE m.comment_id = NEW.comment_id) >= 20 THEN
    RAISE EXCEPTION 'at most 20 people mentioned in a comment' USING ERRCODE = 'CB003';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE INSERT ON app.comment_mentions
  FOR EACH ROW EXECUTE FUNCTION app.comment_mentions_guard();

-- A mention stays as it was made.
CREATE FUNCTION app.comment_mentions_keep() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM app.item_comments c WHERE c.id = OLD.comment_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'a mention stays as it was made' USING ERRCODE = 'CB001';
END
$$;
CREATE TRIGGER keep BEFORE UPDATE OR DELETE ON app.comment_mentions
  FOR EACH ROW EXECUTE FUNCTION app.comment_mentions_keep();

ALTER TABLE app.comment_mentions ENABLE ROW LEVEL SECURITY;

-- Read with the comment, while it stands.
CREATE POLICY comment_mentions_select ON app.comment_mentions FOR SELECT TO cerebro_app
  USING (EXISTS (
    SELECT 1 FROM app.item_comments c
    WHERE c.id = comment_mentions.comment_id AND c.deleted_at IS NULL
  ));
CREATE POLICY comment_mentions_insert ON app.comment_mentions FOR INSERT TO cerebro_app
  WITH CHECK (EXISTS (
    SELECT 1 FROM app.item_comments c
    WHERE c.id = comment_mentions.comment_id AND c.author_id = authz.uid()
  ));

GRANT SELECT ON app.comment_mentions TO cerebro_app;
GRANT INSERT (comment_id, user_id) ON app.comment_mentions TO cerebro_app;

-- ---------------------------------------------------------------------------
-- The people of an item
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.item_people(p_item uuid)
RETURNS TABLE (id uuid, name text, sees_item boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH related AS (
    SELECT c.author_id AS user_id FROM app.item_comments c WHERE c.item_id = p_item
    UNION
    SELECT c.deleted_by FROM app.item_comments c
    WHERE c.item_id = p_item AND c.deleted_by IS NOT NULL
    UNION
    SELECT m.user_id FROM app.comment_mentions m
    JOIN app.item_comments c ON c.id = m.comment_id
    WHERE c.item_id = p_item
  )
  SELECT u.id, u.name, authz.item_visible_to(u.id, p_item)
  FROM app.users u
  WHERE authz.item_level(p_item) >= 'view'
    AND (authz.item_visible_to(u.id, p_item) OR u.id IN (SELECT r.user_id FROM related r))
  ORDER BY u.name, u.id
$$;

REVOKE EXECUTE ON FUNCTION
  authz.item_visible_to(uuid, uuid),
  app.comment_mentions_guard(),
  app.comment_mentions_keep(),
  app.item_people(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.item_people(uuid) TO cerebro_app;
