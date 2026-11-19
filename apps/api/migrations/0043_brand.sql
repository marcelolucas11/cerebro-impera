-- =============================================================================
-- White label (Fase 10): the installation's brand color and logo, beside the
-- name it already had. Only whoever may configure the system changes them,
-- with the second factor confirmed. The brand is public on purpose: the
-- sign-in page shows it to anyone, before a password.
--
-- The logo is kept as three PNG files the browser drew itself (never the file
-- the person picked); the API checks each one byte by byte before it gets here.
-- =============================================================================

ALTER TABLE app.instance_settings
  ADD COLUMN brand_color text CHECK (brand_color ~ '^#[0-9a-f]{6}$');
GRANT UPDATE (brand_color) ON app.instance_settings TO cerebro_app;

CREATE TABLE app.brand_images (
  kind       text PRIMARY KEY CHECK (kind IN ('icon-192', 'icon-512', 'maskable-512')),
  png        bytea NOT NULL CHECK (
               octet_length(png) BETWEEN 67 AND 204800
               AND substring(png FROM 1 FOR 8) = '\x89504e470d0a1a0a'::bytea),
  digest     text GENERATED ALWAYS AS (encode(sha256(png), 'hex')) STORED,
  updated_by uuid NOT NULL REFERENCES app.users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Who put the logo there, the database says.
CREATE TRIGGER stamp BEFORE INSERT ON app.brand_images
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('updated_by');

-- A logo is the three sizes together, or none: a half-replaced logo would show
-- one company in the menu and another on the phone's home screen.
CREATE FUNCTION app.brand_images_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM app.brand_images;
  IF v_count NOT IN (0, 3) THEN
    RAISE EXCEPTION 'the logo needs all its sizes' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER complete AFTER INSERT OR DELETE ON app.brand_images
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.brand_images_complete();

-- On the record: which size changed and its digest, never the image itself.
CREATE FUNCTION audit.on_brand_image_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_kind   text;
  v_digest text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_kind := OLD.kind;
    v_digest := OLD.digest;
  ELSE
    v_kind := NEW.kind;
    v_digest := NEW.digest;
  END IF;
  PERFORM audit.append_entry(authz.uid(), authz.session_id(), authz.client_ip(),
                             'brand_images.' || lower(TG_OP), 'brand_images', v_kind,
                             jsonb_build_object('digest', v_digest));
  RETURN NULL;
END
$$;
CREATE TRIGGER audit AFTER INSERT OR DELETE ON app.brand_images
  FOR EACH ROW EXECUTE FUNCTION audit.on_brand_image_change();

ALTER TABLE app.brand_images ENABLE ROW LEVEL SECURITY;
-- Public: the sign-in service serves it to anyone, and the app reads it too.
CREATE POLICY brand_images_read ON app.brand_images FOR SELECT TO cerebro_auth
  USING (true);
CREATE POLICY brand_images_select ON app.brand_images FOR SELECT TO cerebro_app
  USING (true);
CREATE POLICY brand_images_insert ON app.brand_images FOR INSERT TO cerebro_app
  WITH CHECK (authz.has_capability('system.config') AND authz.step_up_ok());
CREATE POLICY brand_images_delete ON app.brand_images FOR DELETE TO cerebro_app
  USING (authz.has_capability('system.config') AND authz.step_up_ok());

GRANT SELECT ON app.brand_images TO cerebro_auth;
GRANT SELECT, DELETE ON app.brand_images TO cerebro_app;
GRANT INSERT (kind, png) ON app.brand_images TO cerebro_app;
