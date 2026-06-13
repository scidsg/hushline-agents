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
sudo ./scripts/install_launch_agent.sh --scope daemon
```
