-- =============================================================================
-- Each person's start page (Fase 6): the lists whose numbers they want to see
-- first, in their order. A person keeps only their own, and pins only a list
-- they can open; a list they lose stops showing, because its numbers are read
-- with their access every time.
-- =============================================================================

CREATE TABLE app.home_pins (
  user_id  uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  list_id  uuid NOT NULL REFERENCES app.lists (id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 11),
  PRIMARY KEY (user_id, list_id),
  UNIQUE (user_id, position) DEFERRABLE INITIALLY DEFERRED
);

-- Whose pin it is, the database says.
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON app.home_pins
  FOR EACH ROW EXECUTE FUNCTION app.stamp_actor('user_id');

ALTER TABLE app.home_pins ENABLE ROW LEVEL SECURITY;
CREATE POLICY home_pins_select ON app.home_pins FOR SELECT TO cerebro_app
  USING (user_id = authz.uid());
CREATE POLICY home_pins_insert ON app.home_pins FOR INSERT TO cerebro_app
  WITH CHECK (user_id = authz.uid() AND authz.list_level(list_id) >= 'view');
CREATE POLICY home_pins_delete ON app.home_pins FOR DELETE TO cerebro_app
  USING (user_id = authz.uid());

GRANT SELECT, DELETE ON app.home_pins TO cerebro_app;
GRANT INSERT (list_id, position) ON app.home_pins TO cerebro_app;
