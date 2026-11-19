-- =============================================================================
-- "Nobody grants what they do not have", all the way down (Fase 11).
--
-- A grant on a space or a folder reaches every folder and list below it that
-- has no rule of its own for the person who receives it. Until now, whoever
-- granted only had to manage the space or folder itself: an administrator kept
-- out of one list of a space (or limited to their own items in it) could still
-- open that list to someone else by granting the whole space. Now each rule the
-- grantor has below the scope must give them at least what they hand out.
-- =============================================================================

CREATE FUNCTION authz.can_grant(
  p_target uuid, p_space uuid, p_folder uuid, p_list uuid, p_item_scope app.item_scope,
  p_level app.access_level
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT authz.can_grant(p_target, p_space, p_folder, p_list, p_item_scope) THEN
    RETURN false;
  END IF;
  IF authz.is_owner() OR p_list IS NOT NULL THEN
    RETURN true;
  END IF;
  -- The grantor's own narrower rules below the scope: each one must cover the grant.
  RETURN NOT EXISTS (
    SELECT 1 FROM app.access_grants ag
    WHERE ag.user_id = authz.uid()
      AND (
        ag.list_id IN (SELECT l.id FROM app.lists l
                       WHERE (p_space IS NOT NULL AND l.space_id = p_space)
                          OR (p_folder IS NOT NULL AND l.folder_id = p_folder))
        OR (p_space IS NOT NULL
            AND ag.folder_id IN (SELECT f.id FROM app.folders f WHERE f.space_id = p_space))
      )
      AND (ag.level < p_level OR (p_item_scope = 'all' AND ag.item_scope = 'assigned'))
  );
END
$$;
GRANT EXECUTE ON FUNCTION
  authz.can_grant(uuid, uuid, uuid, uuid, app.item_scope, app.access_level) TO cerebro_app;

-- Giving or changing a rule checks what is handed out; taking one away (which only
-- narrows access) keeps the rule it had.
DROP POLICY grants_insert ON app.access_grants;
DROP POLICY grants_update ON app.access_grants;
CREATE POLICY grants_insert ON app.access_grants FOR INSERT TO cerebro_app
  WITH CHECK (authz.can_grant(user_id, space_id, folder_id, list_id, item_scope, level));
CREATE POLICY grants_update ON app.access_grants FOR UPDATE TO cerebro_app
  USING (authz.can_grant(user_id, space_id, folder_id, list_id, item_scope))
  WITH CHECK (authz.can_grant(user_id, space_id, folder_id, list_id, item_scope, level));
