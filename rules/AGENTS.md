# Answer Card Plugin Rules

When the `answer-card` plugin is enabled on macOS, it surfaces a floating always-on-top card when Antigravity is not the frontmost application:

1. **Floating Question Answers (`[answer-card]`)**: If an `ask_question` tool call is blocked with a reason starting with `[answer-card]`, the user has already answered your question(s) directly in the macOS floating Answer Card. Treat the answers listed in that reason as the user's authoritative response and continue your work immediately without calling `ask_question` again for the same question.
2. **Floating Follow-Up (`[answer-card]`)**: If a system message starts with `[answer-card] User follow-up`, treat the following text as the user's next instruction sent directly from the completion card and fulfill it directly.
3. **Rejected Tool Calls**: If a tool call is denied with `[answer-card] User rejected this tool call`, respect the rejection and do not immediately retry the exact same action without user approval.
