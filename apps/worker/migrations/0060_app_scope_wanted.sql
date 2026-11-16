-- What an app's server has asked for that Ember's sign-in to it doesn't allow, as the OAuth scopes
-- it named when it refused a call or a read for want of them, each once, between spaces. The next
-- sign-in asks for them with what the last one had, and clears this.
ALTER TABLE apps ADD COLUMN scope_wanted TEXT;
