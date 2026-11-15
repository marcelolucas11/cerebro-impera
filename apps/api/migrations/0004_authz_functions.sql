-- Authorization decisions. Every function answers for the person bound to the
-- current request (authz.uid()); none of them takes "which user" as an
-- argument, so they cannot be used to probe someone else's access.
--
-- They are SECURITY DEFINER because they must read tables the caller cannot
-- read directly (for example, everybody's grants). search_path is pinned and
-- every name is schema-qualified.

CREATE FUNCTION authz.my_role() RETURNS app.user_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT u.role FROM app.users u WHERE u.id = authz.uid() AND u.status = 'active'
$$;

CREATE FUNCTION authz.is_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(authz.my_role() = 'owner', false)
$$;

-- Owners hold every capability implicitly.
CREATE FUNCTION authz.has_capability(p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN authz.my_role() IS NULL THEN false
    WHEN authz.my_role() = 'owner' THEN true
    ELSE EXISTS (
      SELECT 1 FROM app.user_capabilities uc
      WHERE uc.user_id = authz.uid() AND uc.capability = p_capability
    )
  END
$$;

-- Chain of command: owners administer anyone; others need `users.manage` and
-- can only reach people strictly below their own role, never themselves.
CREATE FUNCTION authz.can_manage_user(p_target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN authz.my_role() IS NULL THEN false
    WHEN authz.my_role() = 'owner' THEN EXISTS (SELECT 1 FROM app.users t WHERE t.id = p_target)
    WHEN p_target = authz.uid() THEN false
    ELSE authz.has_capability('users.manage') AND EXISTS (
      SELECT 1 FROM app.users t WHERE t.id = p_target AND t.role < authz.my_role()
    )
  END
$$;

-- Effective access to one scope (exactly one argument is non-null).
-- The most specific grant wins: list, then folder, then space. An explicit
-- 'none' therefore hides a list even when its space is granted.
CREATE FUNCTION authz.scope_access(
  p_space uuid, p_folder uuid, p_list uuid,
  OUT o_level app.access_level, OUT o_item_scope app.item_scope
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid    uuid := authz.uid();
  v_role   app.user_role := authz.my_role();
  v_space  uuid;
  v_folder uuid;
  g        record;
BEGIN
  o_level := 'none';
  o_item_scope := 'assigned';
  IF v_role IS NULL OR num_nonnulls(p_space, p_folder, p_list) <> 1 THEN
    RETURN;
  END IF;

  IF p_list IS NOT NULL THEN
    SELECT l.space_id, l.folder_id INTO v_space, v_folder FROM app.lists l WHERE l.id = p_list;
    IF NOT FOUND THEN RETURN; END IF;
  ELSIF p_folder IS NOT NULL THEN
    SELECT f.space_id INTO v_space FROM app.folders f WHERE f.id = p_folder;
    IF NOT FOUND THEN RETURN; END IF;
    v_folder := p_folder;
  ELSE
    PERFORM 1 FROM app.spaces s WHERE s.id = p_space;
    IF NOT FOUND THEN RETURN; END IF;
    v_space := p_space;
  END IF;

  IF v_role = 'owner' THEN
    o_level := 'manage';
    o_item_scope := 'all';
    RETURN;
  END IF;

  IF p_list IS NOT NULL THEN
    SELECT ag.level, ag.item_scope INTO g FROM app.access_grants ag
    WHERE ag.user_id = v_uid AND ag.list_id = p_list;
    IF FOUND THEN o_level := g.level; o_item_scope := g.item_scope; RETURN; END IF;
  END IF;

  IF v_folder IS NOT NULL THEN
    SELECT ag.level, ag.item_scope INTO g FROM app.access_grants ag
    WHERE ag.user_id = v_uid AND ag.folder_id = v_folder;
    IF FOUND THEN o_level := g.level; o_item_scope := g.item_scope; RETURN; END IF;
  END IF;

  SELECT ag.level, ag.item_scope INTO g FROM app.access_grants ag
  WHERE ag.user_id = v_uid AND ag.space_id = v_space;
  IF FOUND THEN o_level := g.level; o_item_scope := g.item_scope; END IF;
END
$$;

CREATE FUNCTION authz.space_level(p_space uuid) RETURNS app.access_level
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (authz.scope_access(p_space, NULL, NULL)).o_level
$$;

CREATE FUNCTION authz.folder_level(p_folder uuid) RETURNS app.access_level
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (authz.scope_access(NULL, p_folder, NULL)).o_level
$$;

CREATE FUNCTION authz.list_level(p_list uuid) RETURNS app.access_level
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (authz.scope_access(NULL, NULL, p_list)).o_level
$$;

-- The same resolution for every list at once. Row-level policies use this so
-- that access is computed once per statement instead of once per row.
CREATE FUNCTION authz.my_list_access()
RETURNS TABLE (list_id uuid, level app.access_level, item_scope app.item_scope, is_sensitive boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH me AS (
    SELECT u.id, u.role FROM app.users u WHERE u.id = authz.uid() AND u.status = 'active'
  )
  SELECT
    l.id,
    CASE WHEN me.role = 'owner' THEN 'manage'::app.access_level
         ELSE coalesce(gl.level, gf.level, gs.level, 'none'::app.access_level) END,
    CASE WHEN me.role = 'owner' THEN 'all'::app.item_scope
         WHEN gl.id IS NOT NULL THEN gl.item_scope
         WHEN gf.id IS NOT NULL THEN gf.item_scope
         WHEN gs.id IS NOT NULL THEN gs.item_scope
         ELSE 'assigned'::app.item_scope END,
    l.is_sensitive
  FROM me
  CROSS JOIN app.lists l
  LEFT JOIN app.access_grants gl ON gl.user_id = me.id AND gl.list_id = l.id
  LEFT JOIN app.access_grants gf ON gf.user_id = me.id AND gf.folder_id = l.folder_id
  LEFT JOIN app.access_grants gs ON gs.user_id = me.id AND gs.space_id = l.space_id
$$;

-- Containers are visible when the person can open them or anything inside
-- them, so that navigation works without revealing siblings.
CREATE FUNCTION authz.can_see_space(p_space uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT authz.my_role() IS NOT NULL AND (
    authz.space_level(p_space) >= 'view'
    OR EXISTS (
      SELECT 1 FROM authz.my_list_access() a
      JOIN app.lists l ON l.id = a.list_id
      WHERE l.space_id = p_space AND a.level >= 'view'
    )
    OR EXISTS (
      SELECT 1 FROM app.access_grants ag
      JOIN app.folders f ON f.id = ag.folder_id
      WHERE ag.user_id = authz.uid() AND f.space_id = p_space AND ag.level >= 'view'
    )
  )
$$;

CREATE FUNCTION authz.can_see_folder(p_folder uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT authz.my_role() IS NOT NULL AND (
    authz.folder_level(p_folder) >= 'view'
    OR EXISTS (
      SELECT 1 FROM authz.my_list_access() a
      JOIN app.lists l ON l.id = a.list_id
      WHERE l.folder_id = p_folder AND a.level >= 'view'
    )
  )
$$;

CREATE FUNCTION authz.is_assigned(p_item uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.item_assignees ia WHERE ia.item_id = p_item AND ia.user_id = authz.uid()
  )
$$;

-- An item is visible when: the person can open its list; the list is not
-- sensitive or they confirmed their second factor recently; and they either
-- see every item there or the item is theirs (assigned to or created by them).
CREATE FUNCTION authz.item_level(p_item uuid) RETURNS app.access_level
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((
    SELECT a.level
    FROM app.items i
    JOIN authz.my_list_access() a ON a.list_id = i.list_id
    WHERE i.id = p_item
      AND a.level >= 'view'
      AND (NOT a.is_sensitive OR authz.step_up_ok())
      AND (a.item_scope = 'all' OR i.created_by = authz.uid() OR authz.is_assigned(i.id))
  ), 'none'::app.access_level)
$$;

-- Delegating work (changing who an item is assigned to) is for people who see
-- the whole list, not for someone who only sees their own items.
CREATE FUNCTION authz.can_assign(p_item uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.items i
    JOIN authz.my_list_access() a ON a.list_id = i.list_id
    WHERE i.id = p_item
      AND a.level >= 'edit'
      AND a.item_scope = 'all'
      AND (NOT a.is_sensitive OR authz.step_up_ok())
  )
$$;

-- "Nobody grants what they do not have." Owners may grant anything. Anyone
-- else needs `users.manage`, must be allowed to administer the target, must
-- fully manage the scope, and cannot widen item visibility beyond their own.
-- Changing permissions always needs a recent second factor.
CREATE FUNCTION authz.can_grant(
  p_target uuid, p_space uuid, p_folder uuid, p_list uuid, p_item_scope app.item_scope
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role app.user_role := authz.my_role();
  v_own  record;
BEGIN
  IF v_role IS NULL OR NOT authz.step_up_ok() THEN
    RETURN false;
  END IF;
  IF num_nonnulls(p_space, p_folder, p_list) <> 1 THEN
    RETURN false;
  END IF;
  IF v_role = 'owner' THEN
    RETURN true;
  END IF;
  IF NOT authz.can_manage_user(p_target) THEN
    RETURN false;
  END IF;
  SELECT * INTO v_own FROM authz.scope_access(p_space, p_folder, p_list);
  IF v_own.o_level <> 'manage' THEN
    RETURN false;
  END IF;
  RETURN p_item_scope = 'assigned' OR v_own.o_item_scope = 'all';
END
$$;
