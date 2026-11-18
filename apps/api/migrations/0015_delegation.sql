-- =============================================================================
-- Delegating: who an item can be handed to. Only people who can work in the
-- item's list (edit it or more) can be made responsible for one of its items,
-- and whoever hands out work in a list may see who those people are, without
-- needing to manage users.
-- =============================================================================

-- What a given person may do in a list. The same rule as authz.my_list_access,
-- for someone other than the caller. Not callable by the application: it is
-- used only inside the checks below.
CREATE FUNCTION authz.list_level_of(p_user uuid, p_list uuid) RETURNS app.access_level
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN u.status <> 'active' THEN 'none'::app.access_level
    WHEN u.role = 'owner' THEN 'manage'::app.access_level
    ELSE coalesce(gl.level, gf.level, gs.level, 'none'::app.access_level)
  END
  FROM app.users u
  JOIN app.lists l ON l.id = p_list
  LEFT JOIN app.access_grants gl ON gl.user_id = u.id AND gl.list_id = l.id
  LEFT JOIN app.access_grants gf ON gf.user_id = u.id AND gf.folder_id = l.folder_id
  LEFT JOIN app.access_grants gs ON gs.user_id = u.id AND gs.space_id = l.space_id
  WHERE u.id = p_user
$$;

-- An item is handed only to someone who can work on it.
CREATE FUNCTION app.item_assignees_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF session_user <> 'cerebro_app' THEN
    RETURN NEW;
  END IF;
  IF coalesce(authz.list_level_of(
       NEW.user_id, (SELECT i.list_id FROM app.items i WHERE i.id = NEW.item_id)
     ), 'none') < 'edit' THEN
    RAISE EXCEPTION 'this person cannot work in this list' USING ERRCODE = 'CB003';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER can_work BEFORE INSERT ON app.item_assignees
  FOR EACH ROW EXECUTE FUNCTION app.item_assignees_guard();

-- The people work in a list can be handed to, for whoever hands out work there
-- (edits every item of it). Anyone else gets nobody.
CREATE FUNCTION app.list_people(p_list uuid)
RETURNS TABLE (id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT u.id, u.name
  FROM app.users u
  WHERE EXISTS (
          SELECT 1 FROM authz.my_list_access() a
          WHERE a.list_id = p_list
            AND a.level >= 'edit'
            AND a.item_scope = 'all'
            AND (NOT a.is_sensitive OR authz.step_up_ok())
        )
    AND authz.list_level_of(u.id, p_list) >= 'edit'
  ORDER BY u.name, u.id
$$;

REVOKE EXECUTE ON FUNCTION
  authz.list_level_of(uuid, uuid),
  app.item_assignees_guard(),
  app.list_people(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_people(uuid) TO cerebro_app;
