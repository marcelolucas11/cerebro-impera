-- Row-level security and privileges.
--
-- Row-level security is enabled on every table. A table with no policy for a
-- role is invisible to that role, so forgetting a policy fails closed.
--
-- Nothing is hard-deleted through the application in this phase: there is no
-- DELETE privilege on users, spaces, folders, lists or items.

ALTER TABLE authz.request_ctx      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.log              ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.chain_head       ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.instance_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_capabilities  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spaces             ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.folders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.lists              ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.items              ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.item_assignees     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.access_grants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.security_alerts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.credentials       ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.totp              ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.recovery_codes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.devices           ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.login_challenges  ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.invites           ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.throttle          ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- cerebro_app: authenticated requests
-- ---------------------------------------------------------------------------

-- Settings: any signed-in person reads them; changing needs the capability
-- and a recent second factor.
CREATE POLICY settings_select ON app.instance_settings FOR SELECT TO cerebro_app
  USING (authz.uid() IS NOT NULL);
CREATE POLICY settings_update ON app.instance_settings FOR UPDATE TO cerebro_app
  USING (authz.has_capability('system.config') AND authz.step_up_ok())
  WITH CHECK (authz.has_capability('system.config') AND authz.step_up_ok());

-- People: everyone sees themselves; owners and user administrators see the
-- directory. The guard trigger decides which changes are allowed.
CREATE POLICY users_select ON app.users FOR SELECT TO cerebro_app
  USING (id = authz.uid() OR authz.has_capability('users.manage'));
CREATE POLICY users_insert ON app.users FOR INSERT TO cerebro_app
  WITH CHECK (authz.is_owner() OR (authz.has_capability('users.manage') AND role < authz.my_role()));
CREATE POLICY users_update ON app.users FOR UPDATE TO cerebro_app
  USING (id = authz.uid() OR authz.can_manage_user(id))
  WITH CHECK (id = authz.uid() OR authz.can_manage_user(id));

-- Capabilities: only owners hand them out.
CREATE POLICY capabilities_select ON app.user_capabilities FOR SELECT TO cerebro_app
  USING (user_id = authz.uid() OR authz.can_manage_user(user_id));
CREATE POLICY capabilities_insert ON app.user_capabilities FOR INSERT TO cerebro_app
  WITH CHECK (authz.is_owner());
CREATE POLICY capabilities_delete ON app.user_capabilities FOR DELETE TO cerebro_app
  USING (authz.is_owner());

-- Grants: people see their own; administrators see and change only what they
-- themselves fully manage ("nobody grants what they do not have").
CREATE POLICY grants_select ON app.access_grants FOR SELECT TO cerebro_app
  USING (
    user_id = authz.uid()
    OR authz.is_owner()
    OR (authz.can_manage_user(user_id)
        AND (authz.scope_access(space_id, folder_id, list_id)).o_level = 'manage')
  );
CREATE POLICY grants_insert ON app.access_grants FOR INSERT TO cerebro_app
  WITH CHECK (authz.can_grant(user_id, space_id, folder_id, list_id, item_scope));
CREATE POLICY grants_update ON app.access_grants FOR UPDATE TO cerebro_app
  USING (authz.can_grant(user_id, space_id, folder_id, list_id, item_scope))
  WITH CHECK (authz.can_grant(user_id, space_id, folder_id, list_id, item_scope));
CREATE POLICY grants_delete ON app.access_grants FOR DELETE TO cerebro_app
  USING (authz.can_grant(user_id, space_id, folder_id, list_id, 'assigned'));

-- Structure.
CREATE POLICY spaces_select ON app.spaces FOR SELECT TO cerebro_app
  USING (authz.can_see_space(id));
CREATE POLICY spaces_insert ON app.spaces FOR INSERT TO cerebro_app
  WITH CHECK (authz.is_owner());
CREATE POLICY spaces_update ON app.spaces FOR UPDATE TO cerebro_app
  USING (authz.space_level(id) = 'manage')
  WITH CHECK (authz.space_level(id) = 'manage');

CREATE POLICY folders_select ON app.folders FOR SELECT TO cerebro_app
  USING (authz.can_see_folder(id));
CREATE POLICY folders_insert ON app.folders FOR INSERT TO cerebro_app
  WITH CHECK (authz.space_level(space_id) = 'manage');
CREATE POLICY folders_update ON app.folders FOR UPDATE TO cerebro_app
  USING (authz.folder_level(id) = 'manage')
  WITH CHECK (authz.folder_level(id) = 'manage');

