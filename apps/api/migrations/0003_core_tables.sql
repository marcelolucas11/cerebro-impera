-- Core business tables. Identifiers are random UUIDs so they cannot be guessed
-- or enumerated.

CREATE TABLE app.instance_settings (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  instance_name          text NOT NULL DEFAULT 'Cérebro' CHECK (length(instance_name) BETWEEN 1 AND 80),
  setup_completed_at     timestamptz,
  session_idle_minutes   integer NOT NULL DEFAULT 720  CHECK (session_idle_minutes BETWEEN 5 AND 43200),
  session_absolute_hours integer NOT NULL DEFAULT 336  CHECK (session_absolute_hours BETWEEN 1 AND 2160),
  step_up_minutes        integer NOT NULL DEFAULT 15   CHECK (step_up_minutes BETWEEN 1 AND 120),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app.instance_settings DEFAULT VALUES;

CREATE TABLE app.users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  role       app.user_role NOT NULL,
  status     app.user_status NOT NULL DEFAULT 'invited',
  created_by uuid REFERENCES app.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON app.users (email);

CREATE TABLE app.user_capabilities (
  user_id    uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability IN (
    'users.manage', 'devices.approve', 'audit.view', 'export', 'bulk_delete',
    'automations.manage', 'secret_fields.reveal', 'system.config'
  )),
  granted_by uuid NOT NULL REFERENCES app.users (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capability)
);

CREATE TABLE app.spaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  position    integer NOT NULL DEFAULT 0,
  is_archived boolean NOT NULL DEFAULT false,
  created_by  uuid NOT NULL REFERENCES app.users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.folders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id    uuid NOT NULL REFERENCES app.spaces (id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  position    integer NOT NULL DEFAULT 0,
  is_archived boolean NOT NULL DEFAULT false,
  created_by  uuid NOT NULL REFERENCES app.users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, space_id)
);
CREATE INDEX folders_space_idx ON app.folders (space_id);

CREATE TABLE app.lists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id     uuid NOT NULL REFERENCES app.spaces (id),
  folder_id    uuid,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- Sensitive lists need a recent second factor to open, are watermarked and
  -- are never cached for offline use.
  is_sensitive boolean NOT NULL DEFAULT false,
  position     integer NOT NULL DEFAULT 0,
  is_archived  boolean NOT NULL DEFAULT false,
  created_by   uuid NOT NULL REFERENCES app.users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- A list's folder must live in the list's own space.
  FOREIGN KEY (folder_id, space_id) REFERENCES app.folders (id, space_id)
);
CREATE INDEX lists_space_idx ON app.lists (space_id);
CREATE INDEX lists_folder_idx ON app.lists (folder_id);

CREATE TABLE app.items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id     uuid NOT NULL REFERENCES app.lists (id),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 50000),
  created_by  uuid NOT NULL REFERENCES app.users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_list_idx ON app.items (list_id);
CREATE INDEX items_created_by_idx ON app.items (created_by);

CREATE TABLE app.item_assignees (
  item_id     uuid NOT NULL REFERENCES app.items (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app.users (id),
  assigned_by uuid NOT NULL REFERENCES app.users (id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, user_id)
);
CREATE INDEX item_assignees_user_idx ON app.item_assignees (user_id);

-- One grant per person per scope. Exactly one of the three scope columns is
-- set; real foreign keys keep grants from outliving what they point to.
CREATE TABLE app.access_grants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  space_id   uuid REFERENCES app.spaces (id) ON DELETE CASCADE,
  folder_id  uuid REFERENCES app.folders (id) ON DELETE CASCADE,
  list_id    uuid REFERENCES app.lists (id) ON DELETE CASCADE,
  level      app.access_level NOT NULL,
  item_scope app.item_scope NOT NULL,
  granted_by uuid NOT NULL REFERENCES app.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(space_id, folder_id, list_id) = 1)
);
CREATE UNIQUE INDEX access_grants_space_key ON app.access_grants (user_id, space_id) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX access_grants_folder_key ON app.access_grants (user_id, folder_id) WHERE folder_id IS NOT NULL;
CREATE UNIQUE INDEX access_grants_list_key ON app.access_grants (user_id, list_id) WHERE list_id IS NOT NULL;
CREATE INDEX access_grants_space_idx ON app.access_grants (space_id) WHERE space_id IS NOT NULL;
CREATE INDEX access_grants_folder_idx ON app.access_grants (folder_id) WHERE folder_id IS NOT NULL;
CREATE INDEX access_grants_list_idx ON app.access_grants (list_id) WHERE list_id IS NOT NULL;

-- Things owners should hear about without having to read the audit trail.
CREATE TABLE app.security_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at              timestamptz NOT NULL DEFAULT now(),
  kind            text NOT NULL CHECK (length(kind) BETWEEN 1 AND 60),
  severity        text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  actor_user_id   uuid REFERENCES app.users (id),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_by uuid REFERENCES app.users (id),
  acknowledged_at timestamptz
);
CREATE INDEX security_alerts_open_idx ON app.security_alerts (at DESC) WHERE acknowledged_at IS NULL;

CREATE FUNCTION app.raise_alert(
  p_kind text, p_severity text, p_actor uuid DEFAULT NULL, p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO app.security_alerts (kind, severity, actor_user_id, metadata)
  VALUES (p_kind, p_severity, p_actor, coalesce(p_metadata, '{}'::jsonb))
  RETURNING id
$$;

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER touch BEFORE UPDATE ON app.instance_settings FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch BEFORE UPDATE ON app.users FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch BEFORE UPDATE ON app.spaces FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch BEFORE UPDATE ON app.folders FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch BEFORE UPDATE ON app.lists FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch BEFORE UPDATE ON app.items FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch BEFORE UPDATE ON app.access_grants FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
