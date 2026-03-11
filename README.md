# ForgeCode

ForgeCode is a professional terminal AI coding assistant foundation for working with codebases through natural language. It is designed for long-term maintainability: providers are swappable, tools are runtime-controlled, and the action protocol is intentionally small and safe.

## Features

- OpenAI-compatible provider layer for OpenAI, OpenRouter, and similar APIs
- Strict runtime-owned action protocol: `ACTION`, `ASK_USER`, `FINAL_MESSAGE`
- Modular tool system with validation and permission gates
- Workspace-scoped file access
- Interactive terminal experience with streaming model output
- Publishable npm CLI package structure

## Installation

```bash
npm install
npm run build
```

To use the local CLI after building:

```bash
npm start
```

For package-style execution after publishing:

```bash
forgecode
```

## Usage

Start an interactive session in a project directory:

```bash
forgecode
```

Or during local development:

```bash
npm start
```

Available command:

```bash
forgecode config
```

This opens an interactive configuration flow and stores credentials in `~/.forgecode/config.json`.

## Configuration

ForgeCode stores its configuration in:

```text
~/.forgecode/config.json
```

Current fields:

- `provider`
- `api_key`
- `base_url`
- `model`

The initial implementation uses an OpenAI-compatible `/chat/completions` API, which works with providers that expose that interface.

## Architecture

Project layout:

```text
src/
  cli/
  agent/
  runtime/
  tools/
  providers/
  context/
  ui/
  config/
  utils/
bin/
  forgecode
```

Design principles:

- The model never executes tools directly.
- The runtime parses text directives and validates every action.
- Tools are isolated, typed, and schema-validated.
- Sensitive actions like file writes and shell commands require confirmation.
- File system access is limited to the current workspace.

## Minimal Tooling

Initial tools:

- `read_file`
- `write_file`
- `list_files`
- `run_command`

This repository intentionally stops at the foundation layer. It does not yet include advanced automation like git workflows, test orchestration, large-scale refactors, or autonomous planning.

## Roadmap

- Richer terminal UI with structured panels and status views
- Additional provider adapters
- Better context selection and token budgeting
- More tools with fine-grained permissions
- Session persistence and resumability
- Test coverage and provider mocks

## Development

Build:

```bash
npm run build
```

Run:

```bash
npm start
```

Local development:

```bash
npm run dev
```
