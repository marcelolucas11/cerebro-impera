-- =============================================================================
-- Comments on an item. Read by whoever sees the item, written by whoever may
-- edit it. Only the author changes what a comment says, and every earlier
-- version is kept for whoever reads the comment. The author, or whoever
-- manages the list, removes a comment: what it said leaves the application's
-- reach for good (the database keeps it, for the owners of the server only).
-- Nothing about the comments of an item in the trash changes.
-- =============================================================================

CREATE TABLE app.item_comments (
  id         uuid PRIMARY KEY,
  item_id    uuid NOT NULL REFERENCES app.items (id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES app.users (id),
  body       text NOT NULL CHECK (char_length(body) <= 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES app.users (id),
  CONSTRAINT item_comments_deleted_by CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  -- A comment says something; a removed one says nothing at all.
  CONSTRAINT item_comments_body CHECK (
    (deleted_at IS NULL AND btrim(body) <> '') OR (deleted_at IS NOT NULL AND body = '')
  )
);
CREATE INDEX item_comments_item_idx ON app.item_comments (item_id, created_at);

-- What a comment said before each change, and before it was removed.
CREATE TABLE app.item_comment_versions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  comment_id  uuid NOT NULL REFERENCES app.item_comments (id) ON DELETE CASCADE,
  body        text NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX item_comment_versions_idx ON app.item_comment_versions (comment_id, id);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON app.item_comments
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('author_id');

CREATE TRIGGER trash_guard BEFORE INSERT OR UPDATE ON app.item_comments
  FOR EACH ROW EXECUTE FUNCTION app.refuse_if_trashed();

CREATE FUNCTION app.item_comments_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := authz.uid();
  v_list  uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.edited_at := NULL;
    IF NEW.deleted_at IS NOT NULL OR NEW.deleted_by IS NOT NULL THEN
      RAISE EXCEPTION 'a comment is written before it is removed' USING ERRCODE = 'CB003';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.item_id <> OLD.item_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a comment stays where and when it was written' USING ERRCODE = 'CB003';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a removed comment does not change' USING ERRCODE = 'CB003';
  END IF;

  IF NEW.deleted_at IS NOT NULL THEN
    -- Removed: by its author, or by whoever manages the list.
    IF session_user = 'cerebro_app' AND v_actor IS DISTINCT FROM OLD.author_id THEN
      SELECT i.list_id INTO v_list FROM app.items i WHERE i.id = OLD.item_id;
      IF authz.list_level(v_list) < 'manage' THEN
        RAISE EXCEPTION 'only the author or a manager of the list removes a comment'
          USING ERRCODE = 'CB001';
      END IF;
    END IF;
    INSERT INTO app.item_comment_versions (comment_id, body) VALUES (OLD.id, OLD.body);
    NEW.body := '';
    NEW.deleted_at := now();
    NEW.deleted_by := v_actor;
    NEW.edited_at := OLD.edited_at;
    RETURN NEW;
  END IF;

  IF NEW.deleted_by IS NOT NULL THEN
    RAISE EXCEPTION 'only removing a comment says who removed it' USING ERRCODE = 'CB003';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    IF session_user = 'cerebro_app' AND v_actor IS DISTINCT FROM OLD.author_id THEN
      RAISE EXCEPTION 'only the author changes what a comment says' USING ERRCODE = 'CB001';
    END IF;
    INSERT INTO app.item_comment_versions (comment_id, body) VALUES (OLD.id, OLD.body);
    NEW.edited_at := now();
  ELSE
    NEW.edited_at := OLD.edited_at;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON app.item_comments
  FOR EACH ROW EXECUTE FUNCTION app.item_comments_guard();

-- Versions are the database's to write, and nobody's to change.
CREATE FUNCTION app.item_comment_versions_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM app.item_comments c WHERE c.id = OLD.comment_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'what a comment said is kept as it was' USING ERRCODE = 'CB001';
END
$$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON app.item_comment_versions
  FOR EACH ROW EXECUTE FUNCTION app.item_comment_versions_guard();

-- ---------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------

ALTER TABLE app.item_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.item_comment_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY item_comments_select ON app.item_comments FOR SELECT TO cerebro_app
  USING (EXISTS (SELECT 1 FROM app.items i WHERE i.id = item_comments.item_id));
CREATE POLICY item_comments_insert ON app.item_comments FOR INSERT TO cerebro_app
  WITH CHECK (authz.item_level(item_id) >= 'edit');
-- The author while they may still edit the item; whoever manages the list,
-- only to remove (the guard above refuses them anything else).
CREATE POLICY item_comments_update ON app.item_comments FOR UPDATE TO cerebro_app
  USING (
    (author_id = authz.uid() AND authz.item_level(item_id) >= 'edit')
    OR authz.item_level(item_id) = 'manage'
  )
  WITH CHECK (
    (author_id = authz.uid() AND authz.item_level(item_id) >= 'edit')
    OR authz.item_level(item_id) = 'manage'
  );

-- Earlier versions are read with the comment, and not at all once it is removed.
CREATE POLICY item_comment_versions_select ON app.item_comment_versions FOR SELECT TO cerebro_app
  USING (EXISTS (
    SELECT 1 FROM app.item_comments c
    WHERE c.id = item_comment_versions.comment_id AND c.deleted_at IS NULL
  ));

GRANT SELECT ON app.item_comments, app.item_comment_versions TO cerebro_app;
GRANT INSERT (id, item_id, body), UPDATE (body, deleted_at) ON app.item_comments TO cerebro_app;

REVOKE EXECUTE ON FUNCTION
  app.item_comments_guard(),
  app.item_comment_versions_guard()
FROM PUBLIC;
