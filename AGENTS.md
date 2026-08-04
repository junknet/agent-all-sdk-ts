# Repository Guidelines

## Project Structure & Module Organization

This repository contains the **Agent All SDK**, a TypeScript-based gateway adapter for routing agentic model requests (Anthropic, OpenAI, Codex) with unified logging and model remapping.

- `src/`: Main source code.
    - `providers/`: Implementation of various backend providers (Anthropic, Codex, Antigravity, etc.).
    - `index.ts`: Core facade for provider selection and model remapping.
    - `server.ts`: Entry point for the Bun-based HTTP gateway server.
    - `types.ts`: Common type definitions.
- `test/`: End-to-end and unit tests using Bun's test runner.
- `PROTOCOL_REFERENCE.md`: Detailed documentation on the wire protocols and event structures.

## Build, Test, and Development Commands

The project uses **Bun** as its primary runtime, package manager, and test runner.

- `bun install`: Install project dependencies.
- `bun run test`: Run this repository's tests in the `test/` directory.
- `bun run src/server.ts`: Start the gateway server locally.

## Coding Style & Naming Conventions

Follow the "coder-style" principles to minimize inference distance for both humans and AI agents.

- **Naming**: Use `PascalCase` for types/interfaces and `lowerCamelCase` for functions and variables. Avoid abbreviations (e.g., use `executeQuery` instead of `doQ`).
- **Files**: Use `snake_case` for filenames. Each file should have a single clear responsibility.
- **Strictness**: Always use TypeScript with explicit types for public exports.
- **Fail Fast**: Validate inputs early and throw descriptive errors with context.

## Testing Guidelines

- **Framework**: Use `bun:test` for all testing.
- **Conventions**: Test files must end in `.test.ts`.
- **E2E Tests**: Use `e2e_matrix.test.ts` to verify provider compatibility across the request/response matrix.
- **Mocking**: Minimize mocks; prefer real path validation or lockstep reference implementations where possible.

## Commit & Pull Request Guidelines

- **Atomic Commits**: Keep commits small and focused on a single logical change.
- **Messages**: Use descriptive, imperative-mood messages (e.g., "Add Antigravity provider support").
- **PRs**: Ensure `bun run test` passes before opening a pull request. For real agent changes, run the gate documented in README's “运行 / 验收” section. Include a description of the change and relevant test evidence.
