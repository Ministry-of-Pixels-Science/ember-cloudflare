-- Who Ember is to an app's sign-in when the service doesn't find that out by itself: the client ID an
-- administrator got by registering Ember there, which the app's page shows, and what the service knows
-- that client by, its secret among it, if it has one, as JSON sealed under SESSION_SECRET for that app
-- alone. Both are null for an app Ember signed in to as a client the service came to know by itself,
-- and for one nobody signed in to. They stay once the sign-in has ended, so that signing in again
-- doesn't ask for them again.
ALTER TABLE apps ADD COLUMN sign_in_client_id TEXT;
ALTER TABLE apps ADD COLUMN sign_in_client TEXT;
