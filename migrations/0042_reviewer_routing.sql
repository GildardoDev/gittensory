-- Advisory reviewer routing (#540). One tunable `reviewer_routing_mode`: off (default) | advisory. When
-- 'advisory', gittensory reads the repo's CODEOWNERS for a PR's changed files and suggests reviewers —
-- ranked and de-weighted by each owner's current load — in the maintainer-private PR panel only. It NEVER
-- gates (never blocks). A TEXT column (not an enum) so a later follow-up can add an `auto_request` value
-- that actually requests reviewers on GitHub without a schema migration. Default 'off' preserves existing
-- behavior for every current repo.
ALTER TABLE repository_settings ADD COLUMN reviewer_routing_mode TEXT NOT NULL DEFAULT 'off';
