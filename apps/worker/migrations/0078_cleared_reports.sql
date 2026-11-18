-- The reports of someone who deletes their account, kept by the Workspace (scope "workspace" in
-- src/migrations.ts), keep nothing they wrote, nor their name or bio, once deleting it clears them as
-- CLEAR_REPORTS_OF in src/workspace-store.ts does: a message's text, the people it mentions, its file and
-- cards go, and they're named as deleted accounts are. Who reported it, why, when, and how it was handled
-- stay. Accounts deleted before then, as 0.5 beta 8 deleted them, left the reports of them as they were,
-- so this clears those the same way.
UPDATE reports SET subject = CASE WHEN message_id IS NULL
    THEN json_set(subject, '$.person.name', 'Deleted person', '$.person.bio', NULL, '$.person.accountDeleted', json('true'))
    ELSE json_set(json_remove(subject, '$.message.attachment', '$.message.cards'), '$.message.creator.name', 'Deleted person', '$.message.body', '',
      '$.message.plainText', '', '$.message.mentions', json('[]'), '$.message.accountDeleted', json('true'))
  END
  WHERE subject_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
