-- The levels of thinking each AI agent's model takes, kept by the Workspace (scope "workspace" in
-- src/migrations.ts): a JSON list of 'off', 'low', 'medium' and 'high', those the model answered its test
-- question at when an administrator gave the agent that model, as nothing else says reliably which levels
-- a model takes, or null for an agent given its model before Ember asked at each, which is asked at any.
-- An agent asks its model at the level it's set to when the model takes it, and else at the nearest it
-- takes, or at none. The levels of the models people can pick for @ember are in the account's settings.
ALTER TABLE agents ADD COLUMN thinking_levels TEXT;
