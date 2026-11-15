-- Foundation: database roles, schemas, enums and the request context.
--
-- Security model in one paragraph: the API never connects as the owner of
-- these objects. It uses two unprivileged roles. `cerebro_app` serves
-- authenticated requests and can only see rows that row-level security lets
-- the *current person* see. `cerebro_auth` serves the login flow and can only
-- touch credential tables. Neither can bypass row-level security.

-- Functions are executable by everyone unless stated otherwise; turn that off
-- so that every function needs an explicit GRANT.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $$
BEGIN
  -- Passwords are never set here: the migrator applies them from the instance
  -- secrets, so no credential ever lives in the repository.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerebro_app') THEN
    CREATE ROLE cerebro_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerebro_auth') THEN
    CREATE ROLE cerebro_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA app;    -- business data
CREATE SCHEMA authz;  -- who-can-see-what decisions
CREATE SCHEMA auth;   -- credentials, devices, sessions
CREATE SCHEMA audit;  -- append-only trail

-- Enum order is meaningful: comparisons such as `level >= 'edit'` rely on it.
CREATE TYPE app.user_role AS ENUM ('employee', 'manager', 'admin', 'owner');
CREATE TYPE app.user_status AS ENUM ('invited', 'active', 'suspended');
CREATE TYPE app.access_level AS ENUM ('none', 'view', 'comment', 'edit', 'manage');
CREATE TYPE app.item_scope AS ENUM ('assigned', 'all');

-- ---------------------------------------------------------------------------
-- Request context
--
-- Row-level security needs to know who is asking. A session variable would be
-- the usual answer, but the application role can set any session variable, so
-- a single SQL injection would let an attacker claim to be an owner. Instead,
-- identity is bound here, by `authz.begin_request`, which only succeeds for a
-- valid session token. The application role cannot write this table, so the
-- database never has to take the API's word for who the user is.
-- ---------------------------------------------------------------------------
CREATE UNLOGGED TABLE authz.request_ctx (
  pid         integer PRIMARY KEY,
  xact_start  timestamptz NOT NULL,
  user_id     uuid NOT NULL,
  session_id  uuid NOT NULL,
  ip          inet,
  step_up     boolean NOT NULL
);

-- A context row is only valid for the transaction that created it: a later
-- transaction on the same connection has a different start timestamp.
CREATE FUNCTION authz.uid() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.user_id FROM authz.request_ctx c
  WHERE c.pid = pg_backend_pid() AND c.xact_start = transaction_timestamp()
$$;

CREATE FUNCTION authz.session_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.session_id FROM authz.request_ctx c
  WHERE c.pid = pg_backend_pid() AND c.xact_start = transaction_timestamp()
$$;

CREATE FUNCTION authz.client_ip() RETURNS inet
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.ip FROM authz.request_ctx c
  WHERE c.pid = pg_backend_pid() AND c.xact_start = transaction_timestamp()
$$;

-- True when the person re-entered their second factor recently. Critical
-- actions and sensitive lists require it, which limits what a hijacked
-- session can do.
CREATE FUNCTION authz.step_up_ok() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((
    SELECT c.step_up FROM authz.request_ctx c
    WHERE c.pid = pg_backend_pid() AND c.xact_start = transaction_timestamp()
  ), false)
$$;

CREATE FUNCTION authz.require_step_up() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF NOT authz.step_up_ok() THEN
    RAISE EXCEPTION 'second factor confirmation required' USING ERRCODE = 'CB002';
  END IF;
END
$$;

-- Error codes used across the schema:
--   CB001  forbidden
--   CB002  step-up (recent second factor) required
--   CB003  invalid state / rule violation
