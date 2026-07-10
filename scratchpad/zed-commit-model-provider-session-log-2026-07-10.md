# Zed commit-message model provider session log

- 2026-07-10 14:22 PKT — Inspected Zed 1.10.1 settings and logs for the commit-message provider configuration. Existing settings select OpenRouter with `openai/gpt-oss-20b`; authentication state still requires confirmation in Zed.
- 2026-07-10 14:25 PKT — Verified in Zed's LLM Providers screen that GitHub Copilot Chat is authorized. Anthropic and DeepSeek have masked key fields. The configured OpenRouter model is not usable until Zed has an OpenRouter key available through the local keychain or `OPENROUTER_API_KEY`.
- 2026-07-10 14:34 PKT — Verified the ChatGPT Subscription provider is signed in. Updated Zed's commit-message model to `openai-subscribed` / `gpt-5.6-luna` with thinking enabled at low effort, then generated a commit message successfully from the Git panel.
