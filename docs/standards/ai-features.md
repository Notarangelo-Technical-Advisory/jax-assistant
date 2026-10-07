# AI Features (Claude API)

These rules apply to any app feature that calls the Claude API, such as Solomon's counselor, NTA's status reports and Maisie's chat.

## Where the call runs

- Call the Claude API only from a Cloud Function. The API key never reaches the browser.
- The key arrives as `ANTHROPIC_API_KEY` through `functions/.env`.

## Model

- Define the model ID once, as a constant in the function code. Do not repeat it in several places.
- Use the current Sonnet model unless the app's `AGENTS.md` gives a reason to use a different one.
- When you change the model, run the feature's tests and generate one real response before you merge. A new model can change the shape of the response.

## Reading the response

- Find the text block by `type === 'text'`. Never read `content[0]`. Current models can return a thinking block first, and NTA's status reports broke when this happened.
- Give `max_tokens` enough room for thinking as well as for the answer, so that the answer is not cut short.
- Where you need JSON, use structured outputs (`output_config.format` with a JSON schema), not instructions in the prompt.
- Check `stop_reason`. Handle `refusal` and `max_tokens` explicitly. Do not treat them as a normal answer.

## Time limits

- A long AI call needs a long function timeout. Use `timeoutSeconds: 300` and `memory: '512MiB'` for calls that can take more than 30 seconds.
- Wrap the call in an `AbortController` that stops it before the function's own timeout, for example at 240 seconds. Return a clear `deadline-exceeded` error to the user.

## Tests

- Replace the Claude API with a fake in tests. Test how the function handles a normal answer, a refusal, a cut-off answer and a timeout.
