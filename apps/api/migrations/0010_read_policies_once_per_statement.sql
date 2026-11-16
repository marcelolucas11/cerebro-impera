-- =============================================================================
-- The same rules for reading, written so the database works out a person's
-- access once per statement instead of once per row.
--
-- The first policies asked "may this person see this row?" by calling a
-- function for every row. Listing a few hundred items with their details then
-- took seconds. Here the question becomes "is this row's list one of the lists
-- this person may read?", and that set of lists is computed a single time.
-- Who may see what does not change.
-- =============================================================================

-- Compiling queries to machine code pays off for long analytical queries, not
-- for the many short ones an application like this runs; here it only added a
-- fixed delay to every larger read.
ALTER ROLE cerebro_app  SET jit = off;
ALTER ROLE cerebro_auth SET jit = off;

-- The lists whose items the person may reach at a given level. A sensitive
-- list only counts while their second factor was confirmed recently. With
-- `p_every_item`, only the lists where they reach every item and not just
-- their own.
CREATE FUNCTION authz.my_item_lists(p_minimum app.access_level, p_every_item boolean)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.list_id
  FROM authz.my_list_access() a
  WHERE a.level >= p_minimum
    AND a.level > 'none'
    AND (NOT p_every_item OR a.item_scope = 'all')
    AND (NOT a.is_sensitive OR authz.step_up_ok())
$$;

-- Every item assigned to the person.
CREATE FUNCTION authz.my_assigned_items() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT ia.item_id FROM app.item_assignees ia WHERE ia.user_id = authz.uid()
$$;

REVOKE EXECUTE ON FUNCTION authz.my_item_lists(app.access_level, boolean),
  authz.my_assigned_items() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.my_item_lists(app.access_level, boolean),
  authz.my_assigned_items() TO cerebro_app;

-- Items. Still the heart of "an employee only sees what is theirs": every item
-- of the lists they read whole, and in the others only what they created or
-- what is assigned to them.
DROP POLICY items_select ON app.items;
CREATE POLICY items_select ON app.items FOR SELECT TO cerebro_app
  USING (
    list_id IN (SELECT authz.my_item_lists('view', true))
    OR (
      list_id IN (SELECT authz.my_item_lists('view', false))
      AND (created_by = authz.uid() OR id IN (SELECT authz.my_assigned_items()))
    )
  );

DROP POLICY items_update ON app.items;
CREATE POLICY items_update ON app.items FOR UPDATE TO cerebro_app
  USING (
    list_id IN (SELECT authz.my_item_lists('edit', true))
    OR (
      list_id IN (SELECT authz.my_item_lists('edit', false))
      AND (created_by = authz.uid() OR id IN (SELECT authz.my_assigned_items()))
    )
  )
  WITH CHECK (
    list_id IN (SELECT authz.my_item_lists('edit', true))
    OR (
      list_id IN (SELECT authz.my_item_lists('edit', false))
      AND (created_by = authz.uid() OR id IN (SELECT authz.my_assigned_items()))
    )
  );

-- What hangs from an item is read by exactly who reads the item. Asking for
-- the item itself applies the policy above, so there is one rule, not a copy.
DROP POLICY assignees_select ON app.item_assignees;
CREATE POLICY assignees_select ON app.item_assignees FOR SELECT TO cerebro_app
  USING (EXISTS (SELECT 1 FROM app.items i WHERE i.id = item_assignees.item_id));

DROP POLICY item_stage_history_select ON app.item_stage_history;
CREATE POLICY item_stage_history_select ON app.item_stage_history FOR SELECT TO cerebro_app
  USING (EXISTS (SELECT 1 FROM app.items i WHERE i.id = item_stage_history.item_id));

-- The stages of the lists the person can open.
DROP POLICY list_stages_select ON app.list_stages;
CREATE POLICY list_stages_select ON app.list_stages FOR SELECT TO cerebro_app
  USING (list_id IN (
    SELECT a.list_id FROM authz.my_list_access() a WHERE a.level >= 'view'
  ));