CREATE POLICY lists_select ON app.lists FOR SELECT TO cerebro_app
  USING (authz.list_level(id) >= 'view');
CREATE POLICY lists_insert ON app.lists FOR INSERT TO cerebro_app
  WITH CHECK (
    CASE WHEN folder_id IS NULL THEN authz.space_level(space_id) = 'manage'
         ELSE authz.folder_level(folder_id) = 'manage' END
  );
CREATE POLICY lists_update ON app.lists FOR UPDATE TO cerebro_app
  USING (authz.list_level(id) = 'manage')
  WITH CHECK (authz.list_level(id) = 'manage');

-- Items. The heart of "an employee only sees what is theirs".
CREATE POLICY items_select ON app.items FOR SELECT TO cerebro_app
  USING (EXISTS (
    SELECT 1 FROM authz.my_list_access() a
    WHERE a.list_id = items.list_id
      AND a.level >= 'view'
      AND (NOT a.is_sensitive OR authz.step_up_ok())
      AND (a.item_scope = 'all' OR items.created_by = authz.uid() OR authz.is_assigned(items.id))
  ));
CREATE POLICY items_insert ON app.items FOR INSERT TO cerebro_app
  WITH CHECK (
    created_by = authz.uid()
    AND EXISTS (
      SELECT 1 FROM authz.my_list_access() a
      WHERE a.list_id = items.list_id
        AND a.level >= 'edit'
        AND (NOT a.is_sensitive OR authz.step_up_ok())
    )
  );
CREATE POLICY items_update ON app.items FOR UPDATE TO cerebro_app
  USING (EXISTS (
    SELECT 1 FROM authz.my_list_access() a
    WHERE a.list_id = items.list_id
      AND a.level >= 'edit'
      AND (NOT a.is_sensitive OR authz.step_up_ok())
      AND (a.item_scope = 'all' OR items.created_by = authz.uid() OR authz.is_assigned(items.id))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM authz.my_list_access() a
    WHERE a.list_id = items.list_id
      AND a.level >= 'edit'
      AND (NOT a.is_sensitive OR authz.step_up_ok())
      AND (a.item_scope = 'all' OR items.created_by = authz.uid() OR authz.is_assigned(items.id))
  ));

CREATE POLICY assignees_select ON app.item_assignees FOR SELECT TO cerebro_app
  USING (authz.item_level(item_id) >= 'view');
CREATE POLICY assignees_insert ON app.item_assignees FOR INSERT TO cerebro_app
  WITH CHECK (authz.can_assign(item_id));
CREATE POLICY assignees_delete ON app.item_assignees FOR DELETE TO cerebro_app
  USING (authz.can_assign(item_id));

-- Alerts and the audit trail.
CREATE POLICY alerts_select ON app.security_alerts FOR SELECT TO cerebro_app
  USING (authz.is_owner());
CREATE POLICY alerts_update ON app.security_alerts FOR UPDATE TO cerebro_app
  USING (authz.is_owner()) WITH CHECK (authz.is_owner());

CREATE POLICY audit_select ON audit.log FOR SELECT TO cerebro_app
  USING (authz.has_capability('audit.view'));

GRANT USAGE ON SCHEMA app, authz, auth, audit TO cerebro_app;

GRANT SELECT ON app.instance_settings TO cerebro_app;
GRANT UPDATE (instance_name, session_idle_minutes, session_absolute_hours, step_up_minutes)
  ON app.instance_settings TO cerebro_app;

GRANT SELECT ON app.users TO cerebro_app;
GRANT INSERT (id, email, name, role) ON app.users TO cerebro_app;
GRANT UPDATE (name, role, status, email) ON app.users TO cerebro_app;

GRANT SELECT, DELETE ON app.user_capabilities TO cerebro_app;
GRANT INSERT (user_id, capability) ON app.user_capabilities TO cerebro_app;

GRANT SELECT, DELETE ON app.access_grants TO cerebro_app;
GRANT INSERT (id, user_id, space_id, folder_id, list_id, level, item_scope) ON app.access_grants TO cerebro_app;
GRANT UPDATE (level, item_scope) ON app.access_grants TO cerebro_app;

