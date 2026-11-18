-- =============================================================================
-- The numbers of a list (Fase 6). They are counted by the API as the person,
-- so row-level security already keeps them to what the person sees. Only the
-- names of who items are with need help: people's names are not readable in
-- general, so this function gives the names of the people on the items this
-- person sees in the list, and nobody else's.
-- =============================================================================

CREATE FUNCTION app.assignee_names(p_list uuid)
RETURNS TABLE (id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT u.id, u.name
  FROM app.items i
  JOIN authz.my_list_access() a ON a.list_id = i.list_id
  JOIN app.item_assignees ia ON ia.item_id = i.id
  JOIN app.users u ON u.id = ia.user_id
  WHERE i.list_id = p_list
    AND i.deleted_at IS NULL
    AND a.level >= 'view'
    AND (NOT a.is_sensitive OR authz.step_up_ok())
    AND (a.item_scope = 'all' OR i.created_by = authz.uid() OR authz.is_assigned(i.id))
$$;

REVOKE EXECUTE ON FUNCTION app.assignee_names(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assignee_names(uuid) TO cerebro_app;
