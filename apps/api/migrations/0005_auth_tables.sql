-- Credentials, second factors, devices and sessions.
--
-- These tables are out of reach of `cerebro_app` (the role that serves normal
-- requests), so a flaw in a data endpoint cannot read password hashes or mint
-- sessions. Secrets handed out to browsers (session, device, invite and
-- challenge tokens) are stored only as SHA-256 digests.

CREATE TYPE auth.device_status AS ENUM ('pending', 'approved', 'rejected', 'revoked');

CREATE TABLE auth.credentials (
  user_id             uuid PRIMARY KEY REFERENCES app.users (id) ON DELETE CASCADE,
  password_hash       text NOT NULL,           -- argon2id, PHC string
  password_changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth.totp (
  user_id      uuid PRIMARY KEY REFERENCES app.users (id) ON DELETE CASCADE,
  secret_enc   bytea NOT NULL,                 -- encrypted with the instance key
  confirmed_at timestamptz,
  last_step    bigint NOT NULL DEFAULT 0,      -- replay protection
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth.recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

-- A device is one browser/app installation for one person. It must be
-- approved by someone with authority before any session can exist on it.
CREATE TABLE auth.devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL,
  user_agent   text NOT NULL DEFAULT '' CHECK (length(user_agent) <= 400),
  status       auth.device_status NOT NULL DEFAULT 'pending',
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_ip   inet,
  decided_by   uuid REFERENCES app.users (id),
  decided_at   timestamptz,
  last_seen_at timestamptz,
  -- The same browser may be used by more than one person; each gets their
  -- own device record and their own approval.
  UNIQUE (token_hash, user_id)
);
CREATE INDEX devices_user_idx ON auth.devices (user_id);
CREATE INDEX devices_pending_idx ON auth.devices (created_at) WHERE status = 'pending';

CREATE TABLE auth.sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  device_id      uuid NOT NULL REFERENCES auth.devices (id) ON DELETE CASCADE,
  token_hash     bytea NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text,
  step_up_at     timestamptz,
  ip             inet,
  user_agent     text NOT NULL DEFAULT '' CHECK (length(user_agent) <= 400)
);
CREATE INDEX sessions_user_idx ON auth.sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_device_idx ON auth.sessions (device_id) WHERE revoked_at IS NULL;

-- Short-lived proof that the password step succeeded; required for the
-- second-factor step.
CREATE TABLE auth.login_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  bytea NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  ip          inet
);

-- One-time links for joining the instance or resetting access.
CREATE TABLE auth.invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  user_id    uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('invite', 'reset')),
  created_by uuid NOT NULL REFERENCES app.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX invites_user_idx ON auth.invites (user_id) WHERE used_at IS NULL;

-- Failed-attempt counters for progressive lockout.
CREATE TABLE auth.throttle (
  key              text PRIMARY KEY CHECK (length(key) <= 200),
  failures         integer NOT NULL DEFAULT 0,
  first_failure_at timestamptz NOT NULL DEFAULT now(),
  last_failure_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz
);
