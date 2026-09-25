# Hush Line Social Agent

This package owns Hush Line social automation: launchd wrappers, agent shell
entrypoints, Node planners and publishers, templates, assets, tests, and deploy
templates.

`hushline-social` is only the runtime archive/env checkout. Set
`HUSHLINE_SOCIAL_REPO_DIR` if that checkout is not a sibling of `hushline-agents`.

## Schedule

- Whistleblower news post agent: daily at 04:00, then publishes at a random target
  between 04:00 and 09:00.
- Hush Line feature post agent: daily at 04:00, then publishes at a random target
  between 04:00 and 09:00.
- Hush Line verified-user post agent: Monday through Friday at 04:00, selects one
  weekday per week, then publishes at a random target between 04:00 and 09:00.

Manual runs do not apply randomized timing or weekly weekday selection unless
`HUSHLINE_SOCIAL_RANDOMIZE_POST_WINDOW=1` is set.

## Commands

```bash
npm test
npm run check:launchd
./scripts/run_whistleblower_news_post_agent_launchd.sh
./scripts/run_hushline_feature_post_agent_launchd.sh
./scripts/run_hushline_verified_user_post_agent_launchd.sh
npm run publish:bluesky:daily -- --dry-run
sudo ./scripts/install_launch_agent.sh --scope daemon
```

## Verified-user copy generation

The copy generator requests a structured JSON response from Codex in read-only
mode. The runner validates the response and saves `copy.json` itself, so success
does not depend on the model writing a file. Invalid or missing responses are
retried once before using the existing factual fallback. Response scratch files
are removed after each attempt; raw Codex transcripts are not printed on failure.

Archive commits must use an email associated with the signing bot’s GitHub
account (its GitHub-provided noreply address is suitable), and the signing public
key must be registered to that account. Check GitHub’s verification result after
pushing; a local SSH signature alone does not establish GitHub attribution.