GRANT SELECT ON app.spaces, app.folders, app.lists, app.items, app.item_assignees TO cerebro_app;
GRANT INSERT (id, name, position) ON app.spaces TO cerebro_app;
GRANT UPDATE (name, position, is_archived) ON app.spaces TO cerebro_app;
GRANT INSERT (id, space_id, name, position) ON app.folders TO cerebro_app;
GRANT UPDATE (name, position, is_archived, space_id) ON app.folders TO cerebro_app;
GRANT INSERT (id, space_id, folder_id, name, is_sensitive, position) ON app.lists TO cerebro_app;
GRANT UPDATE (name, position, is_archived, is_sensitive, space_id, folder_id) ON app.lists TO cerebro_app;
GRANT INSERT (id, list_id, title, description, created_by) ON app.items TO cerebro_app;
GRANT UPDATE (title, description, list_id) ON app.items TO cerebro_app;
GRANT INSERT (item_id, user_id) ON app.item_assignees TO cerebro_app;
GRANT DELETE ON app.item_assignees TO cerebro_app;

GRANT SELECT ON app.security_alerts TO cerebro_app;
GRANT UPDATE (acknowledged_at) ON app.security_alerts TO cerebro_app;

GRANT SELECT ON audit.log TO cerebro_app;

GRANT EXECUTE ON FUNCTION
  authz.begin_request(bytea, inet),
  authz.uid(),
  authz.session_id(),
  authz.step_up_ok(),
  authz.my_role(),
  authz.is_owner(),
  authz.has_capability(text),
  authz.can_manage_user(uuid),
  authz.scope_access(uuid, uuid, uuid),
  authz.space_level(uuid),
  authz.folder_level(uuid),
  authz.list_level(uuid),
  authz.my_list_access(),
  authz.can_see_space(uuid),
  authz.can_see_folder(uuid),
  authz.is_assigned(uuid),
  authz.item_level(uuid),
  authz.can_assign(uuid),
  authz.can_grant(uuid, uuid, uuid, uuid, app.item_scope),
  audit.record(text, text, text, jsonb),
  audit.verify_chain(),
  auth.my_sessions(),
  auth.list_devices(boolean),
  auth.decide_device(uuid, text),
  auth.revoke_session(uuid),
  auth.revoke_user_sessions(uuid),
  auth.create_invite(uuid, bytea, text)
TO cerebro_app;

-- ---------------------------------------------------------------------------
-- cerebro_auth: the login flow
--
-- Full access to credential tables, nothing on business data. On app.users it
-- can read (to find the account), create the very first owner and activate an
-- invited account; the guard trigger rejects anything else.
-- ---------------------------------------------------------------------------

CREATE POLICY auth_all ON auth.credentials      FOR ALL TO cerebro_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_all ON auth.totp             FOR ALL TO cerebro_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_all ON auth.recovery_codes   FOR ALL TO cerebro_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_all ON auth.devices          FOR ALL TO cerebro_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_all ON auth.sessions         FOR ALL TO cerebro_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_all ON auth.login_challenges FOR ALL TO cerebro_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_all ON auth.invites          FOR ALL TO cerebro_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_all ON auth.throttle         FOR ALL TO cerebro_auth USING (true) WITH CHECK (true);

CREATE POLICY auth_users_select ON app.users FOR SELECT TO cerebro_auth USING (true);
CREATE POLICY auth_users_insert ON app.users FOR INSERT TO cerebro_auth WITH CHECK (true);
CREATE POLICY auth_users_update ON app.users FOR UPDATE TO cerebro_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_settings_select ON app.instance_settings FOR SELECT TO cerebro_auth USING (true);
CREATE POLICY auth_settings_update ON app.instance_settings FOR UPDATE TO cerebro_auth
  USING (setup_completed_at IS NULL) WITH CHECK (true);

GRANT USAGE ON SCHEMA app, auth, audit TO cerebro_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  auth.credentials, auth.totp, auth.recovery_codes, auth.devices, auth.sessions,
  auth.login_challenges, auth.invites, auth.throttle
TO cerebro_auth;
GRANT SELECT ON app.users, app.instance_settings TO cerebro_auth;
GRANT INSERT (id, email, name, role, status) ON app.users TO cerebro_auth;
GRANT UPDATE (status) ON app.users TO cerebro_auth;
GRANT UPDATE (instance_name, setup_completed_at) ON app.instance_settings TO cerebro_auth;

GRANT EXECUTE ON FUNCTION
  audit.record_as(uuid, inet, text, text, text, jsonb),
  app.raise_alert(text, text, uuid, jsonb)
TO cerebro_auth;
