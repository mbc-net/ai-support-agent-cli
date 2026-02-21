# Contributing to AI Support Agent CLI

Thank you for your interest in contributing! This guide will help you get started.

## How to Contribute

We welcome contributions of all kinds: bug reports, feature requests, documentation improvements, and code changes.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/mbc-net/ai-support-agent-client.git
cd ai-support-agent-client

# Install dependencies
npm install

# Run in development mode
npm run dev -- start --verbose

# Run tests
npm test
```

### Prerequisites

- Node.js >= 20.0.0
- npm

## Making Changes

1. **Fork** the repository on GitHub
2. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes** and add tests
4. **Run tests** to ensure everything passes:
   ```bash
   npm test
   ```
5. **Build** to verify compilation:
   ```bash
   npm run build
   ```
6. **Submit a Pull Request**

## Coding Standards

- **TypeScript strict mode** is enabled — all code must pass strict type checking
- **Tests are required** for all new features and bug fixes
  - Coverage thresholds: **95% statements**, **90% branches**
- **No lint errors** — ensure your code passes all linting rules
- Follow existing code patterns and conventions in the repository

## Commit Messages

We follow a conventional commit format:

```
<type>: <subject>
```

| Type       | Description                |
|------------|----------------------------|
| `feat`     | New feature                |
| `fix`      | Bug fix                    |
| `docs`     | Documentation only         |
| `test`     | Adding or updating tests   |
| `chore`    | Maintenance tasks          |
| `refactor` | Code refactoring           |

Examples:
- `feat: add timeout configuration option`
- `fix: handle network errors in auth flow`
- `docs: update installation instructions`

## Pull Request Guidelines

- **Describe your changes** — explain what and why, not just how
- **Add or update tests** for any changed functionality
- **Ensure CI passes** — all checks must be green before review
- **Keep PRs focused** — one feature or fix per PR
- **Link related issues** if applicable

## Reporting Issues

When reporting a bug, please include:

- **Steps to reproduce** the issue
- **Expected behavior** vs **actual behavior**
- **Environment information**:
  - OS and version
  - Node.js version (`node --version`)
  - Package version (`ai-support-agent --version`)
- **Error messages** or logs (if applicable)

Use [GitHub Issues](https://github.com/mbc-net/ai-support-agent-client/issues) to report bugs or request features.

## License

By submitting a pull request, you agree that your contribution will be licensed under the [MIT License](./LICENSE).
